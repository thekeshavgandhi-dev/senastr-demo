import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentRuntime, type HostBridge, type ModelSpec } from "@senastr/agent-runtime";
import {
  Methods,
  NdjsonRpcClient,
  type ModelRef,
  type PermissionRequest,
  type ProviderConfig,
  type Session,
  type ToolDefinition,
  type ToolResult,
} from "@senastr/shared";

/**
 * senastr desktop — Electron main process.
 *
 * Responsibilities (and only these):
 *  - app lifecycle + window
 *  - own the host-core sidecar (spawn, NDJSON JSON-RPC, restart on crash)
 *  - run the agent loop (in-process; it talks to the sidecar via HostBridge)
 *  - expose a narrow, typed IPC surface to the renderer
 *
 * The renderer is fully sandboxed and never sees API keys or the filesystem:
 * provider secrets live in the host-core and are resolved here per turn.
 */

let win: BrowserWindow | null = null;
let host: NdjsonRpcClient | null = null;
let runtime: AgentRuntime | null = null;
let hostRestarts = 0;
let shuttingDown = false;

function log(...args: unknown[]): void {
  console.log("[senastr/main]", ...args);
}

function resolveHostScript(): string {
  const override = process.env.SENASTR_HOST_CORE;
  if (override && existsSync(override)) return override;
  const candidates = [
    // dev monorepo: <root>/apps/desktop/out/main → up 4 to <root>
    resolve(__dirname, "../../../../packages/host-core/dist/main.js"),
    // packaged (electron-builder)
    join(process.resourcesPath ?? "", "senastr-host-core", "main.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "senastr host-core not found. Run `pnpm build:packages` first, or set SENASTR_HOST_CORE to host-core dist/main.js.",
  );
}

class RpcHostBridge implements HostBridge {
  constructor(private readonly client: NdjsonRpcClient) {}

  getSession(id: string) {
    return this.client.request<Session>(Methods.sessionGet, { id });
  }

  appendMessages(id: string, messages: unknown[]) {
    return this.client.request(Methods.sessionAppendMessages, { id, messages }, { timeoutMs: 10_000 });
  }

  listTools() {
    return this.client.request<ToolDefinition[]>(Methods.hostToolsList);
  }

  runTool(req: { sessionId: string; tool: string; args: Record<string, unknown> }) {
    // May block on an interactive permission prompt (120s max) — generous ceiling.
    return this.client.request<ToolResult>(Methods.toolRun, req, { timeoutMs: 15 * 60_000 });
  }
}

async function startHost(): Promise<NdjsonRpcClient> {
  const dataDir = process.env.SENASTR_DATA_DIR ?? join(app.getPath("userData"), "data");
  const script = resolveHostScript();
  const client = new NdjsonRpcClient({
    // ELECTRON_RUN_AS_NODE: run the bundled Electron runtime as plain Node —
    // no separate Node install needed in dev or in the packaged app.
    command: process.execPath,
    args: [script, "--data-dir", dataDir],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    onNotification: (method, params) => {
      if (method === "permission/requested") {
        win?.webContents.send("senastr/event", {
          kind: "permission/requested",
          request: params as PermissionRequest,
        });
      }
    },
    onStderr: (line) => log("host-core:", line),
    onExit: (info) => {
      if (shuttingDown) return;
      log("host-core exited", info);
      if (hostRestarts < 3) {
        hostRestarts += 1;
        setTimeout(async () => {
          if (shuttingDown) return;
          try {
            host = await startHost();
            runtime = new AgentRuntime(new RpcHostBridge(host));
            log("host-core restarted");
          } catch (err) {
            log("host-core restart failed:", err);
          }
        }, 1000);
      }
    },
  });
  const ping = await client.request(Methods.hostPing, {}, { timeoutMs: 10_000 });
  log("host-core ready:", ping);
  return client;
}

function setupIpc(): void {
  const req = (method: string, params?: unknown, timeoutMs?: number) => {
    if (!host) throw new Error("host-core is not ready");
    return host.request(method, params, { timeoutMs });
  };

  ipcMain.handle("app/version", () => app.getVersion());
  ipcMain.handle("project/open", async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: "Open a project folder",
      properties: ["openDirectory", "showHiddenFiles"],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle("session/list", () => req(Methods.sessionList));
  ipcMain.handle("session/create", (_e, p) => req(Methods.sessionCreate, p ?? {}));
  ipcMain.handle("session/get", (_e, p: { id: string }) => req(Methods.sessionGet, p));
  ipcMain.handle("session/rename", (_e, p: { id: string; title: string }) => req(Methods.sessionRename, p));
  ipcMain.handle("session/delete", (_e, p: { id: string }) => req(Methods.sessionDelete, p));
  ipcMain.handle("session/set-project", (_e, p: { id: string; projectPath: string | null }) =>
    req(Methods.sessionSetProject, p),
  );

  ipcMain.handle("provider/list", () => req(Methods.providerList));
  ipcMain.handle("provider/set", (_e, p: { provider: ProviderConfig }) => req(Methods.providerSet, p));
  ipcMain.handle("provider/delete", (_e, p: { id: string }) => req(Methods.providerDelete, p));
  ipcMain.handle("provider/test", (_e, p: { id: string }) => req(Methods.providerTest, p, 20_000));

  ipcMain.handle("permission/list", () => req(Methods.permissionList));
  ipcMain.handle("permission/clear", (_e, p: { sessionId?: string; tool?: string }) =>
    req(Methods.permissionClear, p),
  );
  ipcMain.handle(
    "permission/respond",
    (_e, p: { requestId: string; allow: boolean; remember?: "session" | "always" | null }) =>
      req(Methods.permissionRespond, p),
  );

  ipcMain.handle("plugin/list", () => req(Methods.pluginList));
  ipcMain.handle("plugin/install", (_e, p: { dir: string }) => req(Methods.pluginInstall, p));
  ipcMain.handle("plugin/uninstall", (_e, p: { name: string }) => req(Methods.pluginUninstall, p));

  ipcMain.handle(
    "chat/send",
    async (_e, p: { sessionId: string; text: string; modelRef: ModelRef }) => {
      if (!host || !runtime) throw new Error("agent not ready");
      const { sessionId, text, modelRef: ref } = p;
      const runtimeRef = runtime;
      const hostRef = host;
      void (async () => {
        let model: ModelSpec;
        try {
          const provider = await hostRef.request<ProviderConfig>(Methods.providerGet, { id: ref.providerId }, {
            timeoutMs: 10_000,
          });
          model = {
            kind: provider.kind,
            model: ref.model,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          };
        } catch (err) {
          win?.webContents.send("senastr/event", {
            type: "turn/end",
            stopReason: "error",
            usage: {},
            error: `provider lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        try {
          for await (const ev of runtimeRef.runTurn({ sessionId, userMessage: text, model })) {
            win?.webContents.send("senastr/event", ev);
          }
        } catch (err) {
          win?.webContents.send("senastr/event", {
            type: "turn/end",
            stopReason: "error",
            usage: {},
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return { ok: true };
    },
  );

  ipcMain.handle("chat/stop", (_e, p: { sessionId: string }) =>
    runtime ? runtime.stop(p.sessionId) : false,
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    title: "senastr",
    backgroundColor: "#0e1013",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  win.on("closed", () => {
    win = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    win?.focus();
  });

  void app.whenReady().then(async () => {
    try {
      host = await startHost();
      runtime = new AgentRuntime(new RpcHostBridge(host));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox("senastr — host-core failed to start", message);
      app.quit();
      return;
    }
    setupIpc();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    shuttingDown = true;
    try {
      host?.dispose();
    } catch {
      /* already gone */
    }
  });
}
