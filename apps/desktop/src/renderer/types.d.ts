import type {
  AgentEvent,
  GrantScope,
  PermissionGrant,
  PermissionRequest,
  PluginInfo,
  ProviderConfig,
  ProviderSummary,
  ProviderTestResult,
  Session,
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
  };
  permission: {
    list(): Promise<PermissionGrant[]>;
    clear(params: { sessionId?: string; tool?: string }): Promise<{ ok: boolean }>;
    respond(params: { requestId: string; allow: boolean; remember?: GrantScope | null }): Promise<{ handled: boolean }>;
  };
  plugin: {
    list(): Promise<PluginInfo[]>;
    install(dir: string): Promise<PluginInfo>;
    uninstall(name: string): Promise<{ ok: boolean }>;
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
