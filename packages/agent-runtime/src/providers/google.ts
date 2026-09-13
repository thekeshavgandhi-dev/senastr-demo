import type { ChatMessage, Usage } from "@senastr/shared";
import type { ModelSpec, Provider, ProviderChatParams, ProviderEvent } from "../types";
import { parseSseLines, safeReadText } from "./openai";
import { postToModel } from "./resilient";

/** Google Generative Language (Gemini) streaming adapter. */
export class GoogleGenerativeAIProvider implements Provider {
  constructor(private readonly spec: ModelSpec) {}

  async *streamChat(params: ProviderChatParams): AsyncIterable<ProviderEvent> {
    const base = (this.spec.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const model = params.model.replace(/^models\//, "");
    const body: Record<string, unknown> = {
      contents: toGeminiContents(params.messages),
    };
    if (params.system) {
      body.systemInstruction = { parts: [{ text: params.system }] };
    }
    if (params.maxTokens) {
      body.generationConfig = { maxOutputTokens: params.maxTokens };
    }
    if (params.tools.length) {
      body.tools = [
        {
          functionDeclarations: params.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }

    const res = await postToModel({
      spec: this.spec,
      signal: params.signal,
      build: (apiKey) => {
        const query = new URLSearchParams({ alt: "sse" });
        if (apiKey) query.set("key", apiKey);
        return {
          url: `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?${query.toString()}`,
          headers: { ...(this.spec.headers ?? {}), "content-type": "application/json" },
          body: JSON.stringify(body),
        };
      },
    });
    if (!res.ok || !res.body) {
      const detail = await safeReadText(res);
      throw new Error(`model request failed (HTTP ${res.status}): ${detail.slice(0, 400)}`);
    }

    let usage: Usage | undefined;
    let finishReason: string | undefined;
    let callIndex = 0;
    for await (const data of parseSseLines(res.body)) {
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk?.error?.message) throw new Error(chunk.error.message);
      const candidate = chunk?.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part?.text === "string" && part.text) {
          yield { kind: "text", delta: part.text };
        }
        if (part?.functionCall?.name) {
          callIndex += 1;
          yield {
            kind: "tool-call",
            id: `gemini_${callIndex}_${Date.now().toString(36)}`,
            name: part.functionCall.name,
            arguments:
              part.functionCall.args && typeof part.functionCall.args === "object"
                ? part.functionCall.args
                : {},
          };
        }
      }
      if (typeof candidate?.finishReason === "string") finishReason = candidate.finishReason;
      const metadata = chunk?.usageMetadata;
      if (metadata) {
        usage = {
          inputTokens: metadata.promptTokenCount,
          outputTokens: metadata.candidatesTokenCount,
        };
      }
    }
    yield { kind: "done", usage, finishReason };
  }
}

/** Convert senastr's normalized transcript to Gemini contents. */
export function toGeminiContents(messages: ChatMessage[]): unknown[] {
  const out: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", parts: [{ text: message.content }] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: unknown[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.name);
        parts.push({ functionCall: { name: call.name, args: call.arguments } });
      }
      if (parts.length) out.push({ role: "model", parts });
      continue;
    }
    const name = message.toolName || (message.toolCallId ? toolNames.get(message.toolCallId) : undefined) || "tool";
    const part = {
      functionResponse: {
        name,
        response: message.content.startsWith("ERROR: ")
          ? { error: message.content.slice(7) }
          : { output: message.content },
      },
    };
    const previous = out[out.length - 1];
    if (previous?.role === "user" && previous.parts.every((item: any) => item?.functionResponse)) {
      previous.parts.push(part);
    } else {
      out.push({ role: "user", parts: [part] });
    }
  }
  return out;
}
