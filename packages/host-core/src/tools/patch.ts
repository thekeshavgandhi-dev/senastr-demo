import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { ErrorCodes, RpcError } from "@senastr/shared";
import { contentTag, safeJoin } from "./fs";

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} must be a string`);
  }
  return value;
}

/**
 * Fuzzy search-and-replace tool.
 *
 * Finds `old_text` in the target file and replaces it with `new_text`.
 * Tolerates minor indentation/whitespace variations when exact match fails.
 */
export function patchFileTool(project: string, args: Record<string, unknown>): string {
  const rel = asString(args.path, "path");
  const oldText = asString(args.old_text, "old_text");
  const newText = asString(args.new_text, "new_text");
  const expectedOccurrences =
    typeof args.expected_occurrences === "number" && Number.isInteger(args.expected_occurrences) && args.expected_occurrences > 0
      ? args.expected_occurrences
      : 1;

  if (!oldText) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "old_text cannot be empty");
  }

  const target = safeJoin(project, rel);
  const st = lstatSync(target);
  if (st.isDirectory()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `path is a directory, not a file: ${rel}`);
  }

  const original = readFileSync(target, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = original.endsWith(newline);

  // 1. Exact replacement attempt
  const exactParts = original.split(oldText);
  const exactCount = exactParts.length - 1;

  if (exactCount === expectedOccurrences) {
    const next = exactParts.join(newText);
    writeFileSync(target, next, "utf8");
    return [
      `patched ${rel} — replaced ${exactCount} occurrence(s)`,
      `new tag: #${contentTag(next)}`,
    ].join("\n");
  }

  if (exactCount > expectedOccurrences) {
    throw new RpcError(
      ErrorCodes.INVALID_PARAMS,
      `found ${exactCount} occurrences of old_text in ${rel} (expected ${expectedOccurrences}). ` +
        "Include more surrounding context in old_text to make it unique.",
    );
  }

  // 2. Line-trimmed / fuzzy replacement attempt
  const origLines = original.split(/\r?\n/);
  if (hadFinalNewline && origLines[origLines.length - 1] === "") {
    origLines.pop();
  }

  const searchLines = oldText.split(/\r?\n/).map((l) => l.trim()).filter((l, idx, arr) => l || (idx > 0 && idx < arr.length - 1));
  if (searchLines.length === 0) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "old_text has no non-whitespace lines");
  }

  const matches: Array<{ start: number; end: number; indent: string }> = [];

  for (let i = 0; i <= origLines.length - searchLines.length; i++) {
    let match = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (origLines[i + j].trim() !== searchLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const firstLine = origLines[i];
      const indentMatch = firstLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : "";
      matches.push({ start: i, end: i + searchLines.length, indent });
    }
  }

  if (matches.length === 0) {
    // Provide diagnostic context with nearest matching line if possible
    const firstSearch = searchLines[0];
    const candidateIdx = origLines.findIndex((l) => l.includes(firstSearch) || l.trim() === firstSearch);
    const hint =
      candidateIdx >= 0
        ? ` Note: line ${candidateIdx + 1} looks similar: "${origLines[candidateIdx].trim().slice(0, 80)}"`
        : "";
    throw new RpcError(
      ErrorCodes.INVALID_PARAMS,
      `could not find old_text in ${rel}.${hint} Check the exact content using read_file.`,
    );
  }

  if (matches.length > expectedOccurrences) {
    throw new RpcError(
      ErrorCodes.INVALID_PARAMS,
      `fuzzy matching found ${matches.length} occurrences in ${rel} (expected ${expectedOccurrences}). ` +
        "Include more surrounding context in old_text.",
    );
  }

  // Apply fuzzy replacements bottom-up
  const sortedMatches = [...matches].sort((a, b) => b.start - a.start);
  for (const m of sortedMatches) {
    const replacementRawLines = newText.length > 0 ? newText.split(/\r?\n/) : [];
    // If replacement has multiple lines, adjust indentation relative to original first line
    const replacementLines = replacementRawLines.map((line, idx) => {
      if (idx === 0) return m.indent + line.trimStart();
      if (!line.trim()) return "";
      return line.startsWith(" ") || line.startsWith("\t") ? line : m.indent + line;
    });
    origLines.splice(m.start, m.end - m.start, ...replacementLines);
  }

  const next = origLines.join(newline) + (hadFinalNewline ? newline : "");
  writeFileSync(target, next, "utf8");
  return [
    `patched ${rel} (fuzzy match) — replaced ${matches.length} occurrence(s)`,
    `new tag: #${contentTag(next)}`,
  ].join("\n");
}
