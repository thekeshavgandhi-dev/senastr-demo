import type { Provider, ProviderChatParams, ModelSpec, ProviderEvent } from "../types";
import { toAnthropicMessages } from "../messages";
import { parseSseLines, safeReadText, parseToolArgs } from "./openai";
import { postToModel } from "./resilient";
import { anthropicThinkingBudgetFor, type Usage } from "@senastr/shared";

/**
 * Anthropic Messages API streaming client (bare HTTP/SSE, no SDK).
 */
export class AnthropicProvider implements Provider {
  constructor(private readonly spec: ModelSpec) {}

  async *streamChat(params: ProviderChatParams): AsyncIterable<ProviderEvent> {
    const base = (this.spec.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const maxTokens = params.maxTokens ?? 8192;
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: maxTokens,
      messages: toAnthropicMessages(params.messages),
    };
    if (typeof params.temperature === "number" && !params.thinkingLevel) {
      body.temperature = params.temperature;
    }
    // Extended thinking: a token budget, and no temperature (the API rejects
    // sampling parameters alongside thinking).
    const budget = params.thinkingLevel ? anthropicThinkingBudgetFor(params.thinkingLevel, maxTokens) : null;
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
    if (params.system) body.system = params.system;
    if (params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    const res = await postToModel({
      spec: this.spec,
      signal: params.signal,
      build: (apiKey) => ({
        url: `${root}/messages`,
        headers: {
          ...(this.spec.headers ?? {}),
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        body: JSON.stringify(body),
      }),
    });

    if (!res.ok || !res.body) {
      const detail = await safeReadText(res);
      throw new Error(`model request failed (HTTP ${res.status}): ${detail.slice(0, 400)}`);
    }

    let usage: Usage | undefined;
    let finishReason: string | undefined;
    interface Block {
      type: string;
      id?: string;
      name?: string;
      text: string;
      inputJson: string;
    }
    const blocks = new Map<number, Block>();

    for await (const data of parseSseLines(res.body)) {
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event?.type) {
        case "message_start": {
          const u = event?.message?.usage;
          if (u) usage = { inputTokens: u.input_tokens, outputTokens: 0 };
          break;
        }
        case "content_block_start": {
          const b = event?.content_block;
          blocks.set(event?.index ?? 0, {
            type: typeof b?.type === "string" ? b.type : "text",
            id: typeof b?.id === "string" ? b.id : undefined,
            name: typeof b?.name === "string" ? b.name : undefined,
            text: "",
            inputJson: "",
          });
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(event?.index ?? 0);
          if (!block) break;
          const delta = event?.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            block.text += delta.text;
            yield { kind: "text", delta: delta.text };
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { kind: "reasoning", delta: delta.thinking };
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            block.inputJson += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const index = event?.index ?? 0;
          const block = blocks.get(index);
          if (block && block.type === "tool_use" && block.name) {
            yield {
              kind: "tool-call",
              id: block.id ?? `toolu_${index}`,
              name: block.name,
              arguments: parseToolArgs(block.inputJson),
            };
          }
          break;
        }
        case "message_delta": {
          const u = event?.usage;
          if (u?.output_tokens) {
            usage = { inputTokens: usage?.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + u.output_tokens };
          }
          if (typeof event?.delta?.stop_reason === "string") finishReason = event.delta.stop_reason;
          break;
        }
        default:
          break;
      }
    }

    yield { kind: "done", usage, finishReason };
  }
}
