import type { ProviderEvent, Provider, ProviderChatParams, ModelSpec } from "../types";
import { toOpenAIMessages } from "../messages";
import type { Usage } from "@senastr/shared";

/**
 * OpenAI Chat Completions streaming client.
 *
 * Works against OpenAI and any OpenAI-compatible endpoint (Ollama, vLLM,
 * LiteLLM, gateways) by making the base URL configurable. Only the bare
 * HTTP/SSE protocol is used — no SDK.
 */
export class OpenAICompatibleProvider implements Provider {
  constructor(private readonly spec: ModelSpec) {}

  async *streamChat(params: ProviderChatParams): AsyncIterable<ProviderEvent> {
    const base = (this.spec.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAIMessages(params.system, params.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.spec.apiKey ? { authorization: `Bearer ${this.spec.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await safeReadText(res);
      throw new Error(`model request failed (HTTP ${res.status}): ${detail.slice(0, 400)}`);
    }

    let usage: Usage | undefined;
    let finishReason: string | undefined;
    const pending = new Map<number, { id: string; name: string; args: string }>();

    for await (const data of parseSseLines(res.body)) {
      if (data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        yield { kind: "text", delta: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const index = typeof tc.index === "number" ? tc.index : 0;
        const slot = pending.get(index) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
        if (typeof tc.function?.name === "string") slot.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
        pending.set(index, slot);
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      if (chunk?.usage && typeof chunk.usage === "object") {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }

    for (const [, slot] of pending) {
      if (!slot.name) continue;
      yield { kind: "tool-call", id: slot.id || `call_${slot.name}`, name: slot.name, arguments: parseToolArgs(slot.args) };
    }

    yield { kind: "done", usage, finishReason };
  }
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

export async function* parseSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}
