import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ErrorCodes, RpcError } from "@senastr/shared";

export const DEFAULT_MAX_CHARS = 100_000;
export const MAX_READ_CHARS = 1_000_000;
export const MAX_LIST_ENTRIES = 500;
export const MAX_GLOB_RESULTS = 2_000;
export const DEFAULT_GLOB_RESULTS = 500;
export const MAX_GREP_RESULTS = 1_000;
export const DEFAULT_GREP_RESULTS = 200;
/** Per-file read ceiling for content search (bytes). */
const GREP_MAX_FILE_BYTES = 1_000_000;
/** Directories that never carry authored source worth searching. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "out",
  "build",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "release",
]);

/** Every tool is confined to the session's project root. */
export function resolveProjectPath(project: string | null): string {
  if (!project) {
    throw new RpcError(ErrorCodes.INTERNAL_ERROR, "session has no project set — open a project first");
  }
  return resolve(project);
}

function realPathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Deepest existing ancestor of `p` (or `p` itself when it exists). */
function deepestExisting(p: string): string | null {
  let current = p;
  for (;;) {
    if (realPathOrNull(current) !== null) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Join `rel` onto the project root and refuse anything that escapes it.
 *
 * Two layers, because each catches what the other cannot:
 *   1. Lexical — `..` segments and absolute paths are rejected before touching
 *      the filesystem, so a typo cannot even be attempted.
 *   2. Symlink — a link *inside* the project can point anywhere, and a lexical
 *      check happily follows it. The real path of the target (or of its
 *      deepest existing ancestor, for files that do not exist yet) must still
 *      land inside the real project root.
 */
export function safeJoin(project: string, rel: string): string {
  const root = resolve(project);
  const target = resolve(root, rel || ".");
  if (target !== root && !target.startsWith(root + sep)) {
    throw new RpcError(ErrorCodes.PATH_ESCAPES_PROJECT, `path escapes the project root: ${rel}`);
  }

  // Only meaningful when the root itself exists: if it does not, there is no
  // link under it to follow, and the lexical check above is the whole answer.
  const realRoot = realPathOrNull(root);
  if (realRoot) {
    const anchor = deepestExisting(target);
    const realAnchor = anchor ? realPathOrNull(anchor) : null;
    if (realAnchor && realAnchor !== realRoot && !realAnchor.startsWith(realRoot + sep)) {
      throw new RpcError(
        ErrorCodes.PATH_ESCAPES_PROJECT,
        `path escapes the project root through a link: ${rel}`,
      );
    }
  }
  return target;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} must be a string`);
  }
  return value;
}

/** Short content tag: lets a later edit prove it saw this exact version. */
export function contentTag(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function readFileTool(project: string, args: Record<string, unknown>): string {
  const rel = asString(args.path, "path");
  const target = safeJoin(project, rel);
  const st = lstatSync(target);
  if (st.isDirectory()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `path is a directory, not a file: ${rel}`);
  }
  const maxRaw = args.max_chars;
  const max =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(Math.floor(maxRaw), MAX_READ_CHARS)
      : DEFAULT_MAX_CHARS;
  const fullText = readFileSync(target, "utf8");
  const tag = contentTag(fullText);

  const startLine =
    typeof args.start_line === "number" && Number.isInteger(args.start_line) && args.start_line > 0
      ? args.start_line
      : undefined;
  const endLine =
    typeof args.end_line === "number" && Number.isInteger(args.end_line) && args.end_line > 0
      ? args.end_line
      : undefined;

  if (startLine !== undefined || endLine !== undefined) {
    const lines = fullText.split(/\r?\n/);
    if (fullText.endsWith("\n") && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const totalLines = lines.length;
    const start = startLine ? Math.max(1, Math.min(startLine, totalLines)) : 1;
    const end = endLine ? Math.max(start, Math.min(endLine, totalLines)) : totalLines;
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, idx) => `${start + idx} | ${line}`).join("\n");
    return `path: ${rel}#${tag} (lines ${start}-${end} of ${totalLines})\n---\n${numbered}`;
  }

  let text = fullText;
  const truncated = text.length > max;
  if (truncated) text = text.slice(0, max);
  const body = truncated ? `${text}\n… [truncated at ${max} characters]` : text;
  return `path: ${rel}#${tag}${truncated ? " (truncated)" : ""}\n---\n${body}`;
}

export function writeFileTool(project: string, args: Record<string, unknown>): string {
  const rel = asString(args.path, "path");
  const content = asString(args.content, "content");
  const target = safeJoin(project, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}#${contentTag(content)}`;
}

export function deleteFileTool(project: string, args: Record<string, unknown>): string {
  const rel = asString(args.path, "path");
  const target = safeJoin(project, rel);
  const st = lstatSync(target);
  if (st.isDirectory()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `path is a directory, not a file: ${rel}`);
  }
  unlinkSync(target);
  return `deleted ${rel}`;
}

export function listDirTool(project: string, args: Record<string, unknown>): string {
  const rel = asString(args.path ?? ".", "path").trim();
  const target = safeJoin(project, rel || ".");
  const st = lstatSync(target);
  if (!st.isDirectory()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `not a directory: ${rel}`);
  }
  const entries = readdirSync(target, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => {
      const aDir = a.endsWith("/");
      const bDir = b.endsWith("/");
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    })
    .slice(0, MAX_LIST_ENTRIES);
  const body = entries.join("\n") || "(empty directory)";
  const truncated = entries.length === MAX_LIST_ENTRIES ? "\n… [truncated]" : "";
  return `path: ${rel || "."}\n---\n${body}${truncated}`;
}

/* ------------------------------------------------------------------ glob */

/** Translate a glob (`*`, `**`, `?`) into a regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern.replace(/^\.\//, ""));
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // `**/` matches zero or more directories; `**` matches anything
        if (normalized[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  // A bare pattern like `*.ts` should match at any depth, like most CLIs.
  const body = normalized.includes("/") ? out : `(?:.*/)?${out}`;
  return new RegExp(`^${body}$`);
}

interface WalkEntry {
  rel: string;
  abs: string;
}

/** Walk the project tree (skipping heavy directories) with a hard cap. */
function walkProject(root: string, startRel: string, limit = 20_000): WalkEntry[] {
  const start = safeJoin(root, startRel || ".");
  const out: WalkEntry[] = [];
  const stack: string[] = [start];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".env.example") {
        // still allow explicit dotfile patterns later; skip by default
        if (IGNORED_DIRS.has(entry.name)) continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push({ rel: toPosix(relative(root, join(dir, entry.name))), abs: join(dir, entry.name) });
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function globTool(project: string, args: Record<string, unknown>): string {
  const pattern = asString(args.pattern, "pattern");
  const startRel = typeof args.path === "string" ? args.path : ".";
  const maxRaw = args.max_results;
  const max =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(Math.floor(maxRaw), MAX_GLOB_RESULTS)
      : DEFAULT_GLOB_RESULTS;
  const re = globToRegExp(pattern);
  const files = walkProject(project, startRel);
  const matches = files
    .map((f) => f.rel)
    .filter((rel) => re.test(rel))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
  if (matches.length === 0) {
    return `pattern: ${pattern}\n---\n(no files matched ${files.length} scanned)`;
  }
  const truncated = matches.length === max ? "\n… [truncated]" : "";
  return `pattern: ${pattern} (${matches.length} of ${files.length} files)\n---\n${matches.join("\n")}${truncated}`;
}

/* ------------------------------------------------------------------ grep */

function makeMatcher(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    // A non-regex pattern (e.g. `foo(bar`) still works as a literal.
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

export function grepTool(project: string, args: Record<string, unknown>): string {
  const pattern = asString(args.pattern, "pattern");
  const startRel = typeof args.path === "string" ? args.path : ".";
  const include = typeof args.include === "string" && args.include ? globToRegExp(args.include) : null;
  const maxRaw = args.max_results;
  const max =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(Math.floor(maxRaw), MAX_GREP_RESULTS)
      : DEFAULT_GREP_RESULTS;
  const re = makeMatcher(pattern);

  const root = resolve(project);
  const startAbs = safeJoin(root, startRel || ".");
  const stat = lstatSync(startAbs);
  // A directly named file is searched without walking siblings.
  const candidates: WalkEntry[] = stat.isFile()
    ? [{ rel: toPosix(relative(root, startAbs)), abs: startAbs }]
    : walkProject(root, startRel || ".");

  const hits: string[] = [];
  let scanned = 0;
  let skippedOversize = 0;
  for (const file of candidates) {
    if (hits.length >= max) break;
    if (include && !include.test(file.rel)) continue;
    try {
      if (lstatSync(file.abs).size > GREP_MAX_FILE_BYTES) {
        skippedOversize += 1;
        continue;
      }
      const text = readFileSync(file.abs, "utf8");
      if (looksBinary(text)) continue;
      scanned += 1;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) hits.push(`${file.rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
      }
    } catch {
      continue;
    }
  }

  const note = skippedOversize > 0 ? ` (${skippedOversize} file(s) over 1MB skipped)` : "";
  if (hits.length === 0) {
    return `pattern: ${pattern}${note}\n---\n(no matches in ${scanned} files)`;
  }
  const truncated = hits.length >= max ? "\n… [truncated]" : "";
  return `pattern: ${pattern} — ${hits.length} match(es) in ${scanned} files${note}\n---\n${hits.join("\n")}${truncated}`;
}

/* ------------------------------------------------------------- edit_file */

interface EditOp {
  startLine: number;
  endLine: number;
  newText: string;
}

function parseEdits(raw: unknown): EditOp[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "edits must be a non-empty array");
  }
  return raw.map((entry, index) => {
    const op = entry as Record<string, unknown>;
    const startLine = Number(op?.start_line);
    const endLine = Number(op?.end_line);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `edits[${index}]: start_line and end_line must be integers (1-based)`,
      );
    }
    if (typeof op?.new_text !== "string") {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `edits[${index}]: new_text must be a string`);
    }
    return { startLine, endLine, newText: op.new_text };
  });
}

/**
 * Line-anchored, tag-verified edit (ADR-style contract borrowed from the
 * reference app): the caller proves it saw the current content by passing the
 * tag from read_file, then replaces whole line ranges. Ranges are applied
 * bottom-up so earlier line numbers stay valid.
 */
export function editFileTool(project: string, args: Record<string, unknown>): string {
  const rel = asString(args.path, "path");
  const tag = asString(args.tag, "tag").trim().replace(/^#/, "");
  const edits = parseEdits(args.edits);
  const target = safeJoin(project, rel);
  const st = lstatSync(target);
  if (st.isDirectory()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `path is a directory, not a file: ${rel}`);
  }
  const original = readFileSync(target, "utf8");
  const currentTag = contentTag(original);
  if (tag && tag !== currentTag) {
    throw new RpcError(
      ErrorCodes.INVALID_PARAMS,
      `tag mismatch for ${rel}: you passed #${tag} but the file is #${currentTag}. ` +
        "Read the file again and retry with the current tag.",
    );
  }

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = original.endsWith(newline);
  const lines = original.split(/\r?\n/);
  // split() leaves a trailing "" when the file ends with a newline.
  if (hadFinalNewline) lines.pop();
  const total = lines.length;

  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine);
  const applied: string[] = [];
  for (const op of ordered) {
    const { startLine, endLine, newText } = op;
    const insert = endLine === startLine - 1;
    if (startLine < 1 || startLine > total + 1) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `edits: start_line ${startLine} is out of range (file has ${total} lines)`,
      );
    }
    if (!insert && (endLine < startLine || endLine > total)) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `edits: end_line ${endLine} is out of range (file has ${total} lines)`,
      );
    }
    const replacement = newText.length > 0 ? newText.split(/\r?\n/) : [];
    const deleteCount = insert ? 0 : endLine - startLine + 1;
    const before = insert ? lines.slice(0, startLine - 1) : lines.slice(0, startLine - 1);
    const after = insert ? lines.slice(startLine - 1) : lines.slice(endLine);
    lines.length = 0;
    lines.push(...before, ...replacement, ...after);
    applied.push(
      insert
        ? `insert ${replacement.length} line(s) before line ${startLine}`
        : `replace lines ${startLine}-${endLine} with ${replacement.length} line(s)`,
    );
  }

  const next = lines.join(newline) + (hadFinalNewline ? newline : "");
  writeFileSync(target, next, "utf8");
  return [
    `edited ${rel} — ${applied.reverse().join("; ")}`,
    `${total} → ${lines.length} lines, new tag: #${contentTag(next)}`,
  ].join("\n");
}

/** Candidate files for content search, exposed for tests. */
export function searchableFiles(project: string, startRel = "."): string[] {
  return walkProject(project, startRel).map((f) => f.rel);
}

export { IGNORED_DIRS };
