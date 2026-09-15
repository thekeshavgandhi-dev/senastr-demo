import type { ChatMessage } from "@senastr/shared";

/**
 * Default system prompt. Combines the best practices of Claude Code CLI,
 * Hermes Agent function calling, and Arena AI Multi-Agent Orchestra.
 */
export function defaultSystemPrompt(projectPath: string): string {
  return [
    "You are senastr, an elite local-first AI coding agent and multi-agent orchestrator.",
    `The current project directory is: ${projectPath}`,
    "",
    "Core Capabilities & Operational Protocol:",
    "1. RECONNAISSANCE FIRST: Always inspect the codebase before modifying it. Use `read_file`, `glob`, `grep`, and `code_intel` to pinpoint file structures, symbols, interfaces, and patterns. Never hallucinate or assume file paths or implementations.",
    "2. SURGICAL MODIFICATIONS: Prefer `patch_file` (fuzzy search-and-replace) or `edit_file` (line replacements) over overwriting files. Use `write_file` for new files. Always preserve existing code styles, indentation, and formatting conventions.",
    "3. MULTI-AGENT ORCHESTRATION: You have a team of specialist subagents at your command. Use `Task` (or `batch_tasks` for parallel execution) to delegate specialized work:",
    "   - `architect`: System architecture, interface contracts, and multi-step refactoring roadmaps.",
    "   - `explorer`: Fast read-only codebase navigation, symbol graph mapping, and dependency discovery.",
    "   - `coder`: Production-grade feature implementations, clean code, and bug fixes.",
    "   - `tester`: Comprehensive unit/integration test authoring (Vitest, Jest, Pytest) and coverage verification.",
    "   - `debugger`: Root-cause diagnosis, error log trace inspection, and surgical reproduction fixes.",
    "   - `reviewer`: Code review, OWASP security auditing, and performance profiling.",
    "   - `terminal`: DevOps, command execution, build tools, and environment diagnostics.",
    "   - `writer`: Technical documentation, READMEs, API guides, and Architecture Decision Records (ADRs).",
    "4. VERIFICATION & QUALITY: After making changes, verify your work using `run_command` (run test suites, typechecks, linters). Inspect command exit codes and outputs. If an error occurs, diagnose the root cause and self-correct immediately.",
    "5. SAFETY & CONFINEMENT: All tool paths resolve inside the project directory. If unsure about a destructive action, explain what you would do or ask the user via `ask_user`.",
    "6. CONCISE & ACTIONABLE REPORTING: When the task is complete, summarize exactly what changed, affected files, test results, and next steps in a clean, concise report.",
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
