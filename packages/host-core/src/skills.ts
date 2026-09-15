import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUILTIN_SKILLS,
  ErrorCodes,
  RpcError,
  type CapabilityLevel,
  type SkillInput,
  type SkillRecord,
  type SkillSource,
} from "@senastr/shared";
import { JsonFileStore } from "./store";
import {
  closest,
  defaultSkillRoots,
  discoverSkillFiles,
  listSkillResources,
  readSkillResource,
} from "./skill-files";

const MAX_SKILL_CHARS = 64_000;

export interface SkillQuery {
  level?: CapabilityLevel;
  projectPath?: string;
  enabledOnly?: boolean;
  /** Restrict to one origin (the Settings UI filters on this). */
  source?: SkillSource;
  /** Set to false to skip filesystem discovery (tests, cheap listings). */
  includeFiles?: boolean;
}

/** Per-id overrides for skills senastr does not own (file-backed ones). */
interface SkillOverrides {
  disabled: Record<string, boolean>;
}

/**
 * User-authored instruction packs, in two flavours:
 *
 *  - **stored** records, edited from the Settings UI and kept in
 *    `skills.json`;
 *  - **file-backed** records discovered from `SKILL.md` directories (the open
 *    Agent Skills layout), re-read on every turn so an editor save takes
 *    effect immediately.
 *
 * The agent runtime receives both as one merged list. Only enabled skills
 * are handed over, and only their metadata goes into the prompt — see
 * `packages/agent-runtime` for the progressive-disclosure half of this.
 */
export class SkillService {
  private readonly store: JsonFileStore<SkillRecord[]>;
  private readonly overrides: JsonFileStore<SkillOverrides>;

  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await this.store.flush();
    await this.overrides.flush();
  }

  constructor(
    private readonly dataDir: string,
    private readonly homeDir: string = homedir(),
  ) {
    this.store = new JsonFileStore<SkillRecord[]>(join(dataDir, "skills.json"), []);
    this.overrides = new JsonFileStore<SkillOverrides>(join(dataDir, "skill-overrides.json"), { disabled: {} });
  }

  list(query: SkillQuery = {}): SkillRecord[] {
    const projectPath = normalizeProjectPath(query.projectPath);
    const stored = this.store
      .get()
      .filter((skill) => {
        const level = skill.level ?? "global";
        if (query.level && level !== query.level) return false;
        if (level === "project" && (!projectPath || normalizeProjectPath(skill.projectPath) !== projectPath)) {
          return false;
        }
        if (query.enabledOnly && !skill.enabled) return false;
        return true;
      })
      .map((skill) => ({ ...skill, source: (skill.source ?? "user") as SkillSource }));

    const files = query.includeFiles === false ? [] : this.discover(projectPath);
    const disabled = this.overrides.get().disabled ?? {};
    const fileRecords = files
      .filter((skill) => {
        if (query.level && (skill.level ?? "global") !== query.level) return false;
        if (query.enabledOnly && (disabled[skill.id] || !skill.enabled)) return false;
        return true;
      })
      .map((skill) => ({ ...skill, enabled: !disabled[skill.id] && skill.enabled }));

    // Project file skills shadow global ones; stored records win over both so
    // a user edit always takes effect.
    const merged = new Map<string, SkillRecord>();
    for (const skill of [...fileRecords, ...stored]) {
      const existing = merged.get(skill.id);
      if (existing && rank(existing) > rank(skill)) continue;
      merged.set(skill.id, skill);
    }

    return [...merged.values()]
      .filter((skill) => !query.source || (skill.source ?? "user") === query.source)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({ ...skill }));
  }

  active(projectPath?: string | null): SkillRecord[] {
    return this.list({ projectPath: projectPath ?? undefined, enabledOnly: true });
  }

  /**
   * Skill metadata for the system prompt. File skills are refreshed here so a
   * newly dropped-in SKILL.md is visible on the very next turn.
   */
  discover(projectPath?: string | null): SkillRecord[] {
    const roots = defaultSkillRoots({
      projectPath,
      dataDir: this.dataDir,
      homeDir: this.homeDir,
    });
    return discoverSkillFiles(roots);
  }

  /** Look up one skill by id or name across stored, file and builtin sets. */
  getById(id: string, projectPath?: string | null): SkillRecord | undefined {
    const wanted = id.trim().toLowerCase();
    if (!wanted) return undefined;
    const pool = [...this.list({ projectPath: projectPath ?? undefined }), ...BUILTIN_SKILLS];
    return (
      pool.find((skill) => skill.id.toLowerCase() === wanted) ??
      pool.find((skill) => skill.name.toLowerCase() === wanted)
    );
  }

  /** Read a bundled file from a file-backed skill. */
  readResource(id: string, resourcePath: string, projectPath?: string | null): string {
    const record = this.getById(id, projectPath);
    if (!record) {
      const suggestion = closest(id, this.list({ projectPath: projectPath ?? undefined }).map((s) => s.id));
      throw new RpcError(
        ErrorCodes.HOST_ERROR,
        `skill not found: ${id}${suggestion ? ` — did you mean "${suggestion}"?` : ""}`,
      );
    }
    if (!record.dirPath) {
      throw new RpcError(ErrorCodes.HOST_ERROR, `skill "${record.name}" has no bundled resources`);
    }
    return readSkillResource({ dirPath: record.dirPath, resources: record.resources ?? [] }, resourcePath);
  }

  /** Resources of a skill, recomputed from disk for file-backed skills. */
  resources(id: string, projectPath?: string | null): SkillRecord["resources"] {
    const record = this.getById(id, projectPath);
    if (!record) return [];
    if (record.dirPath) return listSkillResources(record.dirPath, record.filePath);
    return record.resources ?? [];
  }

  set(input: SkillInput): SkillRecord {
    const level: CapabilityLevel = input.level === "project" ? "project" : "global";
    const projectPath = level === "project" ? requireProjectPath(input.projectPath) : undefined;
    const name = requireText(input.name, "skill.name");
    const content = typeof input.content === "string" ? input.content : "";
    if (!content.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, "skill instructions are required");
    if (content.length > MAX_SKILL_CHARS) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `skill instructions exceed ${MAX_SKILL_CHARS} characters`);
    }

    const requestedId = input.id?.trim();
    if (requestedId && !/^[a-z0-9][a-z0-9-]*$/.test(requestedId)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "skill.id must be a kebab-case slug");
    }
    const all = this.store.get();
    const sameOwner = (skill: SkillRecord) =>
      (skill.level ?? "global") === level &&
      normalizeProjectPath(skill.projectPath) === normalizeProjectPath(projectPath);
    let id = requestedId || slug(name) || "skill";
    if (!requestedId) {
      const base = id;
      let suffix = 2;
      while (all.some((skill) => sameOwner(skill) && skill.id === id)) id = `${base}-${suffix++}`;
    }
    const index = all.findIndex((skill) => sameOwner(skill) && skill.id === id);
    const now = Date.now();
    const existing = index >= 0 ? all[index] : undefined;
    const record: SkillRecord = {
      id,
      name,
      description: cleanOptional(input.description),
      content,
      enabled: input.enabled ?? existing?.enabled ?? true,
      level,
      projectPath,
      source: "user",
      triggers: input.triggers,
      allowedTools: input.allowedTools,
      always: input.always,
      version: input.version,
      license: input.license,
      size: content.length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.update((current) => {
      const found = current.findIndex((skill) => sameOwner(skill) && skill.id === id);
      if (found < 0) return [...current, record];
      const next = [...current];
      next[found] = record;
      return next;
    });
    return { ...record };
  }

  setEnabled(id: string, enabled: boolean, query: SkillQuery = {}): SkillRecord {
    const projectPath = normalizeProjectPath(query.projectPath);
    const stored = this.store.get();
    const index = stored.findIndex((skill) => matches(skill, id, query, projectPath));
    if (index >= 0) {
      const next = { ...stored[index], enabled, updatedAt: Date.now() };
      this.store.update((all) => all.map((skill, candidate) => (candidate === index ? next : skill)));
      return { ...next };
    }
    // File-backed skill: persist an override so the toggle survives restarts.
    const file = this.discover(projectPath).find((skill) => skill.id === id);
    if (!file) throw new RpcError(ErrorCodes.HOST_ERROR, `skill not found: ${id}`);
    this.overrides.update((current) => {
      const disabled = { ...(current.disabled ?? {}) };
      if (enabled) delete disabled[id];
      else disabled[id] = true;
      return { disabled };
    });
    return { ...file, enabled };
  }

  delete(id: string, query: SkillQuery = {}): void {
    const projectPath = normalizeProjectPath(query.projectPath);
    const index = this.store.get().findIndex((skill) => matches(skill, id, query, projectPath));
    if (index >= 0) {
      this.store.update((all) => all.filter((_, candidate) => candidate !== index));
      return;
    }
    const file = this.discover(projectPath).find((skill) => skill.id === id);
    if (file) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `"${file.name}" is a file-backed skill — delete ${file.filePath ?? file.dirPath} (or disable it) instead`,
      );
    }
    throw new RpcError(ErrorCodes.HOST_ERROR, `skill not found: ${id}`);
  }

  private findIndex(id: string, query: SkillQuery): number {
    const projectPath = normalizeProjectPath(query.projectPath);
    const index = this.store.get().findIndex((skill) => matches(skill, id, query, projectPath));
    if (index < 0) throw new RpcError(ErrorCodes.HOST_ERROR, `skill not found: ${id}`);
    return index;
  }
}

function matches(skill: SkillRecord, id: string, query: SkillQuery, projectPath?: string): boolean {
  if (skill.id !== id) return false;
  const level = skill.level ?? "global";
  if (query.level && level !== query.level) return false;
  return level !== "project" || (!!projectPath && normalizeProjectPath(skill.projectPath) === projectPath);
}

/** Precedence: stored (user-editable) > project file > global file. */
function rank(skill: SkillRecord): number {
  if (skill.source === "user") return 0;
  if (skill.level === "project") return 1;
  return 2;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${label} is required`);
  }
  return value.trim();
}

function cleanOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireProjectPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "projectPath is required for a project skill");
  }
  return resolve(value);
}

function normalizeProjectPath(value?: string | null): string | undefined {
  return typeof value === "string" && value.trim() ? resolve(value) : undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54);
}
