import { join, resolve } from "node:path";
import {
  ErrorCodes,
  RpcError,
  type CapabilityLevel,
  type SkillInput,
  type SkillRecord,
} from "@senastr/shared";
import { JsonFileStore } from "./store";

const MAX_SKILL_CHARS = 64_000;

export interface SkillQuery {
  level?: CapabilityLevel;
  projectPath?: string;
  enabledOnly?: boolean;
}

/** User-authored instruction packs. They are deliberately plain records: the
 * runtime receives only enabled skills that match the current project and
 * appends their Markdown to the system prompt. */
export class SkillService {
  private readonly store: JsonFileStore<SkillRecord[]>;

  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  constructor(dataDir: string) {
    this.store = new JsonFileStore<SkillRecord[]>(join(dataDir, "skills.json"), []);
  }

  list(query: SkillQuery = {}): SkillRecord[] {
    const projectPath = normalizeProjectPath(query.projectPath);
    return this.store
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
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({ ...skill }));
  }

  active(projectPath?: string | null): SkillRecord[] {
    return this.list({ projectPath: projectPath ?? undefined, enabledOnly: true });
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
    return this.patch(id, query, (skill) => ({ ...skill, enabled, updatedAt: Date.now() }));
  }

  delete(id: string, query: SkillQuery = {}): void {
    const index = this.findIndex(id, query);
    this.store.update((all) => all.filter((_, candidate) => candidate !== index));
  }

  private patch(id: string, query: SkillQuery, update: (skill: SkillRecord) => SkillRecord): SkillRecord {
    const index = this.findIndex(id, query);
    const next = update(this.store.get()[index]);
    this.store.update((all) => all.map((skill, candidate) => (candidate === index ? next : skill)));
    return { ...next };
  }

  private findIndex(id: string, query: SkillQuery): number {
    const projectPath = normalizeProjectPath(query.projectPath);
    const index = this.store.get().findIndex((skill) => {
      if (skill.id !== id) return false;
      const level = skill.level ?? "global";
      if (query.level && level !== query.level) return false;
      return level !== "project" || (!!projectPath && normalizeProjectPath(skill.projectPath) === projectPath);
    });
    if (index < 0) throw new RpcError(ErrorCodes.HOST_ERROR, `skill not found: ${id}`);
    return index;
  }
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
