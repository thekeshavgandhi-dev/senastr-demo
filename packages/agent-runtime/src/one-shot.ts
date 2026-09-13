import { randomUUID } from "node:crypto";
import type { ChatMessage, Usage } from "@senastr/shared";
import type { ModelSpec, Provider } from "./types";
import { createProvider } from "./providers/factory";

export interface OneShotParams {
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal;
  providerFactory?: (spec: ModelSpec) => Provider;
}

export interface OneShotResult {
  text: string;
  usage: Usage;
}

/**
 * A single tool-less model call. Used for prompt enhancement and session
 * title summarization — never for agent turns (those go through runTurn).
 */
export async function completeOneShot(spec: ModelSpec, params: OneShotParams): Promise<OneShotResult> {
  const provider = params.providerFactory ? params.providerFactory(spec) : createProvider(spec);
  const messages: ChatMessage[] = [
    { id: randomUUID(), role: "user", content: params.user, createdAt: Date.now() },
  ];
  let text = "";
  const usage: Usage = {};
  for await (const evt of provider.streamChat({
    model: spec.model,
    system: params.system,
    messages,
    tools: [],
    signal: params.signal,
    maxTokens: params.maxTokens,
  })) {
    if (evt.kind === "text") text += evt.delta;
    else if (evt.kind === "done" && evt.usage) {
      if (typeof evt.usage.inputTokens === "number") {
        usage.inputTokens = (usage.inputTokens ?? 0) + evt.usage.inputTokens;
      }
      if (typeof evt.usage.outputTokens === "number") {
        usage.outputTokens = (usage.outputTokens ?? 0) + evt.usage.outputTokens;
      }
    }
  }
  return { text: text.trim(), usage };
}

export const PROMPT_ENHANCEMENT_SYSTEM = [
  "You rewrite a user's rough task description into a clear, actionable developer prompt.",
  "Keep the user's intent and all technical details. Add structure (goal, context, constraints) only when it helps.",
  "Do not execute the task, do not ask questions, do not add explanations outside the rewritten prompt.",
  "Reply with ONLY the rewritten prompt, no quotes, no preamble.",
].join("\n");

export const TITLE_SUMMARIZE_SYSTEM = [
  "Summarize the user's task in 2-6 words for a chat session title.",
  "No punctuation at the end, no quotes, no preamble. Reply with ONLY the title.",
].join("\n");
