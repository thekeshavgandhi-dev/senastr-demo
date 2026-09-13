import { memo, useMemo, useState, type ReactNode } from "react";
import { IconCheck, IconCopy } from "./icons";

/**
 * Dependency-free markdown renderer for chat transcripts.
 * Supports fenced code (with copy), headings, bold/italic/strike, inline
 * code, links, blockquotes, lists, tables, hr and paragraphs.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Block {
  kind:
    | "code"
    | "heading"
    | "quote"
    | "ul"
    | "ol"
    | "table"
    | "hr"
    | "para";
  lang?: string;
  text: string;
  level?: number;
  items?: string[];
  head?: string[];
  rows?: string[][];
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      const mark = fence[1][0];
      const len = fence[1].length;
      const lang = fence[2] || "";
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^${mark}{${len},}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      blocks.push({ kind: "code", lang, text: buf.join("\n") });
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }
    // hr
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      blocks.push({ kind: "hr", text: "" });
      i += 1;
      continue;
    }
    // quote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }
    // table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const head = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", text: "", head, rows });
      continue;
    }
    // lists
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
        if (!m) break;
        const mOrdered = /\d/.test(m[2]);
        if (mOrdered !== ordered) break;
        items.push(m[3]);
        i += 1;
        // continuation lines (indented)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+/)) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ kind: ordered ? "ol" : "ul", text: "", items });
      continue;
    }
    // blank
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // paragraph (collect until blank)
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s+|```|~~~|\s*>\s?|(\s*)([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
      !/^\s*([-*_]\s*){3,}$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "para", text: buf.join("\n") });
  }
  return blocks;
}

/** Inline spans: code, bold, italic, strike, links. Rendered via placeholders. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  // tokenize inline code first
  const tokens: Array<{ t: "text" | "code"; v: string }> = [];
  let rest = text;
  while (rest) {
    const m = rest.match(/^(.*?)`([^`\n]+)`(.*)$/s);
    if (!m) {
      tokens.push({ t: "text", v: rest });
      break;
    }
    if (m[1]) tokens.push({ t: "text", v: m[1] });
    tokens.push({ t: "code", v: m[2] });
    rest = m[3];
  }
  let k = 0;
  for (const tok of tokens) {
    if (tok.t === "code") {
      parts.push(
        <code key={`${keyPrefix}-${k++}`} className="md-code">
          {tok.v}
        </code>,
      );
      continue;
    }
    // links [text](url)
    const segs = tok.v.split(/(\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\))/g);
    for (const seg of segs) {
      const lm = seg.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
      if (lm) {
        parts.push(
          <a key={`${keyPrefix}-${k++}`} href={lm[2]} target="_blank" rel="noreferrer" className="md-link">
            {formatStrong(lm[1], `${keyPrefix}-${k++}`)}
          </a>,
        );
        continue;
      }
      // autolinks
      const auto = seg.split(/(https?:\/\/[^\s<>"')]+)/g);
      for (const a of auto) {
        if (/^https?:\/\//.test(a)) {
          parts.push(
            <a key={`${keyPrefix}-${k++}`} href={a} target="_blank" rel="noreferrer" className="md-link">
              {a}
            </a>,
          );
        } else if (a) {
          const nodes = formatStrong(a, `${keyPrefix}-${k++}`);
          parts.push(<span key={`${keyPrefix}-s${k++}`}>{nodes}</span>);
        }
      }
    }
  }
  return parts;
}

function formatStrong(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if ((tok.startsWith("**") && tok.endsWith("**")) || (tok.startsWith("__") && tok.endsWith("__"))) {
      out.push(<strong key={`${keyPrefix}-${k++}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<del key={`${keyPrefix}-${k++}`}>{tok.slice(2, -2)}</del>);
    } else {
      out.push(<em key={`${keyPrefix}-${k++}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  // preserve single newlines inside paragraphs
  const result: ReactNode[] = [];
  out.forEach((node, idx) => {
    if (typeof node !== "string") {
      result.push(node);
      return;
    }
    node.split("\n").forEach((line, li) => {
      if (li > 0) result.push(<br key={`${keyPrefix}-br-${idx}-${li}`} />);
      result.push(line);
    });
  });
  return result;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar">
        <span>{lang || "code"}</span>
        <button type="button" className="md-copy" onClick={() => void copy()} title="Copy code">
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlight(escapeHtml(text), lang) }} />
      </pre>
    </div>
  );
}

/** Tiny keyword highlighter — no deps, safe on escaped HTML. */
function highlight(escaped: string, lang: string): string {
  // comments
  let out = escaped;
  const commentRe =
    lang === "py" || lang === "python" || lang === "sh" || lang === "bash" || lang === "yaml" || lang === "yml"
      ? /(#[^\n]*)/g
      : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
  out = out.replace(commentRe, "<span class='tok-com'>$1</span>");
  // strings (rough)
  out = out.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|'[^'\n]*'|&quot;[^&]*?&quot;)/g, "<span class='tok-str'>$1</span>");
  // keywords
  out = out.replace(
    /\b(const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|await|async|try|catch|throw|switch|case|break|continue|interface|type|extends|implements|public|private|protected|static|def|None|True|False|pass|lambda|with|as|in|is|not|and|or|fn|let|mut|struct|enum|impl|match|use|mod|pub|self|None|Some|Ok|Err)\b/g,
    "<span class='tok-kw'>$1</span>",
  );
  // numbers
  out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, "<span class='tok-num'>$1</span>");
  return out;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "code":
            return <CodeBlock key={i} lang={b.lang || ""} text={b.text} />;
          case "heading": {
            const Tag = `h${Math.min(b.level || 1, 4)}` as "h1" | "h2" | "h3" | "h4";
            return <Tag key={i}>{renderInline(b.text, `h${i}`)}</Tag>;
          }
          case "quote":
            return (
              <blockquote key={i}>
                <Markdown text={b.text} />
              </blockquote>
            );
          case "ul":
            return (
              <ul key={i}>
                {(b.items || []).map((it, j) => (
                  <li key={j}>{renderInline(it, `ul${i}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {(b.items || []).map((it, j) => (
                  <li key={j}>{renderInline(it, `ol${i}-${j}`)}</li>
                ))}
              </ol>
            );
          case "table":
            return (
              <div key={i} className="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {(b.head || []).map((c, j) => (
                        <th key={j}>{renderInline(c, `th${i}-${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(b.rows || []).map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, j) => (
                          <td key={j}>{renderInline(c, `td${i}-${ri}-${j}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={i} />;
          default:
            return <p key={i}>{renderInline(b.text, `p${i}`)}</p>;
        }
      })}
    </div>
  );
});
