import type { ChatMessage, MessageAttachment } from "@senastr/shared";
import { BASE_PROTOCOL } from "./prompt";

/** Image attachments that carry a hydrated payload, ready for the wire. */
function imageParts(message: ChatMessage): MessageAttachment[] {
  return (message.attachments ?? []).filter(
    (a) => a.kind === "image" && typeof a.dataBase64 === "string" && a.dataBase64.length > 0,
  );
}

/** Human-readable footer for non-image attachments (files, large pastes). */
function attachmentNote(message: ChatMessage): string {
  const extras = (message.attachments ?? []).filter((a) => a.kind !== "image" || !a.dataBase64);
  if (extras.length === 0) return "";
  return extras
    .map((a) => {
      if (a.text) return `--- attached: ${a.name} ---\n${a.text}`;
      if (a.path) return `--- attached file: ${a.path} ---`;
      return `--- attached: ${a.name} (${a.mimeType}, ${a.bytes ?? 0} bytes) ---`;
    })
    .join("\n");
}

/** Text a user message contributes once attachments are folded in. */
function userText(message: ChatMessage): string {
  const note = attachmentNote(message);
  if (!note) return message.content;
  return message.content ? `${message.content}\n\n${note}` : note;
}

/**
 * Default system prompt: identity + the operating protocol.
 *
 * Skills, memory, the task list and runtime warnings are composed around this
 * by `composeSystemPrompt` — they change every step, this part does not.
 */
export function defaultSystemPrompt(projectPath: string): string {
  return [
    `You are senastr, an elite local-first AI engineering agent working in the project: ${projectPath}`,
    "",
    BASE_PROTOCOL,
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
      const images = imageParts(m);
      if (images.length > 0) {
        out.push({
          role: "user",
          content: [
            ...(userText(m) ? [{ type: "text", text: userText(m) }] : []),
            ...images.map((a) => ({
              type: "image_url",
              image_url: { url: `data:${a.mimeType};base64,${a.dataBase64}` },
            })),
          ],
        });
        continue;
      }
      out.push({ role: "user", content: userText(m) });
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
      const images = imageParts(m);
      if (images.length > 0) {
        const blocks: unknown[] = [];
        if (userText(m)) blocks.push({ type: "text", text: userText(m) });
        for (const a of images) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: a.mimeType, data: a.dataBase64 },
          });
        }
        out.push({ role: "user", content: blocks });
        continue;
      }
      out.push({ role: "user", content: userText(m) });
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
