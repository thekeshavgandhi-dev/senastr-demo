import { ErrorCodes, RpcError, type MemoryScope } from "@senastr/shared";
import type { MemoryService } from "../memory";

/**
 * The `memory` tool — the agent's read/write interface to durable memory.
 *
 * Kept deliberately small on the wire: the model gets one action per call and
 * back comes plain Markdown, so a failure is obvious and retryable.
 */
export function memoryTool(memory: MemoryService, projectPath: string, args: Record<string, unknown>): string {
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  if (!action) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory.action is required");

  const scope = resolveScope(args.scope, projectPath);
  const ref = { scope, projectPath: scope === "project" ? projectPath : null };
  const key = typeof args.key === "string" ? args.key.trim() : "";
  const content = typeof args.content === "string" ? args.content : "";
  const mode = args.mode === "append" ? "append" : "replace";
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 8;

  switch (action) {
    case "list": {
      const idx = memory.index(ref);
      if (!idx.entries.length) {
        return `memory (${scope}): no entries yet. Use the memory tool with action "write" to record durable knowledge.`;
      }
      const lines = idx.entries.map(
        (e) => `- ${e.key}  [${e.target}]  ${new Date(e.updatedAt).toISOString().slice(0, 10)}  — ${(e.summary ?? "").slice(0, 120)}`,
      );
      return `memory (${scope}) — ${idx.entries.length} entries, ${idx.size} chars:\n${lines.join("\n")}`;
    }

    case "read": {
      const entry = memory.read(ref, key || "index");
      if (!entry) {
        const idx = memory.index(ref);
        const names = idx.entries.map((e) => e.key).join(", ");
        throw new RpcError(
          ErrorCodes.HOST_ERROR,
          `no memory entry "${key}" in the ${scope} store.${names ? ` Known keys: ${names}` : ""}`,
        );
      }
      return `# memory/${scope}/${entry.key}\n\n${entry.content}`;
    }

    case "write": {
      if (!key) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory.write requires `key` (a topic slug)");
      const entry = memory.write(ref, key, content, mode);
      return `memory written: ${scope}/${entry.key} (${entry.size} chars, ${mode}). It is now in the index and will be recalled in future sessions.`;
    }

    case "log": {
      if (!content.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory.log requires `content`");
      const entry = memory.appendLog(ref, content);
      return `logged to ${scope}/log/${entry.key}`;
    }

    case "forget": {
      if (!key) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory.forget requires `key`");
      const removed = memory.forget(ref, key);
      return removed
        ? `forgot ${scope}/${key}`
        : `nothing to forget: no ${scope} memory entry "${key}"`;
    }

    case "search": {
      const query = key || (typeof args.query === "string" ? args.query : "");
      if (!query.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory.search requires a query in `key`");
      const hits = memory.recall(query, projectPath, limit);
      if (!hits.length) return `memory search: no matches for "${query}".`;
      const lines = hits.map(
        (h, i) => `${i + 1}. [${h.scope}/${h.key}] (score ${h.score.toFixed(1)})\n   ${h.excerpt}`,
      );
      return `memory search "${query}" — ${hits.length} hit(s):\n${lines.join("\n")}`;
    }

    default:
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `unknown memory action "${action}". Use one of: read, write, search, list, log, forget.`,
      );
  }
}

function resolveScope(value: unknown, projectPath: string): MemoryScope {
  if (value === "global") return "global";
  if (value === "project") return projectPath ? "project" : "global";
  return projectPath ? "project" : "global";
}
