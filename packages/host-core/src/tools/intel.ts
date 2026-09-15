import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ErrorCodes, RpcError } from "@senastr/shared";
import { IGNORED_DIRS, safeJoin } from "./fs";

const MAX_INTEL_RESULTS = 200;
const DEFAULT_INTEL_RESULTS = 50;
const INTEL_MAX_FILE_BYTES = 1_000_000;

interface SymbolMatch {
  file: string;
  line: number;
  kind: string;
  name: string;
  signature: string;
}

const SYMBOL_PATTERNS = [
  // TypeScript / JavaScript
  { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\*?\s+([a-zA-Z0-9_$]+)/ },
  { kind: "class", regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/ },
  { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/ },
  { kind: "type", regex: /^\s*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)/ },
  { kind: "variable", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*[:=]/ },
  { kind: "export", regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|var|enum)\s+([a-zA-Z0-9_$]+)/ },
  // Python
  { kind: "class", regex: /^\s*class\s+([a-zA-Z0-9_]+)(?:\(.*?\))?:/ },
  { kind: "function", regex: /^\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/ },
  // Rust
  { kind: "function", regex: /^\s*(?:pub(?:\(.*?\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/ },
  { kind: "type", regex: /^\s*(?:pub(?:\(.*?\))?\s+)?(?:struct|enum|trait|type)\s+([a-zA-Z0-9_]+)/ },
  // Go
  { kind: "function", regex: /^\s*func\s+(?:\(.*?\)\s+)?([a-zA-Z0-9_]+)\s*\(/ },
  { kind: "type", regex: /^\s*type\s+([a-zA-Z0-9_]+)\s+(?:struct|interface)/ },
];

export function codeIntelTool(project: string, args: Record<string, unknown>): string {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "query must be a non-empty string");
  }

  const startRel = typeof args.path === "string" ? args.path : ".";
  const kindFilter = typeof args.kind === "string" ? args.kind.toLowerCase() : "all";
  const maxRaw = args.max_results;
  const max =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(Math.floor(maxRaw), MAX_INTEL_RESULTS)
      : DEFAULT_INTEL_RESULTS;

  const root = resolve(project);
  const startAbs = safeJoin(root, startRel || ".");
  const queryRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const stat = lstatSync(startAbs);
  const candidateFiles = stat.isFile()
    ? [startAbs]
    : getCodeFiles(root, startRel);

  const results: SymbolMatch[] = [];

  for (const abs of candidateFiles) {
    if (results.length >= max) break;
    try {
      if (lstatSync(abs).size > INTEL_MAX_FILE_BYTES) continue;
      const content = readFileSync(abs, "utf8");
      const rel = relative(root, abs).split("\\").join("/");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= max) break;
        const line = lines[i];
        for (const pattern of SYMBOL_PATTERNS) {
          if (kindFilter !== "all") {
            if (kindFilter === "export" && !line.includes("export")) continue;
            if (kindFilter !== "export" && pattern.kind !== kindFilter) continue;
          }
          const match = line.match(pattern.regex);
          if (match && match[1]) {
            const symbolName = match[1];
            if (queryRegex.test(symbolName) || queryRegex.test(line)) {
              results.push({
                file: rel,
                line: i + 1,
                kind: pattern.kind,
                name: symbolName,
                signature: line.trim().slice(0, 200),
              });
              break;
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  if (results.length === 0) {
    return `code_intel query: "${query}"\n---\n(no symbol definitions found)`;
  }

  const formatted = results.map(
    (r) => `${r.file}:${r.line} [${r.kind}] ${r.name} → ${r.signature}`,
  );
  const truncated = results.length >= max ? "\n… [truncated]" : "";
  return `code_intel query: "${query}" (${results.length} symbols found)\n---\n${formatted.join("\n")}${truncated}`;
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
]);

function getCodeFiles(root: string, startRel: string): string[] {
  const start = safeJoin(root, startRel || ".");
  const out: string[] = [];
  const stack: string[] = [start];

  while (stack.length > 0 && out.length < 5000) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}
