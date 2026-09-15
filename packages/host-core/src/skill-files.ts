import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type { CapabilityLevel, SkillRecord, SkillResource } from "@senastr/shared";

/**
 * Filesystem skill discovery.
 *
 * senastr reads skills in the open Agent Skills layout, so a skill authored
 * for another agent works here unchanged:
 *
 * ```
 * <skills-root>/<skill-id>/SKILL.md      # frontmatter + instructions
 *                        /references/…   # loaded on demand
 *                        /scripts/…      # runnable helpers
 *                        /assets/…       # templates
 * ```
 *
 * Discovery roots, highest precedence last:
 *   project : .senastr/skills  ·  .claude/skills  ·  .agents/skills
 *   global  : <dataDir>/skills ·  ~/.claude/skills
 *
 * File skills are read-only as far as senastr is concerned: the user edits
 * them with an editor, and they are re-read on every turn.
 */

const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_RESOURCES = 60;
const RESOURCE_MAX_DEPTH = 3;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

export interface SkillRoot {
  dir: string;
  level: CapabilityLevel;
  projectPath?: string;
  /** Shown in the UI so the user knows where a skill came from. */
  origin: string;
}

export interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Minimal YAML frontmatter parser — the subset the Agent Skills spec uses:
 * `key: value`, quoted values, inline arrays `[a, b]`, and `- item` blocks.
 * Deliberately dependency-free; unknown shapes degrade to strings.
 */
export function parseFrontmatter(raw: string): ParsedSkillFile {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim() !== "---") return { frontmatter: {}, body: raw };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") {
      end = i;
      break;
    }
  }
  // No closing delimiter: it was not frontmatter after all.
  if (end < 0) return { frontmatter: {}, body: raw };

  const frontmatter: Record<string, string> = {};
  let currentKey: string | null = null;
  const listItems: string[] = [];

  const flush = () => {
    if (currentKey && listItems.length) frontmatter[currentKey] = listItems.join(", ");
    listItems.length = 0;
    currentKey = null;
  };

  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && currentKey) {
      listItems.push(unquote(item[1].trim()));
      continue;
    }
    flush();
    const match = line.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (value === "" || value === "|" || value === ">") {
      currentKey = key;
      continue;
    }
    frontmatter[key] = unquote(value);
  }
  flush();

  return { frontmatter, body: lines.slice(end + 1).join("\n").replace(/^\s*\n/, "") };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  // Inline YAML arrays: `[a, b, c]` → "a, b, c".
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).trim();
  }
  if (trimmed.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  }
  return value;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function toBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["true", "yes", "on"].includes(v)) return true;
  if (["false", "no", "off"].includes(v)) return false;
  return undefined;
}

/** Read one skill from a `SKILL.md` (or any Markdown) file on disk. */
export function readSkillDocument(
  filePath: string,
  root: SkillRoot,
  fallbackId: string,
): SkillRecord | null {
  let raw: string;
  let stat;
  try {
    stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return null;
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  const name = frontmatter.name?.trim() || fallbackId;
  const id = slug(frontmatter.name?.trim() || fallbackId) || slug(fallbackId) || "skill";
  const content = body.trim();
  const dirPath = frontmatter.name || basename(filePath) === "SKILL.md" ? dirnameOf(filePath) : dirnameOf(filePath);

  return {
    id,
    name,
    description: frontmatter.description?.trim() || firstMeaningfulLine(content) || undefined,
    content,
    enabled: toBool(frontmatter.enabled ?? frontmatter["disable-model-invocation"]) !== true,
    level: root.level,
    projectPath: root.projectPath,
    source: root.level === "project" ? "project-file" : "global-file",
    dirPath,
    filePath,
    always: toBool(frontmatter.always ?? frontmatter.alwaysapply) === true,
    triggers: splitList(frontmatter.triggers),
    allowedTools: splitList(frontmatter["allowed-tools"] ?? frontmatter.allowedtools),
    version: frontmatter.version,
    license: frontmatter.license,
    frontmatter,
    size: content.length,
    createdAt: stat.mtimeMs,
    updatedAt: stat.mtimeMs,
  };
}

function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : p;
}

function firstMeaningfulLine(markdown: string): string | undefined {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed && !trimmed.startsWith("<!--")) return trimmed.slice(0, 240);
  }
  return undefined;
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54);
}

/**
 * Bundle files shipped alongside a skill. They are the third level of
 * progressive disclosure: listed in the skill body, read only on request.
 */
export function listSkillResources(dirPath: string | undefined, excludeFile?: string): SkillResource[] {
  if (!dirPath) return [];
  const out: SkillResource[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > RESOURCE_MAX_DEPTH || out.length >= MAX_RESOURCES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_RESOURCES) return;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk(full, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (full === excludeFile) continue;
      let size: number | undefined;
      try {
        size = statSync(full).size;
      } catch {
        size = undefined;
      }
      out.push({ path: rel.split("\\").join("/"), size });
    }
  };
  walk(dirPath, "", 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Scan one skills root: every sub-directory with a SKILL.md, plus loose `.md` files. */
function scanRoot(root: SkillRoot): SkillRecord[] {
  const out: SkillRecord[] = [];
  let entries;
  try {
    entries = readdirSync(root.dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = join(root.dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const doc = join(full, "SKILL.md");
      const record = fileExists(doc)
        ? readSkillDocument(doc, root, entry.name)
        : // Also accept `my-skill.md` as the entry point (single-file skills).
          readSkillDocument(join(full, `${entry.name}.md`), root, entry.name);
      if (!record) continue;
      // Later roots override earlier ones only on identical ids; the caller
      // handles precedence, here we just collect.
      out.push({ ...record, resources: listSkillResources(record.dirPath, record.filePath) });
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      const id = slug(basename(entry.name, ".md"));
      const record = readSkillDocument(full, root, id);
      if (!record) continue;
      out.push({ ...record, resources: listSkillResources(dirnameOf(full), full) });
    }
  }
  return out;
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * All file-backed skills visible for a project, project-level first then
 * global, de-duplicated by id (project wins).
 */
export function discoverSkillFiles(roots: SkillRoot[]): SkillRecord[] {
  const byId = new Map<string, SkillRecord & { origin: string }>();
  for (const root of roots) {
    for (const record of scanRoot(root)) {
      const key = record.id;
      const existing = byId.get(key);
      // Project skills beat global ones; within a level, first root wins.
      if (existing && existing.level === "project" && record.level === "global") continue;
      if (existing) continue;
      byId.set(key, { ...record, origin: root.origin } as SkillRecord & { origin: string });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The standard discovery roots for a project + the user's global directories. */
export function defaultSkillRoots(opts: {
  projectPath?: string | null;
  dataDir: string;
  homeDir: string;
}): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const projectPath = opts.projectPath ? resolve(opts.projectPath) : null;
  if (projectPath) {
    for (const sub of [".senastr/skills", ".claude/skills", ".agents/skills"]) {
      roots.push({ dir: join(projectPath, sub), level: "project", projectPath, origin: sub });
    }
  }
  roots.push({ dir: join(opts.dataDir, "skills"), level: "global", origin: "~/.senastr/skills" });
  roots.push({ dir: join(opts.homeDir, ".claude", "skills"), level: "global", origin: "~/.claude/skills" });
  return roots;
}

/** Safe read of a bundled resource, confined to the skill directory. */
export function readSkillResource(
  record: Pick<SkillRecord, "dirPath" | "resources">,
  resourcePath: string,
  maxChars = 60_000,
): string {
  if (!record.dirPath) {
    throw new Error("this skill has no bundled directory");
  }
  const rel = String(resourcePath ?? "").trim().replace(/^(\.\.[/\\])+/, "");
  if (!rel) throw new Error("resource path is required");
  const allowed = (record.resources ?? []).map((r) => r.path);
  const match = allowed.find((p) => p === rel || p.toLowerCase() === rel.toLowerCase());
  if (!match) {
    const suggestion = suggestResource(rel, allowed);
    throw new Error(
      `no such resource in this skill: ${rel}${suggestion ? ` — did you mean "${suggestion}"?` : ""}`,
    );
  }
  const abs = resolve(record.dirPath, match);
  const root = resolve(record.dirPath);
  if (abs !== root && !abs.startsWith(root + "/") && !abs.startsWith(root + "\\")) {
    throw new Error("resource path escapes the skill directory");
  }
  const raw = readFileSync(abs, "utf8");
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n\n… [truncated — ${raw.length - maxChars} more characters]`;
}

/**
 * Suggest the resource the caller probably meant.
 *
 * Paths are long and shared prefixes are the norm (`references/api.md` vs
 * `references/api-guide.md`), so a fixed small distance would never fire.
 * Scale the tolerance with the path length and prefer a basename match.
 */
export function suggestResource(target: string, candidates: string[]): string | undefined {
  if (!candidates.length) return undefined;
  const base = target.split("/").pop() ?? target;
  const byBase = candidates.find((c) => (c.split("/").pop() ?? c).toLowerCase() === base.toLowerCase());
  if (byBase) return byBase;

  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const candidateBase = candidate.split("/").pop() ?? candidate;
    const score = Math.min(
      levenshtein(base.toLowerCase(), candidateBase.toLowerCase(), 12),
      levenshtein(target.toLowerCase(), candidate.toLowerCase(), 12),
    );
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= Math.max(6, Math.floor(target.length / 2)) ? best : undefined;
}

/** Cheap Levenshtein neighbour, used for "did you mean" hints. */
export function closest(target: string, candidates: string[], maxDistance = 4): string | undefined {
  if (!candidates.length) return undefined;
  const a = target.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const b = candidate.toLowerCase();
    if (Math.abs(a.length - b.length) > maxDistance) continue;
    const distance = levenshtein(a, b, maxDistance);
    if (distance < bestScore) {
      bestScore = distance;
      best = candidate;
    }
  }
  return bestScore <= maxDistance ? best : undefined;
}

export function levenshtein(a: string, b: string, cap = 6): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return rowMin;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export { relative };
