import type {
  AgentEvent,
  AppNotification,
  AppSettings,
  CommandItem,
  ExternalAgentSource,
  ExternalSessionSummary,
  FileIndexResult,
  ImportRunResult,
  ImportScanResult,
  MessageAttachment,
  AskAnswers,
  AskRequest,
  CapabilityLevel,
  ChatMessage,
  DelegationSummary,
  GitInfo,
  GrantScope,
  McpServerInput,
  McpServerStatus,
  MemoryEntry,
  MemoryIndex,
  MemoryScope,
  MemorySearchHit,
  McpServerSummary,
  PermissionGrant,
  PermissionRequest,
  PlanProposal,
  PluginInfo,
  ProjectContext,
  ProviderConfig,
  ProviderDiscoveryInput,
  ProviderSummary,
  ProviderTestResult,
  ProjectGroup,
  ProjectRecord,
  PullSummary,
  ReviewSnapshot,
  ScratchInfo,
  SessionRevision,
  ThinkingLevel,
  TokenUsageHistory,
  UpdateState,
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
  Session,
  SessionMode,
  SkillInput,
  SkillRecord,
  SessionMeta,
  SubagentInput,
  SubagentRecord,
  Usage,
} from "@senastr/shared";

export interface SenastrModelRef {
  providerId: string;
  model: string;
}

export type SenastrEvent =
  | AgentEvent
  | { kind: "permission/requested"; request: PermissionRequest }
  | { kind: "notify/added"; notification: AppNotification }
  | { kind: "scheduled/started"; taskId: string; name: string }
  | { kind: "scheduled/finished"; taskId: string; status: string; sessionId?: string; error?: string }
  | { kind: "updates/state"; state: UpdateState }
  | { kind: "tray/new-task" };

export interface SenastrApi {
  app: {
    version(): Promise<string>;
    dataDir(): Promise<string>;
    openExternal(url: string): Promise<void>;
  };
  project: {
    open(): Promise<string | null>;
    list(): Promise<{ projects: ProjectRecord[]; groups: ProjectGroup[] }>;
    add(params: { path: string; name?: string; pinned?: boolean; groupId?: string }): Promise<ProjectRecord>;
    update(params: {
      path: string;
      name?: string;
      pinned?: boolean;
      groupId?: string | null;
    }): Promise<ProjectRecord>;
    remove(path: string): Promise<{ ok: boolean }>;
    groupList(): Promise<ProjectGroup[]>;
    groupSet(params: { id?: string; name: string }): Promise<ProjectGroup>;
    groupDelete(id: string): Promise<{ ok: boolean }>;
  };
  stats: {
    usage(query?: { startDate?: number; endDate?: number; bucket?: "day" | "week" | "month"; sessionId?: string }): Promise<TokenUsageHistory>;
    recordUsage(params: unknown): Promise<unknown>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  fs: {
    index(params: { projectPath: string; force?: boolean; limit?: number }): Promise<FileIndexResult>;
  };
  command: {
    list(query?: { query?: string; limit?: number }): Promise<{ commands: CommandItem[]; total: number }>;
  };
  updates: {
    getState(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    install(): Promise<UpdateState>;
    openReleases(): Promise<{ ok: boolean }>;
  };
  clipboard: {
    recordPaste(text: string): Promise<{ ok: boolean; entries: number }>;
    list(): Promise<Array<{ id: string; text: string; createdAt: number; bytes: number }>>;
    clear(): Promise<{ ok: boolean }>;
    copy(text: string): Promise<{ ok: boolean }>;
  };
  attachment: {
    add(params: {
      sessionId: string;
      kind?: "image" | "file";
      name?: string;
      mimeType?: string;
      dataBase64?: string;
      path?: string;
      text?: string;
    }): Promise<MessageAttachment>;
    read(storeId: string): Promise<{ mimeType: string; base64: string; name: string }>;
    remove(storeId: string): Promise<{ ok: boolean }>;
  };
  modelConfig: {
    importScan(): Promise<{ entries: Array<Record<string, unknown>> }>;
    importRun(params: { entries: Array<Record<string, unknown>> }): Promise<{ ok: boolean; providers: string[] }>;
  };
  session: {
    list(): Promise<SessionMeta[]>;
    create(params: { title?: string; projectPath?: string | null }): Promise<Session>;
    get(id: string): Promise<Session>;
    rename(id: string, title: string): Promise<Session>;
    delete(id: string): Promise<{ ok: boolean }>;
    setProject(id: string, projectPath: string | null): Promise<Session>;
    setMode(id: string, mode: SessionMode): Promise<Session>;
    appendMessages(id: string, messages: ChatMessage[]): Promise<Session>;
    fork(params: { id: string; title?: string; messageCount?: number }): Promise<Session>;
    setThinking(params: { id: string; level: ThinkingLevel | null }): Promise<Session>;
    scratch(params: { sessionId: string; create?: boolean }): Promise<ScratchInfo>;
    openScratch(sessionId: string): Promise<{ ok: boolean; dir: string; error?: string }>;
    openFolder(path: string): Promise<{ ok: boolean; error?: string }>;
    revisions: {
      list(sessionId: string): Promise<SessionRevision[]>;
      save(params: { sessionId: string; label?: string }): Promise<SessionRevision>;
      activate(params: { sessionId: string; revisionId: string }): Promise<Session>;
      remove(params: { sessionId: string; revisionId: string }): Promise<{ ok: boolean }>;
    };
    importScan(params?: { sources?: ExternalAgentSource[] }): Promise<ImportScanResult>;
    importRun(params: {
      sessions: ExternalSessionSummary[];
      projectPathOverride?: string | null;
    }): Promise<ImportRunResult>;
  };
  file: {
    pick(projectPath?: string | null): Promise<string[]>;
    pickPhotos(): Promise<Array<{ name: string; mimeType: string; dataBase64: string; bytes: number }>>;
  };
  provider: {
    list(): Promise<ProviderSummary[]>;
    set(provider: ProviderConfig): Promise<ProviderSummary>;
    delete(id: string): Promise<{ ok: boolean }>;
    test(id: string): Promise<ProviderTestResult>;
    discoverModels(input: ProviderDiscoveryInput): Promise<ProviderTestResult>;
  };
  skill: {
    list(query?: { level?: CapabilityLevel; projectPath?: string }): Promise<SkillRecord[]>;
    set(skill: SkillInput): Promise<SkillRecord>;
    delete(params: { id: string; level?: CapabilityLevel; projectPath?: string }): Promise<{ ok: boolean }>;
    setEnabled(params: {
      id: string;
      enabled: boolean;
      level?: CapabilityLevel;
      projectPath?: string;
    }): Promise<SkillRecord>;
  };
  subagent: {
    list(query?: { level?: CapabilityLevel; projectPath?: string }): Promise<SubagentRecord[]>;
    set(subagent: SubagentInput): Promise<SubagentRecord>;
    delete(params: { id: string; level?: CapabilityLevel; projectPath?: string }): Promise<{ ok: boolean }>;
    setEnabled(params: {
      id: string;
      enabled: boolean;
      level?: CapabilityLevel;
      projectPath?: string;
    }): Promise<SubagentRecord>;
  };
  mcp: {
    list(query?: { level?: CapabilityLevel; projectPath?: string }): Promise<{
      servers: McpServerSummary[];
      statuses: McpServerStatus[];
    }>;
    set(server: McpServerInput): Promise<McpServerSummary>;
    delete(params: { id: string; level?: CapabilityLevel; projectPath?: string }): Promise<{ ok: boolean }>;
    setEnabled(params: {
      id: string;
      enabled: boolean;
      level?: CapabilityLevel;
      projectPath?: string;
    }): Promise<McpServerSummary>;
    test(params: { id: string; level?: CapabilityLevel; projectPath?: string }): Promise<McpServerStatus>;
  };
  scheduled: {
    list(): Promise<ScheduledTask[]>;
    set(task: ScheduledTaskInput): Promise<ScheduledTask>;
    delete(id: string): Promise<{ ok: boolean }>;
    setEnabled(id: string, enabled: boolean): Promise<ScheduledTask>;
    runs(params: { taskId: string }): Promise<ScheduledRun[]>;
    trigger(id: string): Promise<{ ok: boolean }>;
  };
  review: {
    list(sessionId: string): Promise<ReviewSnapshot[]>;
    get(params: { sessionId: string; snapshotId: string }): Promise<ReviewSnapshot>;
    rollback(params: { sessionId: string; snapshotId: string }): Promise<{ ok: boolean; output: string }>;
    purge(sessionId: string): Promise<{ ok: boolean }>;
  };
  memory: {
    list(params?: { projectPath?: string | null; scope?: MemoryScope }): Promise<MemoryIndex[]>;
    search(params: { query: string; projectPath?: string | null; limit?: number }): Promise<MemorySearchHit[]>;
    read(params: { key: string; projectPath?: string | null; scope?: MemoryScope }): Promise<{ entry: MemoryEntry | null }>;
    write(params: {
      key: string;
      content: string;
      projectPath?: string | null;
      scope?: MemoryScope;
      mode?: "replace" | "append";
      action?: "write" | "log";
    }): Promise<{ entry: MemoryEntry; index: string }>;
    forget(params: { key: string; projectPath?: string | null; scope?: MemoryScope }): Promise<{ removed: boolean }>;
  };
  projectCtx: {
    getContext(projectPath?: string | null): Promise<ProjectContext>;
    setContext(input: { projectPath?: string | null; instructions?: string; memory?: string }): Promise<ProjectContext>;
    gitInfo(projectPath: string): Promise<GitInfo>;
    prList(projectPath: string, limit?: number): Promise<{ prs: PullSummary[]; error?: string }>;
  };
  permission: {
    list(): Promise<PermissionGrant[]>;
    clear(params: { sessionId?: string; tool?: string }): Promise<{ ok: boolean }>;
    respond(params: { requestId: string; allow: boolean; remember?: GrantScope | null }): Promise<{ handled: boolean }>;
  };
  plugin: {
    list(): Promise<PluginInfo[]>;
    pickDirectory(): Promise<string | null>;
    install(dir: string): Promise<PluginInfo>;
    installUrl(url: string): Promise<PluginInfo>;
    uninstall(name: string): Promise<{ ok: boolean }>;
    setEnabled(name: string, enabled: boolean): Promise<PluginInfo>;
  };
  notify: {
    list(): Promise<AppNotification[]>;
    markRead(params: { id?: string; all?: boolean }): Promise<{ ok: boolean }>;
    clear(): Promise<{ ok: boolean }>;
    showNative(params: {
      title: string;
      body?: string;
      silent?: boolean;
      sessionId?: string;
      taskId?: string;
      kind?: AppNotification["kind"];
    }): Promise<{ ok: boolean; shown: boolean; error?: string }>;
    setViewingSession(sessionId: string | null): Promise<{ ok: boolean }>;
  };
  chat: {
    send(params: {
      sessionId: string;
      text: string;
      modelRef: SenastrModelRef;
      mode?: SessionMode;
      attachments?: MessageAttachment[];
      thinkingLevel?: ThinkingLevel | null;
    }): Promise<{ ok: boolean }>;
    stop(sessionId: string): Promise<boolean>;
    resolveAsk(requestId: string, answers: AskAnswers): Promise<boolean>;
    delegations(sessionId: string): Promise<DelegationSummary[]>;
    enhance(params: { text: string; modelRef: SenastrModelRef }): Promise<{ text: string; usage: Usage }>;
    suggestTitle(params: { modelRef: SenastrModelRef; excerpt: string }): Promise<{ title: string }>;
    compact(params: { sessionId: string; keep?: number }): Promise<{ compacted: boolean; dropped: number; session: Session }>;
  };
  onEvent(cb: (ev: SenastrEvent) => void): () => void;
}

declare global {
  interface Window {
    senastr?: SenastrApi;
  }
}

// Re-exported so components can import render-relevant contracts from one place.
export type {
  AskRequest,
  CommandItem,
  ExternalSessionSummary,
  MessageAttachment,
  PlanProposal,
  ProjectGroup,
  ProjectRecord,
  SessionRevision,
  ThinkingLevel,
  UpdateState,
};
