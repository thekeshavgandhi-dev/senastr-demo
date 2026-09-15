import type {
  AppNotification,
  AskAnswers,
  ChatMessage,
  DelegationSummary,
  GitInfo,
  GrantScope,
  McpServerInput,
  McpServerStatus,
  McpServerSummary,
  PermissionGrant,
  PermissionRequest,
  ProjectContext,
  ProviderConfig,
  ProviderDiscoveryInput,
  ProviderSummary,
  ProviderTestResult,
  PullSummary,
  ReviewSnapshot,
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
  Session,
  SessionMeta,
  SessionMode,
  SkillInput,
  SkillRecord,
  SubagentInput,
  SubagentRecord,
  ToolResult,
  Usage,
} from "@senastr/shared";
import type { SenastrApi, SenastrEvent } from "../types";

/**
 * QA harness: a complete in-memory stand-in for the Electron main process +
 * host-core sidecar. It implements the full `SenastrApi` bridge surface with
 * the same observable behavior (masked providers, grants, snapshots,
 * transcript appends), and lets tests drive the live event stream the way
 * the real agent runtime does.
 *
 * Every method records its calls so tests can assert exactly what the UI
 * sent over the wire ("each and every button must reach a backend").
 */

let seq = 0;
export const nextId = (prefix: string): string => `${prefix}-${++seq}`;

export interface ChatSendCall {
  sessionId: string;
  text: string;
  modelRef: { providerId: string; model: string };
  mode?: SessionMode;
}

export class FakeBackend implements SenastrApi {
  readonly sessions = new Map<string, Session>();
  readonly providers = new Map<string, ProviderConfig>();
  readonly skills: SkillRecord[] = [];
  readonly subagents: SubagentRecord[] = [];
  readonly mcpServers: McpServerSummary[] = [];
  readonly plugins = new Map<string, { name: string; version: string; enabled: boolean; tools: string[]; description?: string }>();
  readonly tasks = new Map<string, ScheduledTask>();
  readonly runs = new Map<string, ScheduledRun[]>();
  readonly snapshots = new Map<string, ReviewSnapshot[]>();
  readonly grants: PermissionGrant[] = [];
  readonly notifications: AppNotification[] = [];
  readonly instructions = new Map<string, ProjectContext>();

  readonly chatSends: ChatSendCall[] = [];
  readonly openExternalCalls: string[] = [];
  readonly rolledBack: Array<{ sessionId: string; snapshotId: string }> = [];
  readonly resolvedAsks: Array<{ requestId: string; answers: AskAnswers }> = [];
  readonly permissionResponses: Array<{ requestId: string; allow: boolean; remember?: GrantScope | null }> = [];
  readonly stoppedSessions: string[] = [];
  readonly enhanceCalls: Array<{ text: string; modelRef: { providerId: string; model: string } }> = [];
  readonly suggestTitleCalls: Array<{ excerpt: string; modelRef: { providerId: string; model: string } }> = [];

  /** Directory picker / file picker results, popped per call. */
  pickDirectoryResult: string | null = "/plugins/fake";
  installUrlResult: string | null = null;
  filePickResult: string[] = [];
  projectOpenResult: string | null = null;
  /** Result for the next provider.discoverModels call. */
  discoverResult: ProviderTestResult = { ok: true, detail: "connected — 2 models reported", models: ["m-1", "m-2"] };
  /** Result for the next mcp.test call. */
  mcpTestResult: McpServerStatus = { serverId: "", state: "ready", toolCount: 3, updatedAt: Date.now() };

  /** Session turn bookkeeping used by turn/auto-title flows. */
  turnNumber = 0;

  private listeners = new Set<(ev: SenastrEvent) => void>();

  /* ---------------------------------------------------------------- */
  /* event stream (main → renderer)                                    */
  /* ---------------------------------------------------------------- */

  onEvent(cb: (ev: SenastrEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(ev: SenastrEvent): void {
    for (const cb of [...this.listeners]) cb(ev);
  }

  /** Simulate a full assistant turn: user message lands, streams, persists, ends. */
  async runTurn(sessionId: string, reply: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    this.emit({ type: "turn/start", sessionId, turnId: nextId("turn") });
    for (const delta of reply.match(/.{1,12}/g) ?? []) {
      this.emit({ type: "assistant/delta", delta });
    }
    await this.append(sessionId, { role: "assistant", content: reply });
    this.emit({ type: "turn/end", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } });
  }

  /* ---------------------------------------------------------------- */
  /* app / project / file                                              */
  /* ---------------------------------------------------------------- */

  readonly app = {
    version: async () => "0.1.0",
    dataDir: async () => "/tmp/fake-data",
    openExternal: async (url: string) => {
      this.openExternalCalls.push(url);
    },
  };

  readonly project = {
    open: async () => {
      const result = this.projectOpenResult;
      this.projectOpenResult = null;
      return result;
    },
  };

  readonly file = {
    pick: async () => {
      const result = this.filePickResult;
      this.filePickResult = [];
      return result;
    },
  };

  /* ---------------------------------------------------------------- */
  /* sessions                                                          */
  /* ---------------------------------------------------------------- */

  private touch(session: Session): void {
    session.updatedAt = Date.now();
  }

  readonly session = {
    list: async (): Promise<SessionMeta[]> =>
      [...this.sessions.values()]
        .map((s): SessionMeta => ({
          id: s.id,
          title: s.title,
          projectPath: s.projectPath,
          mode: s.mode,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    create: async (params: { title?: string; projectPath?: string | null } = {}) => {
      const now = Date.now();
      const session: Session = {
        id: nextId("sess"),
        title: params.title?.trim() || "New session",
        projectPath: params.projectPath ?? null,
        mode: "build",
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        messages: [],
      };
      this.sessions.set(session.id, session);
      return session;
    },
    get: async (id: string) => {
      const found = this.sessions.get(id);
      if (!found) throw new Error(`rpc -32005: session not found: ${id}`);
      return found;
    },
    rename: async (id: string, title: string) => {
      const found = await this.session.get(id);
      found.title = title.trim() || found.title;
      this.touch(found);
      return found;
    },
    delete: async (id: string) => {
      this.sessions.delete(id);
      return { ok: true };
    },
    setProject: async (id: string, projectPath: string | null) => {
      const found = await this.session.get(id);
      found.projectPath = projectPath;
      this.touch(found);
      return found;
    },
    setMode: async (id: string, mode: SessionMode) => {
      const found = await this.session.get(id);
      if (mode !== "build" && mode !== "plan") throw new Error("rpc -32602: invalid session mode");
      found.mode = mode;
      this.touch(found);
      return found;
    },
    appendMessages: async (id: string, messages: ChatMessage[]) => {
      const found = await this.session.get(id);
      found.messages.push(...messages);
      found.messageCount = found.messages.length;
      this.touch(found);
      return found;
    },
  };

  /** Append a persisted transcript message (the way the runtime does). */
  async append(sessionId: string, msg: Partial<ChatMessage> & { role: ChatMessage["role"]; content: string }): Promise<ChatMessage> {
    const full: ChatMessage = {
      id: nextId("msg"),
      createdAt: Date.now(),
      ...msg,
    };
    await this.session.appendMessages(sessionId, [full]);
    return full;
  }

  /* ---------------------------------------------------------------- */
  /* providers                                                         */
  /* ---------------------------------------------------------------- */

  /** Renderer-safe provider summary, mirroring host-core's maskProvider. */
  private summarize(p: ProviderConfig): ProviderSummary {
    return {
      id: p.id,
      kind: p.kind,
      vendorKey: p.vendorKey,
      label: p.label,
      baseUrl: p.baseUrl,
      hasApiKey: Boolean(p.apiKeys?.length),
      apiKeyCount: p.apiKeys?.length ?? 0,
      apiStyle: p.apiStyle ?? "chat_completions",
      headers: p.headers ? Object.fromEntries(Object.keys(p.headers).map((k) => [k, "••••••"])) : undefined,
      rateLimitPerMin: p.rateLimitPerMin,
      models: p.models,
      defaultModel: p.defaultModel ?? p.models[0],
      enabled: p.enabled !== false,
    };
  }

  readonly provider = {
    list: async () => [...this.providers.values()].map((p) => this.summarize(p)),
    set: async (provider: ProviderConfig) => {
      if (!provider.id) throw new Error("rpc -32602: provider.id must be a slug");
      if (!provider.models?.length) throw new Error("rpc -32602: select or add at least one model");
      this.providers.set(provider.id, { ...provider });
      return this.summarize(this.providers.get(provider.id)!);
    },
    delete: async (id: string) => {
      this.providers.delete(id);
      return { ok: true };
    },
    test: async (id: string) => {
      if (!this.providers.has(id)) throw new Error(`rpc -32007: provider not found: ${id}`);
      return this.discoverResult;
    },
    discoverModels: async (input: ProviderDiscoveryInput) => {
      if (!input.baseUrl && !this.providers.has(input.id ?? "")) {
        return { ok: false, detail: "base URL required" };
      }
      return this.discoverResult;
    },
  };

  /* ---------------------------------------------------------------- */
  /* capabilities: skills / subagents / mcp / plugins                   */
  /* ---------------------------------------------------------------- */

  readonly skill = {
    list: async () => [...this.skills],
    set: async (skill: SkillInput) => {
      if (!skill.name?.trim()) throw new Error("rpc -32602: skill.name is required");
      if (!skill.content?.trim()) throw new Error("rpc -32602: skill instructions are required");
      const now = Date.now();
      const existing = this.skills.findIndex((s) => s.id === skill.id);
      const record: SkillRecord = existing >= 0
        ? { ...this.skills[existing], ...skill, updatedAt: now }
        : {
            id: skill.id?.trim() || nextId("skill"),
            name: skill.name.trim(),
            description: skill.description,
            content: skill.content,
            enabled: skill.enabled ?? true,
            level: skill.level ?? "global",
            projectPath: skill.projectPath,
            createdAt: now,
            updatedAt: now,
          };
      if (existing >= 0) this.skills[existing] = record;
      else this.skills.push(record);
      return record;
    },
    delete: async (params: { id: string }) => {
      const idx = this.skills.findIndex((s) => s.id === params.id);
      if (idx < 0) throw new Error(`rpc -32000: skill not found: ${params.id}`);
      this.skills.splice(idx, 1);
      return { ok: true };
    },
    setEnabled: async (params: { id: string; enabled: boolean }) => {
      const found = this.skills.find((s) => s.id === params.id);
      if (!found) throw new Error(`rpc -32000: skill not found: ${params.id}`);
      found.enabled = params.enabled;
      return found;
    },
  };

  readonly subagent = {
    list: async () => [...this.subagents],
    set: async (subagent: SubagentInput) => {
      if (!subagent.name?.trim()) throw new Error("rpc -32602: subagent.name is required");
      if (!subagent.systemPrompt?.trim()) throw new Error("rpc -32602: subagent system prompt is required");
      const now = Date.now();
      const existing = this.subagents.findIndex((s) => s.id === subagent.id);
      const record: SubagentRecord = existing >= 0
        ? { ...this.subagents[existing], ...subagent, updatedAt: now }
        : {
            id: subagent.id?.trim() || nextId("sub"),
            name: subagent.name.trim(),
            description: subagent.description,
            systemPrompt: subagent.systemPrompt,
            model: subagent.model ?? null,
            enabled: subagent.enabled ?? true,
            level: subagent.level ?? "global",
            projectPath: subagent.projectPath,
            createdAt: now,
            updatedAt: now,
          };
      if (existing >= 0) this.subagents[existing] = record;
      else this.subagents.push(record);
      return record;
    },
    delete: async (params: { id: string }) => {
      const idx = this.subagents.findIndex((s) => s.id === params.id);
      if (idx < 0) throw new Error(`rpc -32000: subagent not found: ${params.id}`);
      this.subagents.splice(idx, 1);
      return { ok: true };
    },
    setEnabled: async (params: { id: string; enabled: boolean }) => {
      const found = this.subagents.find((s) => s.id === params.id);
      if (!found) throw new Error(`rpc -32000: subagent not found: ${params.id}`);
      found.enabled = params.enabled;
      return found;
    },
  };

  readonly mcp = {
    list: async () => ({
      servers: this.mcpServers.map((s) => ({ ...s })),
      statuses: this.mcpServers.map(
        (s): McpServerStatus => ({ serverId: s.id, state: "idle", toolCount: 0, updatedAt: 0 }),
      ),
    }),
    set: async (server: McpServerInput) => {
      if (!server.id?.trim()) throw new Error("rpc -32602: server.id is required");
      const existing = this.mcpServers.findIndex((s) => s.id === server.id);
      const record: McpServerSummary = existing >= 0
        ? { ...this.mcpServers[existing], ...server } as McpServerSummary
        : {
            id: server.id,
            label: server.label ?? server.id,
            description: server.description,
            transport: server.transport ?? "stdio",
            command: server.command,
            args: server.args,
            env: server.env,
            url: server.url,
            headers: server.headers,
            level: server.level ?? "global",
            projectPath: server.projectPath,
            enabled: server.enabled ?? true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          } as McpServerSummary;
      if (existing >= 0) this.mcpServers[existing] = record;
      else this.mcpServers.push(record);
      return record;
    },
    delete: async (params: { id: string }) => {
      const idx = this.mcpServers.findIndex((s) => s.id === params.id);
      if (idx < 0) throw new Error(`rpc -32000: MCP server not found: ${params.id}`);
      this.mcpServers.splice(idx, 1);
      return { ok: true };
    },
    setEnabled: async (params: { id: string; enabled: boolean }) => {
      const found = this.mcpServers.find((s) => s.id === params.id);
      if (!found) throw new Error(`rpc -32000: MCP server not found: ${params.id}`);
      found.enabled = params.enabled;
      return found;
    },
    test: async (params: { id: string }) => {
      if (!this.mcpServers.some((s) => s.id === params.id)) {
        throw new Error(`rpc -32000: MCP server not found: ${params.id}`);
      }
      return { ...this.mcpTestResult, serverId: params.id, updatedAt: Date.now() };
    },
  };

  readonly plugin = {
    list: async () =>
      [...this.plugins.values()].map((p) => ({
        name: p.name,
        version: p.version,
        description: p.description,
        author: undefined,
        tools: p.tools,
        permissions: undefined,
        enabled: p.enabled,
        installedAt: Date.now(),
      })),
    pickDirectory: async () => this.pickDirectoryResult,
    install: async (dir: string) => {
      const name = dir.split("/").filter(Boolean).pop() ?? "plugin";
      if (!dir.endsWith("/valid")) throw new Error("rpc -32008: missing senastr.plugin.json");
      const info = { name, version: "1.0.0", enabled: true, tools: ["greet"], description: "fake plugin" };
      this.plugins.set(name, info);
      return { ...info, author: undefined, permissions: undefined, installedAt: Date.now() };
    },
    installUrl: async (url: string) => {
      if (this.installUrlResult === null) throw new Error(`rpc -32008: git clone failed: ${url}`);
      const name = "url-plugin";
      const info = { name, version: "0.2.0", enabled: true, tools: [], description: "from url" };
      this.plugins.set(name, info);
      return { ...info, author: undefined, permissions: undefined, installedAt: Date.now() };
    },
    uninstall: async (name: string) => {
      if (!this.plugins.delete(name)) throw new Error(`rpc -32008: plugin not installed: ${name}`);
      return { ok: true };
    },
    setEnabled: async (name: string, enabled: boolean) => {
      const found = this.plugins.get(name);
      if (!found) throw new Error(`rpc -32008: plugin not installed: ${name}`);
      found.enabled = enabled;
      return { ...found, author: undefined, permissions: undefined, installedAt: Date.now() };
    },
  };

  /* ---------------------------------------------------------------- */
  /* scheduled                                                         */
  /* ---------------------------------------------------------------- */

  readonly scheduled = {
    list: async () => [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    set: async (task: ScheduledTaskInput) => {
      if (!task.title?.trim()) throw new Error("rpc -32602: task.title is required");
      if (!task.prompt?.trim()) throw new Error("rpc -32602: task.prompt is required");
      const id = task.id?.trim() || nextId("task");
      const now = Date.now();
      const existing = this.tasks.get(id);
      const record: ScheduledTask = {
        id,
        title: task.title,
        prompt: task.prompt,
        projectPath: task.projectPath ?? "",
        providerId: task.providerId ?? "p1",
        model: task.model ?? "m-1",
        cadence: task.cadence ?? "manual",
        cron: task.cron,
        enabled: task.enabled ?? existing?.enabled ?? true,
        sessionId: existing?.sessionId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastRunAt: existing?.lastRunAt,
        lastStatus: existing?.lastStatus,
        nextRunAt: undefined,
      };
      this.tasks.set(id, record);
      return record;
    },
    delete: async (id: string) => {
      this.tasks.delete(id);
      this.runs.delete(id);
      return { ok: true };
    },
    setEnabled: async (id: string, enabled: boolean) => {
      const found = this.tasks.get(id);
      if (!found) throw new Error(`rpc -32000: scheduled task not found: ${id}`);
      found.enabled = enabled;
      found.updatedAt = Date.now();
      return found;
    },
    runs: async (params: { taskId: string }) => [...(this.runs.get(params.taskId) ?? [])],
    trigger: async (id: string) => {
      if (!this.tasks.has(id)) throw new Error(`rpc -32000: scheduled task not found: ${id}`);
      return { ok: true };
    },
  };

  recordRun(taskId: string, run: Omit<ScheduledRun, "id" | "taskId">): ScheduledRun {
    const full: ScheduledRun = { ...run, taskId, id: nextId("run") };
    const all = this.runs.get(taskId) ?? [];
    all.push(full);
    this.runs.set(taskId, all);
    const task = this.tasks.get(taskId);
    if (task) {
      task.lastRunAt = full.startedAt;
      task.lastStatus = full.status;
    }
    return full;
  }

  /* ---------------------------------------------------------------- */
  /* review / project context / permissions / notify                    */
  /* ---------------------------------------------------------------- */

  readonly review = {
    list: async (sessionId: string) => [...(this.snapshots.get(sessionId) ?? [])],
    get: async (params: { sessionId: string; snapshotId: string }) => {
      const found = (this.snapshots.get(params.sessionId) ?? []).find((s) => s.id === params.snapshotId);
      if (!found) throw new Error(`rpc -32000: review snapshot not found: ${params.snapshotId}`);
      return found;
    },
    rollback: async (params: { sessionId: string; snapshotId: string }) => {
      const snap = await this.review.get(params);
      this.rolledBack.push(params);
      if (snap.before === null) {
        // "delete file" rollback — drop the snapshot list entry like the real purge path does not, but keep behavior simple
      } else {
        snap.after = snap.before;
      }
      return { ok: true, output: `rolled back ${snap.path}` };
    },
    purge: async (sessionId: string) => {
      this.snapshots.delete(sessionId);
      return { ok: true };
    },
  };

  addSnapshot(sessionId: string, snap: Omit<ReviewSnapshot, "id">): ReviewSnapshot {
    const full: ReviewSnapshot = { ...snap, id: nextId("snap") };
    const all = this.snapshots.get(sessionId) ?? [];
    all.push(full);
    this.snapshots.set(sessionId, all);
    return full;
  }

  /** In-memory durable memory store, mirroring host-core's layout. */
  private readonly memoryStore = new Map<string, string>();

  readonly memory = {
    list: async (params?: { projectPath?: string | null; scope?: string }) => {
      const scopes = params?.scope ? [params.scope] : ["project", "global"];
      return scopes.map((scope) => ({
        scope: scope as "project" | "global",
        dir: `/fake/memory/${scope}`,
        index: "",
        entries: [...this.memoryStore.entries()].map(([key, content], i) => ({
          key,
          target: "topic" as const,
          scope: scope as "project" | "global",
          content,
          summary: content.split("\n")[0] ?? "",
          updatedAt: Date.now() + i,
          size: content.length,
        })),
        size: 0,
      }));
    },
    search: async (params: { query: string }) => {
      const q = (params.query ?? "").toLowerCase();
      return [...this.memoryStore.entries()]
        .filter(([key, content]) => key.toLowerCase().includes(q) || content.toLowerCase().includes(q))
        .map(([key, content]) => ({
          key,
          target: "topic" as const,
          scope: "project" as const,
          excerpt: content.slice(0, 120),
          score: 1,
          updatedAt: Date.now(),
        }));
    },
    read: async (params: { key: string }) => {
      const content = this.memoryStore.get(params.key);
      return {
        entry: content
          ? { key: params.key, target: "topic" as const, scope: "project" as const, content, updatedAt: Date.now(), size: content.length }
          : null,
      };
    },
    write: async (params: { key: string; content: string; mode?: string }) => {
      const previous = this.memoryStore.get(params.key) ?? "";
      const next = params.mode === "append" && previous ? `${previous}\n${params.content}` : params.content;
      this.memoryStore.set(params.key, next);
      return {
        entry: {
          key: params.key,
          target: "topic" as const,
          scope: "project" as const,
          content: next,
          updatedAt: Date.now(),
          size: next.length,
        },
        index: "",
      };
    },
    forget: async (params: { key: string }) => ({ removed: this.memoryStore.delete(params.key) }),
  };

  readonly projectCtx = {
    getContext: async (projectPath?: string | null) => {
      const key = projectPath?.trim() ? projectPath : "";
      return (
        this.instructions.get(key) ?? {
          projectPath: projectPath ? projectPath : null,
          instructions: "",
          memory: "",
          updatedAt: 0,
        }
      );
    },
    setContext: async (input: { projectPath?: string | null; instructions?: string; memory?: string }) => {
      const key = input.projectPath?.trim() ? input.projectPath : "";
      const record: ProjectContext = {
        projectPath: input.projectPath ?? null,
        instructions: input.instructions ?? "",
        memory: input.memory ?? "",
        updatedAt: Date.now(),
      };
      this.instructions.set(key, record);
      return record;
    },
    gitInfo: async (projectPath: string): Promise<GitInfo> => {
      if (!projectPath || projectPath === "/does/not/exist") {
        return { branch: null, dirty: 0, error: "not a git repository" };
      }
      return { branch: "main", dirty: 2 };
    },
    prList: async (projectPath: string): Promise<{ prs: PullSummary[]; error?: string }> => {
      if (projectPath === "/nogit") return { prs: [], error: "GitHub CLI (gh) is not installed or not on PATH" };
      return {
        prs: [
          { number: 7, title: "Add retry logic", url: "https://github.com/acme/repo/pull/7", author: "ada", headRefName: "feat/retry", baseRefName: "main", isDraft: false },
          { number: 9, title: "Draft: docs", url: "https://github.com/acme/repo/pull/9", isDraft: true },
        ],
      };
    },
  };

  readonly permission = {
    list: async () => [...this.grants],
    clear: async (params: { sessionId?: string; tool?: string }) => {
      for (let i = this.grants.length - 1; i >= 0; i--) {
        const g = this.grants[i];
        if (params.tool && g.tool !== params.tool) continue;
        if (params.sessionId && g.sessionId !== params.sessionId) continue;
        this.grants.splice(i, 1);
      }
      return { ok: true };
    },
    respond: async (params: { requestId: string; allow: boolean; remember?: GrantScope | null }) => {
      this.permissionResponses.push({ ...params });
      if (params.allow && params.remember) {
        this.grants.push({
          sessionId: params.remember === "always" ? null : "sess-active",
          tool: "run_command",
          scope: params.remember,
          createdAt: Date.now(),
        });
      }
      return { handled: true };
    },
  };

  readonly notify = {
    list: async () => [...this.notifications],
    markRead: async (params: { id?: string; all?: boolean }) => {
      for (const n of this.notifications) {
        if (params.all || n.id === params.id) n.read = true;
      }
      return { ok: true };
    },
    clear: async () => {
      this.notifications.length = 0;
      return { ok: true };
    },
  };

  /* ---------------------------------------------------------------- */
  /* chat                                                              */
  /* ---------------------------------------------------------------- */

  readonly chat = {
    send: async (params: { sessionId: string; text: string; modelRef: { providerId: string; model: string }; mode?: SessionMode }) => {
      if (!this.sessions.has(params.sessionId)) throw new Error(`rpc -32005: session not found: ${params.sessionId}`);
      this.chatSends.push({ ...params });
      // The real main process applies the mode with the send.
      if (params.mode) await this.session.setMode(params.sessionId, params.mode);
      // ...and the runtime appends the user message at turn/start.
      await this.append(params.sessionId, { role: "user", content: params.text });
      return { ok: true };
    },
    stop: async (sessionId: string) => {
      this.stoppedSessions.push(sessionId);
      return true;
    },
    resolveAsk: async (requestId: string, answers: AskAnswers) => {
      this.resolvedAsks.push({ requestId, answers });
      return true;
    },
    delegations: async (sessionId: string): Promise<DelegationSummary[]> => this.delegationsBySession[sessionId] ?? [],
    enhance: async (params: { text: string; modelRef: { providerId: string; model: string } }) => {
      this.enhanceCalls.push(params);
      return { text: `Enhanced: ${params.text}`, usage: { inputTokens: 3, outputTokens: 4 } as Usage };
    },
    suggestTitle: async (params: { modelRef: { providerId: string; model: string }; excerpt: string }) => {
      this.suggestTitleCalls.push(params);
      return { title: "AI generated title" };
    },
  };

  delegationsBySession: Record<string, DelegationSummary[]> = {};

  /** Push a delegation record like subagent/start events do. */
  emitDelegation(sessionId: string, delegation: DelegationSummary): void {
    this.delegationsBySession[sessionId] = [
      ...(this.delegationsBySession[sessionId] ?? []).filter((d) => d.id !== delegation.id),
      delegation,
    ];
    this.emit({ type: "subagent/start", sessionId, delegation: { ...delegation } });
  }

  /** Simulate a write tool call inside a live turn (tool rows + results). */
  emitToolCall(callName: string, args: Record<string, unknown>, result?: ToolResult): { id: string } {
    const call = { id: nextId("call"), name: callName, arguments: args };
    this.emit({ type: "tool/call", call });
    const res: ToolResult = result ?? { ok: true, output: "done", durationMs: 12 };
    this.emit({ type: "tool/result", callId: call.id, ok: res.ok, result: res });
    return call;
  }

  /** Push a notification the way the main process does. */
  pushNotification(n: Omit<AppNotification, "id" | "createdAt" | "read">): AppNotification {
    const item: AppNotification = { id: nextId("note"), createdAt: Date.now(), read: false, ...n };
    this.notifications.unshift(item);
    this.emit({ kind: "notify/added", notification: item });
    return item;
  }
}
