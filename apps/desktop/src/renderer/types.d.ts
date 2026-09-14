import type {
  AgentEvent,
  AppNotification,
  AskAnswers,
  AskRequest,
  CapabilityLevel,
  ChatMessage,
  DelegationSummary,
  GitInfo,
  GrantScope,
  McpServerInput,
  McpServerStatus,
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
  PullSummary,
  ReviewSnapshot,
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
  | { kind: "scheduled/finished"; taskId: string; status: string; sessionId?: string; error?: string };

export interface SenastrApi {
  app: {
    version(): Promise<string>;
    dataDir(): Promise<string>;
    openExternal(url: string): Promise<void>;
  };
  project: {
    open(): Promise<string | null>;
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
  };
  file: {
    pick(projectPath?: string | null): Promise<string[]>;
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
  };
  chat: {
    send(params: { sessionId: string; text: string; modelRef: SenastrModelRef; mode?: SessionMode }): Promise<{ ok: boolean }>;
    stop(sessionId: string): Promise<boolean>;
    resolveAsk(requestId: string, answers: AskAnswers): Promise<boolean>;
    delegations(sessionId: string): Promise<DelegationSummary[]>;
    enhance(params: { text: string; modelRef: SenastrModelRef }): Promise<{ text: string; usage: Usage }>;
    suggestTitle(params: { modelRef: SenastrModelRef; excerpt: string }): Promise<{ title: string }>;
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
  PlanProposal,
};
