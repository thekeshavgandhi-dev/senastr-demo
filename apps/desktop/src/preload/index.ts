import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge between the sandboxed renderer and the main process.
 * Every channel is explicit; the renderer cannot reach raw ipcRenderer.
 */
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  app: {
    version: () => invoke("app/version"),
    dataDir: () => invoke("app/data-dir"),
    openExternal: (url: string) => invoke("app/open-external", { url }),
  },
  session: {
    list: () => invoke("session/list"),
    create: (params: { title?: string; projectPath?: string | null }) => invoke("session/create", params),
    get: (id: string) => invoke("session/get", { id }),
    rename: (id: string, title: string) => invoke("session/rename", { id, title }),
    delete: (id: string) => invoke("session/delete", { id }),
    setProject: (id: string, projectPath: string | null) => invoke("session/set-project", { id, projectPath }),
    setMode: (id: string, mode: unknown) => invoke("session/set-mode", { id, mode }),
    appendMessages: (id: string, messages: unknown[]) => invoke("session/append-messages", { id, messages }),
    fork: (params: { id: string; title?: string; messageCount?: number }) => invoke("session/fork", params),
    setThinking: (params: { id: string; level: string | null }) => invoke("session/set-thinking", params),
    scratch: (params: { sessionId: string; create?: boolean }) => invoke("session/scratch", params),
    openScratch: (sessionId: string) => invoke("session/open-scratch", { sessionId }),
    openFolder: (path: string) => invoke("session/open-folder", { path }),
    revisions: {
      list: (sessionId: string) => invoke("session/revisions/list", { sessionId }),
      save: (params: { sessionId: string; label?: string }) => invoke("session/revisions/save", params),
      activate: (params: { sessionId: string; revisionId: string }) => invoke("session/revisions/activate", params),
      remove: (params: { sessionId: string; revisionId: string }) => invoke("session/revisions/delete", params),
    },
    importScan: (params: { sources?: string[] } = {}) => invoke("session/import-scan", params),
    importRun: (params: { sessions: unknown[]; projectPathOverride?: string | null }) =>
      invoke("session/import-run", params),
  },
  modelConfig: {
    importScan: () => invoke("model-config/import-scan"),
    importRun: (params: { entries: unknown[] }) => invoke("model-config/import-run", params),
  },
  attachment: {
    add: (params: unknown) => invoke("attachment/add", params),
    read: (storeId: string) => invoke("attachment/read", { storeId }),
    remove: (storeId: string) => invoke("attachment/delete", { storeId }),
  },
  project: {
    open: () => invoke("project/open"),
    list: () => invoke("project/list"),
    add: (params: unknown) => invoke("project/add", params),
    update: (params: unknown) => invoke("project/update", params),
    remove: (path: string) => invoke("project/remove", { path }),
    groupList: () => invoke("project-group/list"),
    groupSet: (params: unknown) => invoke("project-group/set", params),
    groupDelete: (id: string) => invoke("project-group/delete", { id }),
  },
  stats: {
    usage: (query: unknown = {}) => invoke("stats/usage", query),
    recordUsage: (params: unknown) => invoke("stats/record-usage", params),
  },
  settings: {
    get: () => invoke("settings/get"),
    set: (patch: unknown) => invoke("settings/set", patch),
  },
  fs: {
    index: (params: { projectPath: string; force?: boolean; limit?: number }) => invoke("fs/index", params),
  },
  command: {
    list: (query: unknown = {}) => invoke("command/list", query),
  },
  updates: {
    getState: () => invoke("updates/get-state"),
    check: () => invoke("updates/check"),
    download: () => invoke("updates/download"),
    install: () => invoke("updates/install"),
    openReleases: () => invoke("updates/open-releases"),
  },
  clipboard: {
    recordPaste: (text: string) => invoke("clipboard/record-paste", { text }),
    list: () => invoke("clipboard/list"),
    clear: () => invoke("clipboard/clear"),
    copy: (text: string) => invoke("clipboard/copy", { text }),
  },
  file: {
    pick: (projectPath?: string | null) => invoke("file/pick", { projectPath }),
    pickPhotos: () => invoke("composer/pick-photos"),
  },
  provider: {
    list: () => invoke("provider/list"),
    set: (provider: unknown) => invoke("provider/set", { provider }),
    delete: (id: string) => invoke("provider/delete", { id }),
    test: (id: string) => invoke("provider/test", { id }),
    discoverModels: (input: unknown) => invoke("provider/discover-models", { input }),
  },
  skill: {
    list: (query: unknown = {}) => invoke("skill/list", query),
    set: (skill: unknown) => invoke("skill/set", { skill }),
    delete: (params: unknown) => invoke("skill/delete", params),
    setEnabled: (params: unknown) => invoke("skill/set-enabled", params),
  },
  mcp: {
    list: (query: unknown = {}) => invoke("mcp/list", query),
    set: (server: unknown) => invoke("mcp/set", { server }),
    delete: (params: unknown) => invoke("mcp/delete", params),
    setEnabled: (params: unknown) => invoke("mcp/set-enabled", params),
    test: (params: unknown) => invoke("mcp/test", params),
  },
  permission: {
    list: () => invoke("permission/list"),
    clear: (params: { sessionId?: string; tool?: string }) => invoke("permission/clear", params),
    respond: (params: { requestId: string; allow: boolean; remember?: "session" | "always" | null }) =>
      invoke("permission/respond", params),
  },
  plugin: {
    list: () => invoke("plugin/list"),
    pickDirectory: () => invoke("plugin/pick-directory"),
    install: (dir: string) => invoke("plugin/install", { dir }),
    installUrl: (url: string) => invoke("plugin/install-url", { url }),
    uninstall: (name: string) => invoke("plugin/uninstall", { name }),
    setEnabled: (name: string, enabled: boolean) => invoke("plugin/set-enabled", { name, enabled }),
  },
  subagent: {
    list: (query: unknown = {}) => invoke("subagent/list", query),
    set: (subagent: unknown) => invoke("subagent/set", { subagent }),
    delete: (params: unknown) => invoke("subagent/delete", params),
    setEnabled: (params: unknown) => invoke("subagent/set-enabled", params),
  },
  scheduled: {
    list: () => invoke("scheduled/list"),
    set: (task: unknown) => invoke("scheduled/set", { task }),
    delete: (id: string) => invoke("scheduled/delete", { id }),
    setEnabled: (id: string, enabled: boolean) => invoke("scheduled/set-enabled", { id, enabled }),
    runs: (params: unknown = {}) => invoke("scheduled/runs", params),
    trigger: (id: string) => invoke("scheduled/trigger", { id }),
  },
  review: {
    list: (sessionId: string) => invoke("review/list", { sessionId }),
    get: (params: unknown) => invoke("review/get", params),
    rollback: (params: unknown) => invoke("review/rollback", params),
    purge: (sessionId: string) => invoke("review/purge", { sessionId }),
  },
  projectCtx: {
    getContext: (projectPath?: string | null) => invoke("project/get-context", { projectPath }),
    setContext: (params: unknown) => invoke("project/set-context", params),
    gitInfo: (projectPath: string) => invoke("project/git-info", { projectPath }),
    prList: (projectPath: string, limit?: number) => invoke("project/pr-list", { projectPath, limit }),
  },
  notify: {
    list: () => invoke("notify/list"),
    markRead: (params: { id?: string; all?: boolean }) => invoke("notify/mark-read", params),
    clear: () => invoke("notify/clear"),
    showNative: (params: unknown) => invoke("notify/show-native", params),
    setViewingSession: (sessionId: string | null) => invoke("notify/set-viewing-session", { sessionId }),
  },
  chat: {
    send: (params: { sessionId: string; text: string; modelRef: { providerId: string; model: string }; mode?: unknown }) =>
      invoke("chat/send", params),
    stop: (sessionId: string) => invoke("chat/stop", { sessionId }),
    resolveAsk: (requestId: string, answers: unknown) => invoke("chat/resolve-ask", { requestId, answers }),
    delegations: (sessionId: string) => invoke("chat/delegations", { sessionId }),
    enhance: (params: unknown) => invoke("chat/enhance", params),
    suggestTitle: (params: unknown) => invoke("chat/suggest-title", params),
    compact: (params: { sessionId: string; keep?: number }) => invoke("chat/compact", params),
  },
  /**
   * Subscribe to live events (agent turn events + permission requests).
   * Returns an unsubscribe function.
   */
  onEvent: (cb: (ev: unknown) => void) => {
    const listener = (_: unknown, ev: unknown): void => cb(ev);
    ipcRenderer.on("senastr/event", listener);
    return () => {
      ipcRenderer.removeListener("senastr/event", listener);
    };
  },
};

contextBridge.exposeInMainWorld("senastr", api);
