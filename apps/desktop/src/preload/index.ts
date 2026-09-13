import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge between the sandboxed renderer and the main process.
 * Every channel is explicit; the renderer cannot reach raw ipcRenderer.
 */
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  app: {
    version: () => invoke("app/version"),
  },
  project: {
    open: () => invoke("project/open"),
  },
  session: {
    list: () => invoke("session/list"),
    create: (params: { title?: string; projectPath?: string | null }) => invoke("session/create", params),
    get: (id: string) => invoke("session/get", { id }),
    rename: (id: string, title: string) => invoke("session/rename", { id, title }),
    delete: (id: string) => invoke("session/delete", { id }),
    setProject: (id: string, projectPath: string | null) => invoke("session/set-project", { id, projectPath }),
  },
  provider: {
    list: () => invoke("provider/list"),
    set: (provider: unknown) => invoke("provider/set", { provider }),
    delete: (id: string) => invoke("provider/delete", { id }),
    test: (id: string) => invoke("provider/test", { id }),
  },
  permission: {
    list: () => invoke("permission/list"),
    clear: (params: { sessionId?: string; tool?: string }) => invoke("permission/clear", params),
    respond: (params: { requestId: string; allow: boolean; remember?: "session" | "always" | null }) =>
      invoke("permission/respond", params),
  },
  plugin: {
    list: () => invoke("plugin/list"),
    install: (dir: string) => invoke("plugin/install", { dir }),
    uninstall: (name: string) => invoke("plugin/uninstall", { name }),
  },
  chat: {
    send: (params: { sessionId: string; text: string; modelRef: { providerId: string; model: string } }) =>
      invoke("chat/send", params),
    stop: (sessionId: string) => invoke("chat/stop", { sessionId }),
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
