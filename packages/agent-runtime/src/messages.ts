import type { ChatMessage } from "@senastr/shared";

/**
 * Default system prompt. Kept deliberately small: the tool descriptions
 * carry the interface contract, the prompt carries identity + boundaries.
 */
export function defaultSystemPrompt(projectPath: string): string {
  return [
    "You are senastr, a local-first AI coding agent working directly on a project on the user's machine.",
    `The current project directory is: ${projectPath}`,
    "",
    "Working rules:",
    "- Use the tools to inspect, modify and run things in the project. Prefer reading before writing.",
    "- All tool paths are relative to the project directory.",
    "- When you run a command, check its output; fix mistakes and re-run when needed.",
    "- When a task is done, summarize what you changed in a few sentences.",
    "- If you are unsure about a destructive action, explain what you would do instead of doing it.",
    "",
    "Write code that fits the existing style of the project. Be concise in chat; show file changes through the tools, not by pasting whole files.",
  ].join("\n");
}

/**
 * Map our transcript shape to the OpenAI Chat Completions wire format.
 */
export function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        out.push({ role: "assistant", content: m.content });
      }
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

/**
 * Map our transcript shape to the Anthropic Messages wire format.
 *
 * Anthropic rules we must respect:
 *  - first message must be user
 *  - tool results ride inside user messages as tool_result blocks
 *  - assistant messages can carry text + tool_use blocks
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: unknown }> {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else if (last && last.role === "user" && typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }, block];
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }

  // If the transcript starts with an assistant (e.g. a resumed session),
  // anchor it so the API accepts the request.
  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", content: "(session resumed)" });
  }
  return out;
}
