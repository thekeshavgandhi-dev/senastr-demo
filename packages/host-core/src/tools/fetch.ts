import { ErrorCodes, RpcError } from "@senastr/shared";

const DEFAULT_MAX_CHARS = 50_000;
const MAX_FETCH_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 15_000;

export async function webFetchTool(args: Record<string, unknown>): Promise<string> {
  const urlStr = typeof args.url === "string" ? args.url.trim() : "";
  if (!urlStr) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid URL: ${urlStr}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "only HTTP and HTTPS URLs are supported");
  }

  const maxRaw = args.max_chars;
  const max =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(Math.floor(maxRaw), MAX_FETCH_CHARS)
      : DEFAULT_MAX_CHARS;

  const format = typeof args.format === "string" ? args.format.toLowerCase() : "auto";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        "User-Agent": "senastr-agent/1.0 (Arena AI Coding Agent; +https://arena.ai)",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    const rawText = await res.text();

    let output = rawText;

    if (contentType.includes("application/json") || format === "json") {
      try {
        const parsedJson = JSON.parse(rawText);
        output = JSON.stringify(parsedJson, null, 2);
      } catch {
        output = rawText;
      }
    } else if (contentType.includes("text/html") || format === "markdown") {
      output = htmlToMarkdown(rawText);
    }

    const truncated = output.length > max;
    if (truncated) {
      output = output.slice(0, max) + "\n… [content truncated]";
    }

    return `URL: ${urlStr} (HTTP ${res.status})\n---\n${output}`;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new RpcError(ErrorCodes.INTERNAL_ERROR, `fetch request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new RpcError(ErrorCodes.INTERNAL_ERROR, `failed to fetch URL: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Lightweight HTML to markdown converter */
function htmlToMarkdown(html: string): string {
  return html
    // Remove scripts and styles
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    // Headers
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n")
    // Paragraphs and breaks
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    // Lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    // Code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    // Links
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    // Strip other HTML tags
    .replace(/<[^>]+>/g, " ")
    // Decode common HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up excessive whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
