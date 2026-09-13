import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { ErrorCodes, RpcError } from "@senastr/shared";

export const DEFAULT_MAX_CHARS = 100_000;
export const MAX_READ_CHARS = 1_000_000;
export const MAX_LIST_ENTRIES = 500;

/** Every tool is confined to the session's project root. */
export function resolveProjectPath(project: string | null): string {
  if (!project) {
    throw new RpcError(ErrorCodes.INTERNAL_ERROR, "session has no project set — open a project first");
  }
  return resolve(project);
}

/**
 * Join `rel` onto the project root and refuse anything that escapes it
 * (`..`, absolute paths, symlink-free lexical check).
 */
export function safeJoin(project: string, rel: string): string {
  const root = resolve(project);
  const target = resolve(root, rel || ".");
  if (target !== root && !target.startsWith(root + sep)) {
    throw new RpcError(ErrorCodes.PATH_ESCAPES_PROJECT, `path escapes the project root: ${rel}`);
  }
  return target;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} must be a string`);
  }
  return value;
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
  let text = readFileSync(target, "utf8");
  if (text.length > max) {
    text = `${text.slice(0, max)}\n… [truncated at ${max} characters]`;
  }
  return `path: ${rel}\n---\n${text}`;
}

export function writeFileTool(project: string, args: Record<string, unknown>): string {
  const rel = asString(args.path, "path");
  const content = asString(args.content, "content");
  const target = safeJoin(project, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`;
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
