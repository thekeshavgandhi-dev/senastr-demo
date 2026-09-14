/**
 * Composer trigger detection for the "/" and "@" autocomplete menus
 * (parity: pi-desktop `shared/composer-trigger.ts`).
 *
 * Pure string/cursor math so the exact grammar is unit tested away from React
 * and IME timing.
 *
 * Grammar:
 * - "/" opens command mode only as the very first character of the draft,
 *   while the cursor is still inside that first whitespace-free token.
 * - "@" opens file mode when the token containing the cursor starts with "@"
 *   and the character before it is start-of-input, whitespace, or one of the
 *   delimiters (" ' =). A `@"` prefix starts a quoted token that may contain
 *   spaces until its closing quote.
 */

export type ComposerTriggerMode = "slash" | "file";

export interface ComposerTrigger {
  mode: ComposerTriggerMode;
  /** Filter text (after "/" or "@", quotes stripped). */
  query: string;
  /** Index of the trigger character in the draft. */
  tokenStart: number;
  /** End of the replaced region — always the cursor position. */
  tokenEnd: number;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
/** Characters that end the token scan-back. */
const DELIMITERS = new Set([" ", "\t", "\n", "\r", '"', "'", "="]);

/** U+3001 IDEOGRAPHIC COMMA — the mark a Chinese IME gives for "/". */
export const IDEOGRAPHIC_COMMA = "、";

/**
 * A Chinese IME types "、" where an ASCII "/" is meant. The first character of
 * an otherwise short draft is rewritten to "/" so the command menu opens; a
 * mark anywhere later in the draft is text and is left untouched.
 */
export function rewriteIdeographicCommaTrigger(value: string): string {
  return value.startsWith(IDEOGRAPHIC_COMMA) ? `/${value.slice(1)}` : value;
}

function isBoundary(value: string, index: number): boolean {
  if (index <= 0) return true;
  return DELIMITERS.has(value[index - 1]);
}

/** Detect the active autocomplete trigger for a draft + cursor, if any. */
export function detectTrigger(value: string, cursor: number): ComposerTrigger | null {
  if (cursor < 0 || cursor > value.length) return null;

  // Slash mode: draft starts with "/", cursor inside the first token.
  if (value.startsWith("/") && cursor >= 1) {
    const head = value.slice(1, cursor);
    let hasWhitespace = false;
    for (const ch of head) {
      if (WHITESPACE.has(ch)) {
        hasWhitespace = true;
        break;
      }
    }
    if (!hasWhitespace) {
      return { mode: "slash", query: head, tokenStart: 0, tokenEnd: cursor };
    }
  }

  // File mode: scan back from the cursor to the start of the current token.
  let index = cursor - 1;
  let quoted = false;
  while (index >= 0) {
    const ch = value[index];
    if (ch === '"') {
      quoted = true;
      index -= 1;
      break;
    }
    if (DELIMITERS.has(ch)) break;
    index -= 1;
  }
  const tokenStart = index + 1;
  if (tokenStart >= cursor) return null;
  if (value[tokenStart] !== "@") return null;
  if (!quoted && !isBoundary(value, tokenStart)) return null;

  const raw = value.slice(tokenStart + 1, cursor);
  // A quoted token ends at the closing quote; without one we are still typing.
  if (quoted) {
    return {
      mode: "file",
      query: raw.replace(/"$/, ""),
      tokenStart,
      tokenEnd: cursor,
    };
  }
  if (raw.includes('"')) {
    const cut = raw.indexOf('"');
    return { mode: "file", query: raw.slice(0, cut), tokenStart, tokenEnd: cursor };
  }
  return { mode: "file", query: raw, tokenStart, tokenEnd: cursor };
}

/**
 * Replace the active trigger region with the accepted completion. Returns the
 * new draft and the new cursor position.
 */
export function applyCompletion(
  value: string,
  trigger: ComposerTrigger,
  completion: string,
  options: { quoteSpaces?: boolean } = {},
): { value: string; cursor: number } {
  const needsQuote = options.quoteSpaces !== false && /\s/.test(completion);
  const insert = trigger.mode === "slash" ? `/${completion}` : needsQuote ? `@"${completion}"` : `@${completion}`;
  const before = value.slice(0, trigger.tokenStart);
  const after = value.slice(trigger.tokenEnd);
  // Slash commands take an argument, so leave a trailing space; file refs do not.
  const suffix = trigger.mode === "slash" ? " " : after.startsWith(" ") || !after ? "" : "";
  const next = `${before}${insert}${suffix}${after}`;
  return { value: next, cursor: before.length + insert.length + suffix.length };
}

/** Filter + rank file candidates for an "@" query. */
export function rankFileCandidates(
  paths: string[],
  query: string,
  limit = 20,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...paths].sort((a, b) => a.localeCompare(b)).slice(0, limit);
  }
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const direct = lower.indexOf(q);
    let score = Number.NEGATIVE_INFINITY;
    if (direct >= 0) score = 100 - direct - Math.floor(lower.length / 12);
    else if (base.startsWith(q)) score = 90 - Math.floor(base.length / 8);
    else {
      // Subsequence match on the whole path (e.g. "srcidx" → src/index.ts).
      let ti = 0;
      let s = 0;
      let ok = true;
      for (const ch of q) {
        const found = lower.indexOf(ch, ti);
        if (found < 0) {
          ok = false;
          break;
        }
        s += 6 - Math.min(found - ti, 5);
        ti = found + 1;
      }
      if (ok) score = s;
    }
    if (score > Number.NEGATIVE_INFINITY) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}
