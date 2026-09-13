import { join, resolve } from "node:path";
import {
  ErrorCodes,
  RpcError,
  type CapabilityLevel,
  type SubagentInput,
  type SubagentRecord,
} from "@senastr/shared";
import { JsonFileStore } from "./store";

const MAX_PROMPT_CHARS = 32_000;

export interface SubagentQuery {
  level?: CapabilityLevel;
  projectPath?: string;
  enabledOnly?: boolean;
}

/**
 * Named delegate personalities for the Task tool. Mirrors the skill storage
 * shape (global + project records in one JSON document); the runtime
 * resolves the matching definition when a delegation names one.
 */
export class SubagentService {
  private readonly store: JsonFileStore<SubagentRecord[]>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore<SubagentRecord[]>(join(dataDir, "subagents.json"), []);
  }

  list(query: SubagentQuery = {}): SubagentRecord[] {
    const projectPath = normalizeProjectPath(query.projectPath);
    return this.store
      .get()
      .filter((sub) => {
        const level = sub.level ?? "global";
        if (query.level && level !== query.level) return false;
        if (level === "project" && (!projectPath || normalizeProjectPath(sub.projectPath) !== projectPath)) {
          return false;
        }
        if (query.enabledOnly && !sub.enabled) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((sub) => ({ ...sub }));
  }

  active(projectPath?: string | null): SubagentRecord[] {
    return this.list({ projectPath: projectPath ?? undefined, enabledOnly: true });
  }

  set(input: SubagentInput): SubagentRecord {
    const level: CapabilityLevel = input.level === "project" ? "project" : "global";
    const projectPath = level === "project" ? requireProjectPath(input.projectPath) : undefined;
    const name = requireText(input.name, "subagent.name");
    const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt.trim() : "";
    if (!systemPrompt) throw new RpcError(ErrorCodes.INVALID_PARAMS, "subagent system prompt is required");
    if (systemPrompt.length > MAX_PROMPT_CHARS) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `subagent prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    const model =
      input.model && typeof input.model.providerId === "string" && typeof input.model.model === "string"
        ? { providerId: input.model.providerId, model: input.model.model }
        : null;

    const requestedId = input.id?.trim();
    if (requestedId && !/^[a-z0-9][a-z0-9-]*$/.test(requestedId)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "subagent.id must be a kebab-case slug");
    }
    const all = this.store.get();
    const sameOwner = (sub: SubagentRecord) =>
      (sub.level ?? "global") === level &&
      normalizeProjectPath(sub.projectPath) === normalizeProjectPath(projectPath);
    let id = requestedId || slug(name) || "subagent";
    if (!requestedId) {
      const base = id;
      let suffix = 2;
      while (all.some((sub) => sameOwner(sub) && sub.id === id)) id = `${base}-${suffix++}`;
    }
    const index = all.findIndex((sub) => sameOwner(sub) && sub.id === id);
    const now = Date.now();
    const existing = index >= 0 ? all[index] : undefined;
    const record: SubagentRecord = {
      id,
      name,
      description: cleanOptional(input.description),
      systemPrompt,
      model,
      enabled: input.enabled ?? existing?.enabled ?? true,
      level,
      projectPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.update((current) => {
      const found = current.findIndex((sub) => sameOwner(sub) && sub.id === id);
      if (found < 0) return [...current, record];
      const next = [...current];
      next[found] = record;
      return next;
    });
    return { ...record };
  }

  setEnabled(id: string, enabled: boolean, query: SubagentQuery = {}): SubagentRecord {
    return this.patch(id, query, (sub) => ({ ...sub, enabled, updatedAt: Date.now() }));
  }

  delete(id: string, query: SubagentQuery = {}): void {
    const index = this.findIndex(id, query);
    this.store.update((all) => all.filter((_, candidate) => candidate !== index));
  }

  private patch(id: string, query: SubagentQuery, update: (sub: SubagentRecord) => SubagentRecord): SubagentRecord {
    const index = this.findIndex(id, query);
    const next = update(this.store.get()[index]);
    this.store.update((all) => all.map((sub, candidate) => (candidate === index ? next : sub)));
    return { ...next };
  }

  private findIndex(id: string, query: SubagentQuery): number {
    const projectPath = normalizeProjectPath(query.projectPath);
    const index = this.store.get().findIndex((sub) => {
      if (sub.id !== id) return false;
      const level = sub.level ?? "global";
      if (query.level && level !== query.level) return false;
      return level !== "project" || (!!projectPath && normalizeProjectPath(sub.projectPath) === projectPath);
    });
    if (index < 0) throw new RpcError(ErrorCodes.HOST_ERROR, `subagent not found: ${id}`);
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
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "projectPath is required for a project subagent");
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
