import type { ChatMessage } from "@senastr/shared";

/**
 * History summarisation for compaction.
 *
 * Truncation is cheap and lossy: once the window slides, everything before it
 * is gone and the model starts re-reading files it already understood. This
 * module turns the dropped tail into a dense briefing instead, so a long turn
 * keeps its bearings across compactions.
 */

export const SUMMARIZE_SYSTEM = [
  "You compress a coding-agent transcript into a briefing for the same agent, which has lost the original messages.",
  "",
  "Write it for someone who will continue the work immediately:",
  "- **Task**: the user's actual goal, in one sentence.",
  "- **Decisions made**: choices and conventions, each with the reason.",
  "- **Files touched**: `path — what changed`, including changes that were reverted.",
  "- **State**: what is done, what is in progress, what is broken or blocked.",
  "- **Evidence**: key errors, command results, and root causes already established (with the fix if there was one).",
  "- **Open threads**: TODOs, unverified claims, and the next concrete step.",
  "",
  "Rules:",
  "- Be dense and factual. No preamble, no commentary about the summary itself.",
  "- Keep exact identifiers: file paths, symbol names, commands, error strings, exit codes.",
  "- Preserve anything the agent would otherwise have to re-read the codebase to recover.",
  "- Drop chatter, greetings, and superseded attempts.",
  "- Under 500 words.",
].join("\n");

/**
 * Render transcript messages for the summariser, newest-surviving last.
 * Tool output is clipped hard: it is usually the bulk and the least reusable
 * part of a message.
 */
export function renderTranscriptForSummary(messages: ChatMessage[], maxChars = 28_000): string {
  if (!messages.length) return "";
  const perMessageCap = Math.max(400, Math.floor(maxChars / Math.max(1, messages.length)));
  const lines: string[] = [];
  for (const message of messages) {
    const header = message.role === "tool" ? `tool:${message.toolName ?? "result"}` : message.role;
    const body = clip(message.content.replace(/\s+/g, " ").trim(), perMessageCap);
    if (body) lines.push(`${header}: ${body}`);
    for (const call of message.toolCalls ?? []) {
      const args = clip(safeStringify(call.arguments), 300);
      lines.push(`${message.role} called ${call.name}(${args})`);
    }
  }
  const rendered = lines.join("\n");
  if (rendered.length <= maxChars) {
    return `${rendered}\n\n---\nSummarise the transcript above.`;
  }
  // Keep the head (the original task) and the tail (most recent work).
  const head = Math.floor(maxChars * 0.3);
  const tail = maxChars - head;
  return `${rendered.slice(0, head)}\n\n… [middle of transcript elided] …\n\n${rendered.slice(-tail)}\n\n---\nSummarise the transcript above.`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}
