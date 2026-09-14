import type { ChatMessage } from "@senastr/shared";

/**
 * Bounded model context.
 *
 * The transcript on disk is the durable record; what the model receives each
 * step is a window over it. Without this, a long session eventually exceeds
 * the provider's context window and the turn dies mid-task.
 *
 * Rules:
 *  - the first user message is always kept (it is the task anchor);
 *  - the newest messages are kept greedily until the character budget is hit;
 *  - the window never starts with an orphan `tool` result and never ends with
 *    an assistant turn whose tool calls have no results (providers reject
 *    both shapes);
 *  - one oversized message (a huge tool dump) is truncated instead of pushing
 *    the whole conversation out of the window;
 *  - when anything is dropped, a checkpoint note is inserted so the model
 *    knows earlier context exists and can re-read files it still needs.
 */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 120_000;
/** A single tool result/assistant message may not exceed this many chars. */
export const MAX_MESSAGE_CHARS = 24_000;

export interface CompactResult {
  messages: ChatMessage[];
  /** How many transcript messages were left out of this request. */
  dropped: number;
  /** True when at least one message was truncated in place. */
  truncated: boolean;
}

function sizeOf(message: ChatMessage): number {
  let total = message.content.length + 32;
  for (const call of message.toolCalls ?? []) {
    total += JSON.stringify(call.arguments ?? {}).length + 48;
  }
  return total;
}

/** Clip a single oversized message to the per-message ceiling. */
function bound(message: ChatMessage, ceiling = MAX_MESSAGE_CHARS): { message: ChatMessage; truncated: boolean } {
  if (sizeOf(message) <= ceiling && message.content.length <= ceiling) {
    return { message, truncated: false };
  }
  const keep = Math.max(0, ceiling - 64);
  const tail = message.content.slice(-keep);
  return {
    message: {
      ...message,
      content: `… [message trimmed to the last ${keep} characters]\n${tail}`,
    },
    truncated: true,
  };
}

export function compactHistory(
  messages: ChatMessage[],
  budget = DEFAULT_CONTEXT_CHAR_BUDGET,
): CompactResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], dropped: 0, truncated: false };
  }

  let truncated = false;
  const bounded = messages.map((message) => {
    const result = bound(message);
    if (result.truncated) truncated = true;
    return result.message;
  });

  const total = bounded.reduce((sum, m) => sum + sizeOf(m), 0);
  if (total <= budget) return { messages: bounded, dropped: 0, truncated };

  const anchor = bounded[0];
  let used = sizeOf(anchor);
  const kept: ChatMessage[] = [];
  for (let i = bounded.length - 1; i >= 1; i--) {
    const cost = sizeOf(bounded[i]);
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(bounded[i]);
    used += cost;
  }

  // Never open the window on an orphan tool result: its assistant call is gone.
  while (kept.length > 0 && kept[0].role === "tool") kept.shift();
  // Never end on an assistant message whose tool calls have no results.
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last.role === "assistant" && (last.toolCalls?.length ?? 0) > 0) kept.pop();
    else break;
  }

  const dropped = messages.length - kept.length - 1;
  const checkpoint: ChatMessage = {
    id: `checkpoint-${messages.length}-${Date.now()}`,
    role: "assistant",
    content:
      `[context checkpoint] ${dropped} earlier message${dropped === 1 ? "" : "s"} were left out of this ` +
      "request to stay within the model's context window. The full transcript is still stored locally. " +
      "Re-read files or re-run searches if you need details from before this point.",
    createdAt: Date.now(),
  };

  return { messages: [anchor, checkpoint, ...kept], dropped, truncated };
}
