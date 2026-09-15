import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ErrorCodes,
  RpcError,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryScope,
  type MemorySearchHit,
  type MemoryTarget,
} from "@senastr/shared";

/**
 * Durable agent memory, local-first and plain-Markdown.
 *
 * ```
 * <dataDir>/memory/
 * ├── global/
 * │   ├── MEMORY.md          # index — the only part auto-injected each turn
 * │   ├── topics/<slug>.md   # one curated note per subject
 * │   ├── log/YYYY-MM-DD.md  # append-only daily work log
 * │   └── scratchpad.md      # short-lived notes for work in flight
 * └── projects/<key>/…       # same layout, scoped to one project
 * ```
 *
 * Design constraints that shaped this:
 *  - **No embeddings, no daemon, no network.** Retrieval is a small BM25-ish
 *    keyword scorer; it is fast, deterministic and inspectable.
 *  - **Markdown is the source of truth.** The user can read, diff, back up or
 *    delete memory with ordinary tools.
 *  - **Memory is untrusted recall.** It is injected as context, never as
 *    instruction, and secrets are scrubbed before anything is written.
 */

const MAX_TOPIC_CHARS = 32_000;
const MAX_LOG_CHARS = 200_000;
const MAX_INDEX_ENTRIES = 200;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 25;
/** Characters of the index block injected into the system prompt. */
const PROMPT_INDEX_CHARS = 2_400;
const PROMPT_HIT_CHARS = 700;
const EXCERPT_CHARS = 320;

export interface MemoryRef {
  scope: MemoryScope;
  projectPath?: string | null;
}

export class MemoryService {
  constructor(private readonly dataDir: string) {}

  private dirFor(ref: MemoryRef): string {
    const base = join(this.dataDir, "memory");
    if (ref.scope === "global") return join(base, "global");
    const projectPath = ref.projectPath?.trim();
    if (!projectPath) return join(base, "global");
    return join(base, "projects", projectKey(projectPath));
  }

  private ensure(ref: MemoryRef): string {
    const dir = this.dirFor(ref);
    mkdirSync(join(dir, "topics"), { recursive: true });
    mkdirSync(join(dir, "log"), { recursive: true });
    return dir;
  }

  /** Absolute directory of a store (so the UI can offer to open it). */
  dir(ref: MemoryRef): string {
    return this.dirFor(ref);
  }

  /* ---------------------------------------------------------------- read */

  index(ref: MemoryRef): MemoryIndex {
    const dir = this.dirFor(ref);
    if (!existsSync(dir)) {
      return { scope: ref.scope, dir, index: "", entries: [], size: 0 };
    }
    const entries: MemoryEntry[] = [];
    for (const file of listMarkdown(join(dir, "topics"))) {
      const key = file.replace(/\.md$/i, "");
      const content = read(join(dir, "topics", file));
      entries.push({
        key,
        target: "topic",
        scope: ref.scope,
        content,
        summary: firstLine(content),
        updatedAt: mtime(join(dir, "topics", file)),
        size: content.length,
      });
    }
    const scratchpad = read(join(dir, "scratchpad.md"));
    if (scratchpad.trim()) {
      entries.push({
        key: "scratchpad",
        target: "scratchpad",
        scope: ref.scope,
        content: scratchpad,
        summary: firstLine(scratchpad),
        updatedAt: mtime(join(dir, "scratchpad.md")),
        size: scratchpad.length,
      });
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      scope: ref.scope,
      dir,
      index: read(join(dir, "MEMORY.md")),
      entries: entries.slice(0, MAX_INDEX_ENTRIES),
      size: entries.reduce((sum, e) => sum + e.size, 0),
    };
  }

  read(ref: MemoryRef, key: string): MemoryEntry | null {
    const dir = this.dirFor(ref);
    const wanted = (key ?? "").trim().toLowerCase();
    if (!wanted) return null;
    if (wanted === "index" || wanted === "memory") {
      const content = read(join(dir, "MEMORY.md"));
      return entry("index", "index", ref.scope, content, mtime(join(dir, "MEMORY.md")));
    }
    if (wanted === "scratchpad") {
      const content = read(join(dir, "scratchpad.md"));
      return content.trim() ? entry("scratchpad", "scratchpad", ref.scope, content, mtime(join(dir, "scratchpad.md"))) : null;
    }
    if (wanted === "log" || wanted === "today") {
      const file = join(dir, "log", `${today()}.md`);
      const content = read(file);
      return content.trim() ? entry(today(), "log", ref.scope, content, mtime(file)) : null;
    }
    const file = join(dir, "topics", `${topicFile(wanted)}.md`);
    if (!existsSync(file)) return null;
    const content = read(file);
    return entry(wanted, "topic", ref.scope, content, mtime(file));
  }

  /* --------------------------------------------------------------- write */

  write(
    ref: MemoryRef,
    key: string,
    content: string,
    mode: "replace" | "append" = "replace",
  ): MemoryEntry {
    const slug = topicFile(key);
    if (!slug) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory key is required");
    const body = redact(typeof content === "string" ? content : "");
    if (!body.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory content is required");
    const dir = this.ensure(ref);
    const file = join(dir, "topics", `${slug}.md`);
    const previous = read(file);
    const next = mode === "append" && previous.trim() ? `${previous.trimEnd()}\n\n${body}` : body;
    if (next.length > MAX_TOPIC_CHARS) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `memory topic "${slug}" would exceed ${MAX_TOPIC_CHARS} characters (${next.length}) — split it or trim it`,
      );
    }
    write(file, next);
    this.rebuildIndex(ref);
    return entry(slug, "topic", ref.scope, next, Date.now());
  }

  appendLog(ref: MemoryRef, line: string): MemoryEntry {
    const text = redact(typeof line === "string" ? line : "").trim();
    if (!text) throw new RpcError(ErrorCodes.INVALID_PARAMS, "log content is required");
    const dir = this.ensure(ref);
    const file = join(dir, "log", `${today()}.md`);
    const previous = read(file);
    const stamp = new Date().toISOString().slice(11, 19);
    const next = `${previous.trimEnd()}${previous.trim() ? "\n" : ""}- ${stamp} ${text}\n`;
    if (next.length > MAX_LOG_CHARS) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "today's memory log is full — start a new topic instead");
    }
    write(file, next);
    return entry(today(), "log", ref.scope, next, Date.now());
  }

  forget(ref: MemoryRef, key: string): boolean {
    const slug = topicFile(key ?? "");
    if (!slug) throw new RpcError(ErrorCodes.INVALID_PARAMS, "memory key is required");
    const file = join(this.dirFor(ref), "topics", `${slug}.md`);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    this.rebuildIndex(ref);
    return true;
  }

  /* -------------------------------------------------------------- search */

  search(query: string, ref: MemoryRef, limit = DEFAULT_SEARCH_LIMIT): MemorySearchHit[] {
    const q = (query ?? "").trim();
    if (!q) return [];
    const cap = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
    const hits: MemorySearchHit[] = [];
    for (const scope of scopes(ref)) {
      for (const doc of this.documents({ scope, projectPath: ref.projectPath })) {
        const score = scoreDocument(q, doc);
        if (score <= 0) continue;
        hits.push({
          key: doc.key,
          target: doc.target,
          scope,
          excerpt: excerpt(doc.content, q),
          score,
          updatedAt: doc.updatedAt,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, cap);
  }

  /** Recall across project + global stores, project hits ranked first. */
  recall(query: string, projectPath?: string | null, limit = 6): MemorySearchHit[] {
    const scopesToSearch: MemoryScope[] = projectPath ? ["project", "global"] : ["global"];
    const out: MemorySearchHit[] = [];
    for (const scope of scopesToSearch) {
      out.push(...this.search(query, { scope, projectPath }, limit));
    }
    const seen = new Set<string>();
    return out
      .sort((a, b) => b.score - a.score)
      .filter((hit) => {
        const id = `${hit.scope}:${hit.target}:${hit.key}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, limit);
  }

  /* ------------------------------------------------------- system prompt */

  /**
   * The block injected into the system prompt: the memory index (always) plus
   * the passages that match the current request (recall). Small on purpose —
   * it is on every request, so a big block taxes every turn.
   */
  promptBlock(projectPath: string | null, query?: string, limit = 5): string {
    const parts: string[] = [];
    for (const scope of projectPath ? (["project", "global"] as MemoryScope[]) : (["global"] as MemoryScope[])) {
      const ref: MemoryRef = { scope, projectPath };
      const idx = this.index(ref);
      if (!idx.entries.length) continue;
      const label = scope === "project" ? "project memory" : "global memory";
      const lines = idx.entries
        .slice(0, 24)
        .map((e) => `- ${e.key}: ${(e.summary ?? e.content).slice(0, 160)}`)
        .join("\n");
      parts.push(`<${label} index>\n${lines}\n</${label} index>`);
    }
    if (!parts.length) return "";

    let block = parts.join("\n\n");
    if (block.length > PROMPT_INDEX_CHARS) block = `${block.slice(0, PROMPT_INDEX_CHARS)}\n…`;

    if (query && query.trim()) {
      const hits = this.recall(query, projectPath, limit).filter((h) => h.score > 0);
      if (hits.length) {
        const rendered = hits
          .map((h) => `- [${h.scope}/${h.key}] ${h.excerpt.slice(0, PROMPT_HIT_CHARS)}`)
          .join("\n");
        block += `\n\n<recalled memory>\n${rendered}\n</recalled memory>`;
      }
    }
    return block;
  }

  /* -------------------------------------------------------------- index */

  /** Regenerate MEMORY.md from the topics on disk. Cheap; run after writes. */
  rebuildIndex(ref: MemoryRef): string {
    const dir = this.ensure(ref);
    const entries = this.index(ref).entries.filter((e) => e.target !== "scratchpad");
    const heading = ref.scope === "project" && ref.projectPath ? `# Memory — ${ref.projectPath}` : "# Memory — global";
    const body = entries.length
      ? entries.map((e) => `- **${e.key}** — ${(e.summary ?? "").slice(0, 200)}`).join("\n")
      : "_No topics yet. Write durable findings with the `memory` tool._";
    const doc = `${heading}\n\n${body}\n`;
    write(join(dir, "MEMORY.md"), doc);
    return doc;
  }

  private documents(ref: MemoryRef): MemoryEntry[] {
    const idx = this.index(ref);
    const docs = idx.entries.slice();
    const logDoc = this.read(ref, "log");
    if (logDoc) docs.push(logDoc);
    return docs;
  }
}

/* ------------------------------------------------------------------ utils */

function scopes(ref: MemoryRef): MemoryScope[] {
  return [ref.scope];
}

function entry(
  key: string,
  target: MemoryTarget,
  scope: MemoryScope,
  content: string,
  updatedAt: number,
): MemoryEntry {
  return { key, target, scope, content, summary: firstLine(content), updatedAt, size: content.length };
}

function topicFile(key: string): string {
  return (
    key
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || ""
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function write(file: string, content: string): void {
  mkdirSync(dirnameOf(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : ".";
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function listMarkdown(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

function firstLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim();
    if (trimmed) return trimmed.slice(0, 200);
  }
  return "";
}

/** Stable per-project directory key. */
function projectKey(projectPath: string): string {
  const abs = resolve(projectPath);
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 10);
  const slug = abs
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-40);
  return slug ? `${slug}-${hash}` : hash;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "we", "you", "i", "how",
  "what", "why", "when", "where", "which", "do", "does", "did", "can", "should", "would", "at", "as",
  "by", "from", "not", "no", "so", "about", "into", "over", "under", "use", "used", "using",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * BM25-flavoured scoring over a tiny corpus. Tuned for recall precision on
 * short notes rather than for theoretical purity: exact-phrase hits and key
 * matches dominate, and long notes are penalised so a mention does not
 * outrank a dedicated topic.
 */
export function scoreDocument(query: string, doc: MemoryEntry): number {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  const haystack = doc.content.toLowerCase();
  const keyTokens = tokenize(doc.key.replace(/-/g, " "));
  let score = 0;
  const unique = new Set(terms);
  for (const term of unique) {
    const occurrences = countOccurrences(haystack, term);
    if (occurrences === 0) continue;
    // Density (hits per 200 characters) rather than raw count: a note about
    // Redis mentions it often and briefly; a 3 000-character incident report
    // mentions it once.
    score += (occurrences * 200) / Math.max(40, doc.content.length);
    if (keyTokens.includes(term)) score += 2.5;
    if ((doc.summary ?? "").toLowerCase().includes(term)) score += 1;
  }
  if (unique.size > 1 && haystack.includes(query.toLowerCase().trim())) score += 4;
  if (score <= 0) return 0;
  // Gentle length damping only: relevance should not be decided by size.
  const length = Math.max(1, doc.content.length);
  return Math.round(((score * 100) / (1 + Math.log10(1 + length / 200))) * 10) / 10;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
    if (count > 40) break;
  }
  return count;
}

/** A window of the document around the best-matching term. */
function excerpt(content: string, query: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const lower = flat.toLowerCase();
  let best = -1;
  for (const term of tokenize(query)) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return `${flat.slice(0, EXCERPT_CHARS)}…`;
  const start = Math.max(0, best - Math.floor(EXCERPT_CHARS / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + EXCERPT_CHARS)}${
    start + EXCERPT_CHARS < flat.length ? "…" : ""
  }`;
}

/**
 * Scrub credential-shaped text before it is persisted. Memory is written to
 * disk in plain text and injected into prompts; a pasted key must never end
 * up in either.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted:api-key]")
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[redacted:github-token]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted:slack-token]")
    .replace(/\b(AKIA[0-9A-Z]{12,})\b/g, "[redacted:aws-key]")
    .replace(/\b(AIza[0-9A-Za-z_-]{30,})\b/g, "[redacted:google-key]")
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[redacted:jwt]")
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "[redacted:private-key]")
    .replace(/\b([A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{8,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "[redacted:credentials-in-url]");
}
