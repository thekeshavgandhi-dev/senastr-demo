import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ErrorCodes, RpcError, type FileIndexResult } from "@senastr/shared";

/**
 * Workspace file index (parity: pi-desktop `fs/index`).
 *
 * Powers "@ file" autocomplete and the command palette's file mode. The scan
 * is breadth-first, skips the same directories the glob tool ignores, and is
 * cached briefly so keystrokes do not re-walk the tree.
 */

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".DS_Store",
]);

const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 12;
const CACHE_TTL_MS = 3_000;

interface CacheEntry {
  at: number;
  result: FileIndexResult;
}

const cache = new Map<string, CacheEntry>();

export function indexProject(projectPath: unknown, options: { force?: boolean; limit?: number } = {}): FileIndexResult {
  const root = typeof projectPath === "string" ? projectPath.trim() : "";
  if (!root) throw new RpcError(ErrorCodes.INVALID_PARAMS, "projectPath is required");
  const limit = Math.min(Math.max(options.limit ?? MAX_ENTRIES, 1), MAX_ENTRIES);
  const cached = cache.get(root);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const started = Date.now();
  const paths: string[] = [];
  let truncated = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (paths.length >= limit) {
        truncated = true;
        break;
      }
      if (entry.startsWith(".") && entry !== ".github" && entry !== ".env.example") continue;
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (IGNORED_DIRS.has(entry) || depth >= MAX_DEPTH) continue;
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!stats.isFile()) continue;
      paths.push(relative(root, full).split("\\").join("/"));
    }
    if (truncated) break;
  }

  paths.sort((a, b) => a.localeCompare(b));
  const result: FileIndexResult = { paths, truncated, elapsedMs: Date.now() - started };
  cache.set(root, { at: Date.now(), result });
  return result;
}

/** Drop cached indexes (tests, or when the user asks for a refresh). */
export function clearIndexCache(): void {
  cache.clear();
}
