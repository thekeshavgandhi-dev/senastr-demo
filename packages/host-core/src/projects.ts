import { randomUUID } from "node:crypto";
import { ErrorCodes, RpcError, type ProjectGroup, type ProjectGroupInput, type ProjectInput, type ProjectRecord } from "@senastr/shared";
import { JsonFileStore } from "./store";

interface ProjectsState {
  projects: ProjectRecord[];
  groups: ProjectGroup[];
}

/**
 * Project registry + project groups (parity: pi-desktop `project/list`,
 * `project/add`, `project/update`, `project-group/*`).
 *
 * Sessions already carry their own `projectPath`; this record keeps the
 * workspace-level view durable: display names, ordering, pins and groups.
 */
export class ProjectService {
  private readonly store: JsonFileStore<ProjectsState>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore<ProjectsState>(`${dataDir}/projects.json`, {
      projects: [],
      groups: [],
    });
    this.store.update((state) => ({
      projects: Array.isArray(state?.projects) ? sanitizeProjects(state.projects) : [],
      groups: Array.isArray(state?.groups) ? state.groups.filter(isGroup) : [],
    }));
  }

  list(): ProjectsState {
    const state = this.store.get();
    return {
      projects: [...state.projects].sort(
        (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastOpenedAt - a.lastOpenedAt,
      ),
      groups: [...state.groups].sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  add(input: ProjectInput): ProjectRecord {
    const path = normalizePath(input?.path);
    const now = Date.now();
    const existing = this.store.get().projects.find((p) => p.path === path);
    if (existing) {
      return this.update({ ...existing, ...input, path });
    }
    const record: ProjectRecord = {
      path,
      name: input.name?.trim() || undefined,
      addedAt: now,
      lastOpenedAt: now,
      pinned: Boolean(input.pinned),
      groupId: input.groupId ?? undefined,
    };
    this.store.update((state) => ({ ...state, projects: [...state.projects, record] }));
    return record;
  }

  update(input: ProjectInput): ProjectRecord {
    const path = normalizePath(input?.path);
    let updated: ProjectRecord | null = null;
    this.store.update((state) => {
      const projects = state.projects.map((project) => {
        if (project.path !== path) return project;
        updated = {
          ...project,
          name: input.name !== undefined ? input.name.trim() || undefined : project.name,
          pinned: input.pinned !== undefined ? Boolean(input.pinned) : project.pinned,
          groupId:
            input.groupId === undefined
              ? project.groupId
              : input.groupId === null || input.groupId === ""
                ? undefined
                : String(input.groupId),
          lastOpenedAt: Date.now(),
        };
        return updated;
      });
      if (!updated) {
        // Add is the natural fallback for an unknown path (the UI calls this
        // after the folder picker, before any list refresh).
        updated = {
          path,
          name: input.name?.trim() || undefined,
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
          pinned: Boolean(input.pinned),
          groupId: input.groupId ?? undefined,
        };
        projects.push(updated);
      }
      return { ...state, projects };
    });
    return updated as unknown as ProjectRecord;
  }

  remove(path: string): void {
    const target = normalizePath(path);
    this.store.update((state) => ({
      ...state,
      projects: state.projects.filter((p) => p.path !== target),
    }));
  }

  setGroup(input: ProjectGroupInput): ProjectGroup {
    const name = (input?.name ?? "").trim();
    if (!name) throw new RpcError(ErrorCodes.INVALID_PARAMS, "group name is required");
    if (input.id) {
      let updated: ProjectGroup | null = null;
      this.store.update((state) => {
        const groups = state.groups.map((group) => {
          if (group.id !== input.id) return group;
          updated = { ...group, name };
          return updated;
        });
        return { ...state, groups };
      });
      if (!updated) throw new RpcError(ErrorCodes.INVALID_PARAMS, `unknown project group: ${input.id}`);
      return updated;
    }
    const group: ProjectGroup = { id: randomUUID(), name, createdAt: Date.now() };
    this.store.update((state) => ({ ...state, groups: [...state.groups, group] }));
    return group;
  }

  deleteGroup(id: string): void {
    this.store.update((state) => ({
      groups: state.groups.filter((g) => g.id !== id),
      projects: state.projects.map((p) => (p.groupId === id ? { ...p, groupId: undefined } : p)),
    }));
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}

function normalizePath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) throw new RpcError(ErrorCodes.INVALID_PARAMS, "project path is required");
  return path;
}

function sanitizeProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return projects
    .filter((p) => p && typeof p.path === "string" && p.path)
    .map((p) => ({
      path: p.path,
      name: p.name,
      addedAt: typeof p.addedAt === "number" ? p.addedAt : Date.now(),
      lastOpenedAt: typeof p.lastOpenedAt === "number" ? p.lastOpenedAt : Date.now(),
      pinned: Boolean(p.pinned),
      groupId: p.groupId,
      sessionCount: p.sessionCount,
    }));
}

function isGroup(value: unknown): value is ProjectGroup {
  return Boolean(value) && typeof (value as ProjectGroup).id === "string" && typeof (value as ProjectGroup).name === "string";
}
