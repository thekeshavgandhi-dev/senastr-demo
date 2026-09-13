import type {
  AgentEvent,
  CapabilityLevel,
  GrantScope,
  McpServerInput,
  McpServerStatus,
  McpServerSummary,
  PermissionGrant,
  PermissionRequest,
  PluginInfo,
  ProviderConfig,
  ProviderDiscoveryInput,
  ProviderSummary,
  ProviderTestResult,
  Session,
  SkillInput,
  SkillRecord,
  SessionMeta,
} from "@senastr/shared";

export interface SenastrModelRef {
  providerId: string;
  model: string;
}

export type SenastrEvent =
  | AgentEvent
  | { kind: "permission/requested"; request: PermissionRequest };

export interface SenastrApi {
  app: {
    version(): Promise<string>;
    dataDir(): Promise<string>;
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
  permission: {
    list(): Promise<PermissionGrant[]>;
    clear(params: { sessionId?: string; tool?: string }): Promise<{ ok: boolean }>;
    respond(params: { requestId: string; allow: boolean; remember?: GrantScope | null }): Promise<{ handled: boolean }>;
  };
  plugin: {
    list(): Promise<PluginInfo[]>;
    pickDirectory(): Promise<string | null>;
    install(dir: string): Promise<PluginInfo>;
    uninstall(name: string): Promise<{ ok: boolean }>;
    setEnabled(name: string, enabled: boolean): Promise<PluginInfo>;
  };
  chat: {
    send(params: { sessionId: string; text: string; modelRef: SenastrModelRef }): Promise<{ ok: boolean }>;
    stop(sessionId: string): Promise<boolean>;
  };
  onEvent(cb: (ev: SenastrEvent) => void): () => void;
}

declare global {
  interface Window {
    senastr: SenastrApi;
  }
}
