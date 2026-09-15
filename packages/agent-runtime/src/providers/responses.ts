import type { ChatMessage, Usage } from "@senastr/shared";
import type { ModelSpec, Provider, ProviderChatParams, ProviderEvent } from "../types";
import { parseSseLines, parseToolArgs, safeReadText } from "./openai";
import { reasoningEffortFor } from "@senastr/shared";
import { postToModel } from "./resilient";

/** OpenAI Responses API streaming adapter. Named OpenAI providers use this
 * modern wire format, while compatible gateways can keep Chat Completions. */
export class OpenAIResponsesProvider implements Provider {
  constructor(private readonly spec: ModelSpec) {}

  async *streamChat(params: ProviderChatParams): AsyncIterable<ProviderEvent> {
    const base = (this.spec.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: params.model,
      input: toResponsesInput(params.messages),
      stream: true,
    };
    if (params.system) body.instructions = params.system;
    if (params.maxTokens) body.max_output_tokens = params.maxTokens;
    if (typeof params.temperature === "number" && !params.thinkingLevel) body.temperature = params.temperature;
    const effort = params.thinkingLevel ? reasoningEffortFor(params.thinkingLevel) : null;
    if (effort) body.reasoning = { effort, summary: "auto" };
    if (params.tools.length) {
      body.tools = params.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      }));
    }

    const res = await postToModel({
      spec: this.spec,
      signal: params.signal,
      build: (apiKey) => ({
        url: `${base}/responses`,
        headers: {
          ...(this.spec.headers ?? {}),
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    });
    if (!res.ok || !res.body) {
      const detail = await safeReadText(res);
      throw new Error(`model request failed (HTTP ${res.status}): ${detail.slice(0, 400)}`);
    }

    type PendingCall = { id: string; name: string; args: string };
    const calls = new Map<string, PendingCall>();
    let usage: Usage | undefined;
    let finishReason: string | undefined;

    for await (const data of parseSseLines(res.body)) {
      if (data === "[DONE]") break;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const type = event?.type;
      if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
        yield { kind: "reasoning", delta: event.delta };
      }
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        yield { kind: "text", delta: event.delta };
        continue;
      }
      if (type === "response.output_item.added" && event.item?.type === "function_call") {
        const key = String(event.output_index ?? event.item.id ?? event.item.call_id ?? calls.size);
        calls.set(key, {
          id: event.item.call_id || event.item.id || `call_${calls.size}`,
          name: event.item.name || "",
          args: typeof event.item.arguments === "string" ? event.item.arguments : "",
        });
        continue;
      }
      if (type === "response.function_call_arguments.delta") {
        const key = String(event.output_index ?? event.item_id ?? "0");
        const current = calls.get(key) ?? {
          id: event.call_id || event.item_id || `call_${calls.size}`,
          name: event.name || "",
          args: "",
        };
        if (typeof event.delta === "string") current.args += event.delta;
        calls.set(key, current);
        continue;
      }
      if (type === "response.output_item.done" && event.item?.type === "function_call") {
        const key = String(event.output_index ?? event.item.id ?? event.item.call_id ?? "0");
        const current = calls.get(key) ?? { id: "", name: "", args: "" };
        current.id = event.item.call_id || event.item.id || current.id || `call_${calls.size}`;
        current.name = event.item.name || current.name;
        if (typeof event.item.arguments === "string" && event.item.arguments) {
          current.args = event.item.arguments;
        }
        calls.set(key, current);
        continue;
      }
      if (type === "response.completed") {
        const responseUsage = event.response?.usage;
        if (responseUsage) {
          usage = {
            inputTokens: responseUsage.input_tokens,
            outputTokens: responseUsage.output_tokens,
          };
        }
        finishReason = event.response?.status;
      } else if (type === "response.failed" || type === "error") {
        throw new Error(event.response?.error?.message || event.error?.message || event.message || "Responses API failed");
      }
    }

    for (const call of calls.values()) {
      if (!call.name) continue;
      yield {
        kind: "tool-call",
        id: call.id,
        name: call.name,
        arguments: parseToolArgs(call.args),
      };
    }
    yield { kind: "done", usage, finishReason };
  }
}

/** Translate persisted chat/tool history into Responses API input items. */
export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      if (message.content) out.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls ?? []) {
        out.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
    } else {
      out.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
    }
  }
  return out;
}
