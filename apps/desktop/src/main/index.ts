import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  shell,
} from "electron";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AgentRuntime,
  PROMPT_ENHANCEMENT_SYSTEM,
  TITLE_SUMMARIZE_SYSTEM,
  compactHistory,
  completeOneShot,
  type HostBridge,
  type ModelSpec,
} from "@senastr/agent-runtime";
import {
  Methods,
  NdjsonRpcClient,
  proxyEnvironment,
  type AppNotification,
  type AppSettings,
  type AskAnswers,
  type ChatMessage,
  type ExternalAgentSource,
  type ExternalSessionSummary,
  type GitInfo,
  type MessageAttachment,
  type ModelRef,
  type PermissionRequest,
  type ProjectContext,
  type ProviderConfig,
  type ProviderDiscoveryInput,
  type PullSummary,
  type ScheduledRun,
  type ScheduledTask,
  type Session,
  type SessionMode,
  type SkillRecord,
  type SubagentRecord,
  type ThinkingLevel,
  type ToolDefinition,
  type ToolResult,
} from "@senastr/shared";
import { UpdatesService } from "./updates";

/**
 * senastr desktop — Electron main process.
 *
 * Responsibilities (and only these):
 *  - app lifecycle + window
 *  - own the host-core sidecar (spawn, NDJSON JSON-RPC, restart on crash)
 *  - run the agent loop (in-process; it talks to the sidecar via HostBridge)
 *  - scheduled-task ticker (claim due tasks, run them headlessly, record runs)
 *  - git/gh helpers (status, branch, PR list) executed with the project as cwd
 *  - notification center store + OS notifications
 *  - expose a narrow, typed IPC surface to the renderer
 *
 * The renderer is fully sandboxed and never sees API keys or the filesystem:
 * provider secrets live in the host-core and are resolved here per turn.
 */

let win: BrowserWindow | null = null;
let host: NdjsonRpcClient | null = null;
let runtime: AgentRuntime | null = null;
let hostDataDir = "";
let hostRestarts = 0;
let shuttingDown = false;

const notifications: AppNotification[] = [];
let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerBusy = false;
/** Task ids with a manual ("Run now") run already in flight. */
const manuallyRunningTasks = new Set<string>();

/** Tray residency: closing the window hides it instead of quitting so a long
 *  agent run (or a scheduled task) is never killed by an accidental close.
 *  The tray menu can turn this off and quit explicitly. */
let tray: Tray | null = null;
let quitting = false;
let closeToTray = true;

/** In-app updates (electron-updater lane + manifest lane). */
const updates = new UpdatesService({
  repository: process.env.SENASTR_UPDATE_REPO,
  feedUrl: process.env.SENASTR_UPDATE_FEED,
});

/**
 * Clipboard history (parity: pi-desktop clipboard history). Small, bounded,
 * in-memory: pastes the user makes in the composer can be re-attached later
 * without leaving the app.
 */
interface ClipboardEntry {
  id: string;
  text: string;
  createdAt: number;
  bytes: number;
}
const clipboardHistory: ClipboardEntry[] = [];
const CLIPBOARD_LIMIT = 50;

function recordClipboardEntry(text: string): void {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return;
  const existing = clipboardHistory.findIndex((entry) => entry.text === value);
  if (existing >= 0) clipboardHistory.splice(existing, 1);
  clipboardHistory.unshift({
    id: randomUUID(),
    text: value,
    createdAt: Date.now(),
    bytes: Buffer.byteLength(value, "utf8"),
  });
  while (clipboardHistory.length > CLIPBOARD_LIMIT) clipboardHistory.pop();
}

/** Native notifications are suppressed while the user is looking at the
 *  session that produced them (parity: notification policy). */
let viewingSessionId: string | null = null;
function focusedOnSession(sessionId?: string): boolean {
  if (!sessionId || !win) return false;
  if (win.isFocused() === false) return false;
  return viewingSessionId === sessionId;
}

function log(...args: unknown[]): void {
  console.log("[senastr/main]", ...args);
}

function sendToRenderer(ev: unknown): void {
  win?.webContents.send("senastr/event", ev);
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

  listTools(sessionId?: string) {
    return this.client.request<ToolDefinition[]>(Methods.hostToolsList, { sessionId });
  }

  listSkills(projectPath?: string | null) {
    return this.client.request<SkillRecord[]>(Methods.skillActive, { projectPath });
  }

  listSubagents(projectPath: string) {
    return this.client.request<SubagentRecord[]>(Methods.subagentList, { projectPath });
  }

  getProjectContext(projectPath: string | null) {
    return this.client.request<ProjectContext>(Methods.projectGetContext, { projectPath });
  }

  resolveModel(ref: ModelRef) {
    return resolveModelSpec(this.client, ref);
  }

  runTool(req: { sessionId: string; tool: string; args: Record<string, unknown> }) {
    // May block on an interactive permission prompt (120s max) — generous ceiling.
    return this.client.request<ToolResult>(Methods.toolRun, req, { timeoutMs: 15 * 60_000 });
  }

  readAttachment(storeId: string) {
    return this.client.request<{ mimeType: string; base64: string; name: string }>(
      Methods.attachmentRead,
      { storeId },
      { timeoutMs: 20_000 },
    );
  }

  recordUsage(record: {
    sessionId: string;
    providerId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    stopReason?: string;
  }) {
    return this.client.request(Methods.statsRecordUsage, record, { timeoutMs: 10_000 });
  }
}

/**
 * Protect the host's credential-encryption key with the OS keychain.
 *
 * host-core encrypts provider keys and MCP secrets at rest. The key itself is
 * random per machine; Electron `safeStorage` (Keychain / DPAPI / libsecret)
 * wraps it so the file alone is not enough to read the credentials. When the
 * OS has no keyring available the host falls back to its own 0600 key file.
 */
function hostSecretKey(): string | undefined {
  if (process.env.SENASTR_SECRET_KEY) return process.env.SENASTR_SECRET_KEY;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    const keyPath = join(app.getPath("userData"), "secret.key.safe");
    if (existsSync(keyPath)) {
      const wrapped = readFileSync(keyPath);
      return safeStorage.decryptString(wrapped);
    }
    const fresh = randomBytes(32).toString("base64");
    writeFileSync(keyPath, safeStorage.encryptString(fresh), { mode: 0o600 });
    return fresh;
  } catch (err) {
    log("keychain unavailable, host-core will use its local key file:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function startHost(): Promise<NdjsonRpcClient> {
  const dataDir = process.env.SENASTR_DATA_DIR ?? join(app.getPath("userData"), "data");
  const script = resolveHostScript();
  const secretKey = hostSecretKey();
  const client = new NdjsonRpcClient({
    // ELECTRON_RUN_AS_NODE: run the bundled Electron runtime as plain Node —
    // no separate Node install needed in dev or in the packaged app.
    command: process.execPath,
    args: [script, "--data-dir", dataDir],
    env: secretKey
      ? { ELECTRON_RUN_AS_NODE: "1", SENASTR_SECRET_KEY: secretKey }
      : { ELECTRON_RUN_AS_NODE: "1" },
    onNotification: (method, params) => {
      if (method === "permission/requested") {
        sendToRenderer({
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
  const ping = await client.request<{ dataDir?: string }>(Methods.hostPing, {}, { timeoutMs: 10_000 });
  hostDataDir = ping.dataDir ?? dataDir;
  log("host-core ready:", ping);
  return client;
}

/* ------------------------------------------------------------------ */
/* model resolution                                                     */
/* ------------------------------------------------------------------ */

let cachedProxy: AppSettings["proxy"] | undefined;

async function resolveModelSpec(client: NdjsonRpcClient, ref: ModelRef): Promise<ModelSpec> {
  const provider = await client.request<ProviderConfig>(Methods.providerGet, { id: ref.providerId }, {
    timeoutMs: 10_000,
  });
  if (provider.enabled === false) throw new Error(`provider is disabled: ${provider.label}`);
  const apiKeys = provider.apiKeys?.length ? provider.apiKeys : provider.apiKey ? [provider.apiKey] : undefined;
  // Per-model configuration (context window, output cap, temperature, the
  // reasoning ladder) travels with every request (parity: model configuration).
  const modelConfig = provider.modelConfigs?.[ref.model];
  return {
    kind: provider.kind,
    model: ref.model,
    baseUrl: provider.baseUrl,
    apiKey: apiKeys?.[0],
    apiKeys,
    apiStyle: provider.apiStyle,
    headers: provider.headers,
    rateLimitPerMin: provider.rateLimitPerMin,
    providerId: provider.id,
    temperature: modelConfig?.temperature,
    maxOutputTokens: modelConfig?.maxOutputTokens,
    contextWindow: modelConfig?.contextWindow,
    thinkingLevel: modelConfig?.defaultThinkingLevel ?? undefined,
    proxy: cachedProxy,
  };
}

/**
 * Apply the configured outbound proxy to this process and to every child it
 * spawns (host-core, MCP stdio servers, shell tools). Custom proxies are also
 * applied to model HTTP requests through an undici dispatcher; this env layer
 * is what makes non-HTTP children honour it too.
 */
function applyProxyEnvironment(proxy: AppSettings["proxy"]): void {
  cachedProxy = proxy;
  const env = proxyEnvironment(proxy ?? { mode: "system" }, process.env);
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    const value = env[key];
    if (typeof value === "string") process.env[key] = value;
    else delete process.env[key];
  }
}

/* ------------------------------------------------------------------ */
/* notifications                                                        */
/* ------------------------------------------------------------------ */

function pushNotification(input: {
  kind: AppNotification["kind"];
  title: string;
  body?: string;
  sessionId?: string;
  taskId?: string;
  silent?: boolean;
}): AppNotification {
  const item: AppNotification = {
    id: randomUUID(),
    createdAt: Date.now(),
    ...input,
    read: false,
  };
  notifications.unshift(item);
  while (notifications.length > 100) notifications.pop();
  sendToRenderer({ kind: "notify/added", notification: item });
  if (!input.silent && Notification.isSupported()) {
    try {
      new Notification({ title: `senastr — ${item.title}`, body: item.body ?? "", silent: true }).show();
    } catch {
      /* headless / denied — the in-app center still has it */
    }
  }
  return item;
}

/* ------------------------------------------------------------------ */
/* git + gh helpers                                                     */
/* ------------------------------------------------------------------ */

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({
        ok: !error,
        stdout: String(stdout ?? ""),
        stderr: error ? String(stderr ?? error.message) : String(stderr ?? ""),
      });
    });
  });
}

async function gitInfo(projectPath: string): Promise<GitInfo> {
  if (!existsSync(projectPath)) return { branch: null, dirty: 0, error: "project folder not found" };
  const rev = await runCmd("git", ["rev-parse", "--show-toplevel"], projectPath);
  if (!rev.ok) return { branch: null, dirty: 0, error: "not a git repository" };
  const root = rev.stdout.trim() || projectPath;
  const [branchR, statusR] = await Promise.all([
    runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
    runCmd("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root),
  ]);
  const rawBranch = branchR.ok ? branchR.stdout.trim() : "";
  const dirty = statusR.ok ? statusR.stdout.split("\n").filter((line) => line.trim()).length : 0;
  return {
    branch: rawBranch && rawBranch !== "HEAD" ? rawBranch : null,
    dirty,
    error: statusR.ok ? undefined : statusR.stderr.slice(0, 500),
  };
}

async function prList(projectPath: string, limit: number): Promise<{ prs: PullSummary[]; error?: string }> {
  if (!existsSync(projectPath)) return { prs: [], error: "project folder not found" };
  const r = await runCmd("gh", ["pr", "list", "--limit", String(limit), "--json", "number,title,url,author,headRefName,baseRefName,updatedAt,isDraft"], projectPath);
  if (!r.ok) {
    const msg = r.stderr.trim() || "gh command failed";
    if (/not found|not recognized|command not found|ENOENT/i.test(msg)) {
      return { prs: [], error: "GitHub CLI (gh) is not installed or not on PATH" };
    }
    if (/not a git repository/i.test(msg)) return { prs: [], error: "Not a git repository" };
    if (/no remotes|could not resolve to a Repository/i.test(msg)) {
      return { prs: [], error: "No GitHub remote configured for this project" };
    }
    return { prs: [], error: msg.slice(0, 500) };
  }
  try {
    const raw = JSON.parse(r.stdout || "[]") as Array<Record<string, unknown>>;
    const prs: PullSummary[] = raw.map((p) => ({
      number: Number(p.number),
      title: String(p.title ?? ""),
      url: String(p.url ?? ""),
      author:
        p.author != null && typeof p.author === "object"
          ? String((p.author as Record<string, unknown>).login ?? "") || undefined
          : undefined,
      headRefName: p.headRefName != null ? String(p.headRefName) : undefined,
      baseRefName: p.baseRefName != null ? String(p.baseRefName) : undefined,
      updatedAt: p.updatedAt != null ? String(p.updatedAt) : undefined,
      isDraft: p.isDraft === true,
    }));
    return { prs };
  } catch (err) {
    return { prs: [], error: `could not parse gh output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ------------------------------------------------------------------ */
/* scheduled task ticker                                                */
/* ------------------------------------------------------------------ */

const SCHEDULER_INTERVAL_MS = 30_000;

async function runScheduledTask(client: NdjsonRpcClient, task: ScheduledTask): Promise<void> {
  const rt = runtime;
  if (!rt) return;
  // Reuse the task's headless session when it still exists.
  let session: Session | null = null;
  if (task.sessionId) {
    try {
      session = await client.request<Session>(Methods.sessionGet, { id: task.sessionId });
    } catch {
      session = null;
    }
  }
  if (!session) {
    session = await client.request<Session>(Methods.sessionCreate, {
      title: `Scheduled: ${task.title}`,
      projectPath: task.projectPath,
    });
  }
  const runStarted = Date.now();
  try {
    await client.request(Methods.scheduledRecordRun, {
      claim: { taskId: task.id, sessionId: session.id },
    });
  } catch {
    return; // task deleted or claim lost — skip this tick
  }
  sendToRenderer({ kind: "scheduled/started", taskId: task.id, name: task.title });
  const finish = async (run: Omit<ScheduledRun, "id" | "taskId"> & { taskId?: string }) => {
    try {
      await client.request(Methods.scheduledRecordRun, { run: { ...run, taskId: task.id } });
    } catch (err) {
      log("scheduled record-run failed:", err);
    }
  };
  try {
    const model = await resolveModelSpec(client, { providerId: task.providerId, model: task.model });
    let stopReason = "stop";
    let lastError: string | undefined;
    for await (const ev of rt.runTurn({ sessionId: session.id, userMessage: task.prompt, model })) {
      if (ev.type === "turn/end") {
        stopReason = ev.stopReason;
        lastError = ev.error;
      }
    }
    const failed = stopReason === "error" || stopReason === "aborted";
    await finish({
      sessionId: session.id,
      status: failed ? "error" : "done",
      startedAt: runStarted,
      endedAt: Date.now(),
      summary: failed ? undefined : `Finished (${stopReason})`,
      error: lastError,
    });
    pushNotification({
      kind: failed ? "error" : "scheduled",
      title: failed ? `Scheduled task failed: ${task.title}` : `Scheduled task finished: ${task.title}`,
      body: lastError ?? `Ran in session "${session.title}"`,
      sessionId: session.id,
      taskId: task.id,
    });
    sendToRenderer({
      kind: "scheduled/finished",
      taskId: task.id,
      status: failed ? "error" : "done",
      sessionId: session.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish({
      sessionId: session.id,
      status: "error",
      startedAt: runStarted,
      endedAt: Date.now(),
      error: message,
    });
    pushNotification({
      kind: "error",
      title: `Scheduled task failed: ${task.title}`,
      body: message,
      taskId: task.id,
      sessionId: session.id,
    });
    sendToRenderer({ kind: "scheduled/finished", taskId: task.id, status: "error", error: message });
  }
}

async function schedulerTick(): Promise<void> {
  if (schedulerBusy || shuttingDown || !host || !runtime) return;
  schedulerBusy = true;
  try {
    const tasks = await host.request<ScheduledTask[]>(Methods.scheduledList, {}, { timeoutMs: 10_000 });
    const now = Date.now();
    const due = tasks.filter((t) => t.enabled && typeof t.nextRunAt === "number" && t.nextRunAt <= now);
    for (const task of due.slice(0, 2)) {
      if (shuttingDown) break;
      if (manuallyRunningTasks.has(task.id)) continue; // a manual run is in flight
      await runScheduledTask(host, task);
    }
  } catch (err) {
    log("scheduler tick failed:", err);
  } finally {
    schedulerBusy = false;
  }
}

function startScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => void schedulerTick(), SCHEDULER_INTERVAL_MS);
  // Run once shortly after boot so overdue tasks don't wait a full interval.
  setTimeout(() => void schedulerTick(), 5_000);
}

/* ------------------------------------------------------------------ */
/* IPC                                                                  */
/* ------------------------------------------------------------------ */

function setupIpc(): void {
  const req = (method: string, params?: unknown, timeoutMs?: number) => {
    if (!host) throw new Error("host-core is not ready");
    return host.request(method, params, { timeoutMs });
  };

  ipcMain.handle("app/version", () => app.getVersion());
  ipcMain.handle("app/data-dir", () => hostDataDir);
  ipcMain.handle("app/open-external", (_e, p: { url: string }) => {
    const url = String(p?.url ?? "");
    if (!/^https?:\/\//.test(url)) throw new Error("only http(s) URLs can be opened");
    return shell.openExternal(url);
  });
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
  ipcMain.handle("session/set-mode", (_e, p: { id: string; mode: SessionMode }) =>
    req(Methods.sessionSetMode, p),
  );
  ipcMain.handle(
    "session/append-messages",
    (_e, p: { id: string; messages: Session["messages"] }) => req(Methods.sessionAppendMessages, p),
  );
  ipcMain.handle("session/fork", (_e, p: { id: string; title?: string; messageCount?: number }) =>
    req(Methods.sessionFork, p),
  );
  ipcMain.handle("session/set-thinking", (_e, p: { id: string; level: ThinkingLevel | null }) =>
    req(Methods.sessionSetThinking, p),
  );
  ipcMain.handle("session/scratch", (_e, p: { sessionId: string; create?: boolean }) =>
    req(Methods.sessionScratch, p ?? {}),
  );
  ipcMain.handle("session/open-scratch", async (_e, p: { sessionId: string }) => {
    if (!host) throw new Error("host-core is not ready");
    const info = await host.request<{ dir: string }>(Methods.sessionScratch, {
      sessionId: p.sessionId,
      create: true,
    });
    const error = await shell.openPath(info.dir);
    return { ok: !error, dir: info.dir, error: error || undefined };
  });
  ipcMain.handle("session/open-folder", async (_e, p: { path: string }) => {
    if (!p?.path) throw new Error("path is required");
    const error = await shell.openPath(p.path);
    return { ok: !error, error: error || undefined };
  });

  ipcMain.handle("session/revisions/list", (_e, p: { sessionId: string }) =>
    req(Methods.sessionRevisionsList, p),
  );
  ipcMain.handle("session/revisions/save", (_e, p: { sessionId: string; label?: string }) =>
    req(Methods.sessionRevisionsSave, p),
  );
  ipcMain.handle("session/revisions/activate", (_e, p: { sessionId: string; revisionId: string }) =>
    req(Methods.sessionRevisionsActivate, p),
  );
  ipcMain.handle("session/revisions/delete", (_e, p: { sessionId: string; revisionId: string }) =>
    req(Methods.sessionRevisionsDelete, p),
  );

  ipcMain.handle("session/import-scan", (_e, p: { sources?: ExternalAgentSource[] } = {}) =>
    req(Methods.sessionImportScan, p, 60_000),
  );
  ipcMain.handle(
    "session/import-run",
    (_e, p: { sessions: ExternalSessionSummary[]; projectPathOverride?: string | null }) =>
      req(Methods.sessionImportRun, p, 120_000),
  );
  ipcMain.handle("model-config/import-scan", () => req(Methods.modelConfigImportScan));
  ipcMain.handle("model-config/import-run", (_e, p) => req(Methods.modelConfigImportRun, p));
  ipcMain.handle("file/pick", async (_e, p: { projectPath?: string | null } = {}) => {
    if (!win) return [];
    const opts: Electron.OpenDialogOptions = {
      title: "Attach files",
      properties: ["openFile", "multiSelections", "showHiddenFiles"],
    };
    if (p?.projectPath && existsSync(p.projectPath)) opts.defaultPath = p.projectPath;
    const r = await dialog.showOpenDialog(win, opts);
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle(
    "attachment/add",
    (_e, p: {
      sessionId: string;
      kind?: "image" | "file";
      name?: string;
      mimeType?: string;
      dataBase64?: string;
      path?: string;
      text?: string;
    }) => req(Methods.attachmentAdd, p),
  );
  ipcMain.handle("attachment/read", (_e, p: { storeId: string }) => req(Methods.attachmentRead, p, 20_000));
  ipcMain.handle("attachment/delete", (_e, p: { storeId: string }) => req(Methods.attachmentDelete, p));

  ipcMain.handle("provider/list", () => req(Methods.providerList));
  ipcMain.handle("provider/set", (_e, p: { provider: ProviderConfig }) => req(Methods.providerSet, p));
  ipcMain.handle("provider/delete", (_e, p: { id: string }) => req(Methods.providerDelete, p));
  ipcMain.handle("provider/test", (_e, p: { id: string }) => req(Methods.providerTest, p, 20_000));
  ipcMain.handle("provider/discover-models", (_e, p: { input: ProviderDiscoveryInput }) =>
    req(Methods.providerDiscoverModels, p, 20_000),
  );

  ipcMain.handle("skill/list", (_e, p) => req(Methods.skillList, p ?? {}));
  ipcMain.handle("skill/set", (_e, p) => req(Methods.skillSet, p));
  ipcMain.handle("skill/delete", (_e, p) => req(Methods.skillDelete, p));
  ipcMain.handle("skill/set-enabled", (_e, p) => req(Methods.skillSetEnabled, p));

  ipcMain.handle("subagent/list", (_e, p) => req(Methods.subagentList, p ?? {}));
  ipcMain.handle("subagent/set", (_e, p) => req(Methods.subagentSet, p));
  ipcMain.handle("subagent/delete", (_e, p) => req(Methods.subagentDelete, p));
  ipcMain.handle("subagent/set-enabled", (_e, p) => req(Methods.subagentSetEnabled, p));

  ipcMain.handle("mcp/list", (_e, p) => req(Methods.mcpList, p ?? {}));
  ipcMain.handle("mcp/set", (_e, p) => req(Methods.mcpSet, p));
  ipcMain.handle("mcp/delete", (_e, p) => req(Methods.mcpDelete, p));
  ipcMain.handle("mcp/set-enabled", (_e, p) => req(Methods.mcpSetEnabled, p));
  ipcMain.handle("mcp/test", (_e, p) => req(Methods.mcpTest, p, 30_000));

  ipcMain.handle("scheduled/list", () => req(Methods.scheduledList));
  ipcMain.handle("scheduled/set", (_e, p) => req(Methods.scheduledSet, p));
  ipcMain.handle("scheduled/delete", (_e, p) => req(Methods.scheduledDelete, p));
  ipcMain.handle("scheduled/set-enabled", (_e, p) => req(Methods.scheduledSetEnabled, p));
  ipcMain.handle("scheduled/runs", (_e, p) => req(Methods.scheduledRuns, p ?? {}));
  ipcMain.handle("scheduled/trigger", async (_e, p: { id: string }) => {
    if (!host) throw new Error("host-core is not ready");
    const tasks = await host.request<ScheduledTask[]>(Methods.scheduledList, {});
    const task = tasks.find((t) => t.id === p.id);
    if (!task) throw new Error("scheduled task not found");
    if (manuallyRunningTasks.has(task.id)) {
      return { ok: false, alreadyRunning: true };
    }
    manuallyRunningTasks.add(task.id);
    void runScheduledTask(host, task).finally(() => manuallyRunningTasks.delete(task.id));
    return { ok: true };
  });

  ipcMain.handle("review/list", (_e, p) => req(Methods.reviewList, p));
  ipcMain.handle("review/get", (_e, p) => req(Methods.reviewGet, p));
  ipcMain.handle("review/rollback", (_e, p) => req(Methods.reviewRollback, p));
  ipcMain.handle("review/purge", (_e, p) => req(Methods.reviewPurge, p));

  ipcMain.handle("project/get-context", (_e, p: { projectPath?: string | null }) =>
    req(Methods.projectGetContext, p ?? {}),
  );
  ipcMain.handle("project/set-context", (_e, p) => req(Methods.projectSetContext, p));
  ipcMain.handle("project/git-info", (_e, p: { projectPath: string }) => gitInfo(p.projectPath));
  ipcMain.handle("project/pr-list", (_e, p: { projectPath: string; limit?: number }) =>
    prList(p.projectPath, Math.min(Math.max(p.limit ?? 20, 1), 50)),
  );

  ipcMain.handle("project/list", () => req(Methods.projectList));
  ipcMain.handle("project/add", (_e, p) => req(Methods.projectAdd, p));
  ipcMain.handle("project/update", (_e, p) => req(Methods.projectUpdate, p));
  ipcMain.handle("project/remove", (_e, p: { path: string }) => req(Methods.projectRemove, p));
  ipcMain.handle("project-group/list", () => req(Methods.projectGroupList));
  ipcMain.handle("project-group/set", (_e, p) => req(Methods.projectGroupSet, p));
  ipcMain.handle("project-group/delete", (_e, p: { id: string }) => req(Methods.projectGroupDelete, p));

  ipcMain.handle("stats/usage", (_e, p) => req(Methods.statsUsage, p ?? {}));
  ipcMain.handle("stats/record-usage", (_e, p) => req(Methods.statsRecordUsage, p));

  ipcMain.handle("settings/get", () => req(Methods.settingsGet));
  ipcMain.handle("settings/set", async (_e, p: Partial<AppSettings>) => {
    const next = (await req(Methods.settingsSet, p ?? {})) as AppSettings;
    applyProxyEnvironment(next.proxy);
    return next;
  });

  ipcMain.handle("fs/index", (_e, p: { projectPath: string; force?: boolean; limit?: number }) =>
    req(Methods.fsIndex, p, 60_000),
  );
  ipcMain.handle("command/list", (_e, p) => req(Methods.commandList, p ?? {}));

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
  ipcMain.handle("plugin/pick-directory", async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "Choose a senastr plugin folder",
      properties: ["openDirectory", "showHiddenFiles"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("plugin/install", (_e, p: { dir: string }) => req(Methods.pluginInstall, p));
  ipcMain.handle("plugin/install-url", (_e, p: { url: string }) => req(Methods.pluginInstall, p, 120_000));
  ipcMain.handle("plugin/uninstall", (_e, p: { name: string }) => req(Methods.pluginUninstall, p));
  ipcMain.handle("plugin/set-enabled", (_e, p: { name: string; enabled: boolean }) =>
    req(Methods.pluginSetEnabled, p),
  );

  ipcMain.handle(
    "notify/show-native",
    (
      _e,
      p: { title: string; body?: string; silent?: boolean; sessionId?: string; taskId?: string; kind?: AppNotification["kind"] },
    ) => {
      // Native notifications are the OS-level mirror of the in-app centre.
      if (!Notification.isSupported()) return { ok: false, shown: false };
      if (!p?.silent && focusedOnSession(p.sessionId)) return { ok: true, shown: false };
      try {
        new Notification({ title: p.title, body: p.body ?? "", silent: p.silent === true }).show();
        return { ok: true, shown: true };
      } catch (error) {
        return { ok: false, shown: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle("updates/get-state", () => updates.getState());
  ipcMain.handle("updates/check", () => updates.check());
  ipcMain.handle("updates/download", () => updates.download());
  ipcMain.handle("updates/install", () => updates.install());
  ipcMain.handle("updates/open-releases", () => {
    updates.openReleases();
    return { ok: true };
  });

  ipcMain.handle("notify/set-viewing-session", (_e, p: { sessionId: string | null }) => {
    viewingSessionId = p?.sessionId ?? null;
    return { ok: true };
  });

  ipcMain.handle("notify/list", () => [...notifications]);
  ipcMain.handle("notify/mark-read", (_e, p: { id?: string; all?: boolean }) => {
    if (p.all) {
      for (const n of notifications) n.read = true;
    } else if (p.id) {
      const found = notifications.find((n) => n.id === p.id);
      if (found) found.read = true;
    }
    return { ok: true };
  });
  ipcMain.handle("notify/clear", () => {
    notifications.length = 0;
    return { ok: true };
  });

  ipcMain.handle("clipboard/record-paste", (_e, p: { text: string }) => {
    recordClipboardEntry(p?.text ?? "");
    return { ok: true, entries: clipboardHistory.length };
  });
  ipcMain.handle("clipboard/list", () => [...clipboardHistory]);
  ipcMain.handle("clipboard/clear", () => {
    clipboardHistory.length = 0;
    return { ok: true };
  });
  ipcMain.handle("clipboard/copy", (_e, p: { text: string }) => {
    clipboard.writeText(String(p?.text ?? ""));
    return { ok: true };
  });

  ipcMain.handle("composer/pick-photos", async () => {
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: "Attach images",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (file) => {
        const data = readFileSync(file);
        const ext = file.split(".").pop()?.toLowerCase() ?? "png";
        return {
          name: file.split(/[\\/]/).pop() ?? "image",
          mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`,
          dataBase64: data.toString("base64"),
          bytes: data.byteLength,
        };
      }),
    );
  });

  ipcMain.handle(
    "chat/send",
    async (
      _e,
      p: {
        sessionId: string;
        text: string;
        modelRef: ModelRef;
        attachments?: MessageAttachment[];
        thinkingLevel?: ThinkingLevel | null;
      },
    ) => {
      if (!host || !runtime) throw new Error("agent not ready");
      const { sessionId, text, modelRef: ref } = p;
      const runtimeRef = runtime;
      const hostRef = host;
      // Apply a pending mode switch requested with this send (Build/Plan toggle).
      const mode = (p as { mode?: SessionMode }).mode;
      void (async () => {
        let model: ModelSpec;
        try {
          if (mode === "build" || mode === "plan" || mode === "goal") {
            await hostRef.request(Methods.sessionSetMode, { id: sessionId, mode }, { timeoutMs: 10_000 });
          }
          if (p.thinkingLevel !== undefined) {
            await hostRef.request(
              Methods.sessionSetThinking,
              { id: sessionId, level: p.thinkingLevel },
              { timeoutMs: 10_000 },
            );
          }
          model = await resolveModelSpec(hostRef, ref);
        } catch (err) {
          sendToRenderer({
            type: "turn/end",
            stopReason: "error",
            usage: {},
            error: `provider lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        try {
          for await (const ev of runtimeRef.runTurn({
            sessionId,
            userMessage: text,
            model,
            attachments: p.attachments,
          })) {
            sendToRenderer(ev);
            if (ev.type === "ask/request") {
              pushNotification({
                kind: "ask",
                title: "The agent has a question",
                body: ev.request.questions[0]?.question ?? "",
                sessionId,
                silent: false,
              });
            } else if (ev.type === "plan/proposed") {
              pushNotification({
                kind: "plan",
                title: "Plan ready for review",
                body: ev.proposal.summary,
                sessionId,
                silent: false,
              });
            }
          }
        } catch (err) {
          sendToRenderer({
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

  ipcMain.handle("chat/resolve-ask", (_e, p: { requestId: string; answers: AskAnswers }) =>
    runtime ? runtime.resolveAsk(p.requestId, p.answers) : false,
  );

  ipcMain.handle("chat/delegations", (_e, p: { sessionId: string }) =>
    runtime ? runtime.listDelegations(p.sessionId) : [],
  );

  // /compact — replace the transcript window with a bounded one plus a
  // checkpoint note, exactly like the automatic compaction path but on demand
  // (parity: pi-desktop `agent/compact`).
  ipcMain.handle("chat/compact", async (_e, p: { sessionId: string; keep?: number }) => {
    if (!host) throw new Error("host-core is not ready");
    const session = await host.request<Session>(Methods.sessionGet, { id: p.sessionId });
    const keep = Math.min(Math.max(p.keep ?? 8, 2), 40);
    if (session.messages.length <= keep + 1) {
      return { compacted: false, dropped: 0, session };
    }
    const result = compactHistory(session.messages, undefined);
    const trimmed =
      result.dropped > 0
        ? result.messages
        : [
            ...session.messages.slice(0, 2),
            {
              id: randomUUID(),
              role: "user" as const,
              content: `[context checkpoint] Earlier turns were compacted on request; resuming with the most recent ${keep} messages.`,
              createdAt: Date.now(),
            },
            ...session.messages.slice(-keep),
          ];
    // Snapshot first so the pre-compaction transcript stays recoverable.
    await host
      .request(Methods.sessionRevisionsSave, { sessionId: p.sessionId, label: "Before compaction" })
      .catch(() => undefined);
    const replaced = await host.request<Session>(Methods.sessionReplaceMessages, {
      id: p.sessionId,
      messages: trimmed,
    });
    return { compacted: true, dropped: session.messages.length - trimmed.length, session: replaced };
  });

  ipcMain.handle(
    "chat/enhance",
    async (_e, p: { text: string; modelRef: ModelRef; messages?: ChatMessage[] }) => {
      if (!host) throw new Error("agent not ready");
      const model = await resolveModelSpec(host, p.modelRef);
      const input = p.text.length > 6000 ? p.text.slice(0, 6000) : p.text;
      const out = await completeOneShot(model, { system: PROMPT_ENHANCEMENT_SYSTEM, user: input });
      return { text: out.text, usage: out.usage };
    },
  );

  ipcMain.handle(
    "chat/suggest-title",
    async (_e, p: { modelRef: ModelRef; excerpt: string }) => {
      if (!host) throw new Error("agent not ready");
      const model = await resolveModelSpec(host, p.modelRef);
      const out = await completeOneShot(model, { system: TITLE_SUMMARIZE_SYSTEM, user: p.excerpt.slice(0, 4000) });
      return { title: out.text.replace(/^["']|["']$/g, "").trim().slice(0, 60) || "New session" };
    },
  );
}

function trayIconPath(): string {
  const candidates = [
    join(process.resourcesPath ?? "", "icon.png"),
    resolve(__dirname, "../../resources/icon.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

function toggleWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

/**
 * End-to-end smoke hook (scripts/e2e-electron-boot.mjs). Runs only when SENASTR_E2E is
 * set: it waits for the real window to finish loading against the real
 * host-core sidecar, asserts the renderer actually mounted the app shell,
 * captures a screenshot and writes a JSON report for the CI script to read.
 * Never active in a normal run.
 */
function runE2eSmoke(target: BrowserWindow): void {
  const outFile = process.env.SENASTR_E2E_REPORT || join(app.getPath("temp"), "senastr-e2e.json");
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const consoleErrors: string[] = [];

  target.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });

  const finish = async (): Promise<void> => {
    try {
      const probe = (await target.webContents.executeJavaScript(`(() => {
        const app = document.querySelector(".app");
        return {
          hasShell: Boolean(app),
          bridgeMissing: Boolean(document.querySelector(".bridge-missing")),
          toolbar: Boolean(document.querySelector("header, .topbar, .toolbar")),
          text: (document.body.innerText || "").slice(0, 400),
          channels: Object.keys(window.senastr ?? {}).length,
        };
      })()`)) as {
        hasShell: boolean;
        bridgeMissing: boolean;
        toolbar: boolean;
        text: string;
        channels: number;
      };

      checks.push({ name: "renderer mounted the app shell", ok: probe.hasShell });
      checks.push({ name: "preload bridge is present (no BridgeMissing gate)", ok: !probe.bridgeMissing, detail: `${probe.channels} namespaces` });
      checks.push({ name: "window chrome rendered", ok: probe.toolbar });
      checks.push({ name: "host-core sidecar answered (session list rendered)", ok: !/host-core failed|not ready/i.test(probe.text), detail: probe.text.replace(/\s+/g, " ").slice(0, 160) });
      checks.push({ name: "no renderer console errors", ok: consoleErrors.length === 0, detail: consoleErrors.slice(0, 3).join(" | ") });

      const image = await target.webContents.capturePage();
      const shot = outFile.replace(/\.json$/, ".png");
      writeFileSync(shot, image.toPNG());

      const ok = checks.every((c) => c.ok);
      writeFileSync(outFile, JSON.stringify({ ok, checks, screenshot: shot }, null, 2));
      console.log(`[e2e] ${ok ? "PASS" : "FAIL"} → ${outFile}`);
      for (const c of checks) console.log(`[e2e] ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      quitting = true;
      app.exit(ok ? 0 : 1);
    } catch (err) {
      writeFileSync(outFile, JSON.stringify({ ok: false, checks, error: String(err) }, null, 2));
      console.log(`[e2e] FAIL — ${String(err)}`);
      quitting = true;
      app.exit(1);
    }
  };

  target.webContents.once("did-finish-load", () => {
    // Give the renderer a beat to run its first IPC round-trips (session list,
    // tool catalog) before probing.
    setTimeout(() => void finish(), Number(process.env.SENASTR_E2E_SETTLE_MS ?? 2500));
  });
}

function createTray(): void {
  const iconPath = trayIconPath();
  const image = iconPath ? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("senastr — local-first coding agent");
  const render = (): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show senastr", click: () => toggleWindow() },
        { label: "New task", click: () => { if (!win) createWindow(); win?.show(); win?.focus(); sendToRenderer({ kind: "tray/new-task" }); } },
        { type: "separator" },
        {
          label: "Close to tray",
          type: "checkbox",
          checked: closeToTray,
          click: (item) => {
            closeToTray = item.checked;
            render();
          },
        },
        { type: "separator" },
        {
          label: "Quit senastr",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };
  render();
  tray.on("click", () => toggleWindow());
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

  win.on("close", (event) => {
    if (quitting || !closeToTray) return;
    event.preventDefault();
    win?.hide();
    if (!app.isPackaged) return;
    if (Notification.isSupported()) {
      new Notification({
        title: "senastr is still running",
        body: "Background work continues. Use the tray icon to reopen or quit.",
        silent: true,
      }).show();
    }
  });

  win.on("closed", () => {
    win = null;
  });

  // Links inside chat markdown (target="_blank") must open in the user's
  // browser, not in a new Electron window. Anything that is not http(s) is
  // refused outright.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  // Block top-level navigations away from the app shell (e.g. a crafted
  // markdown link with target=_self).
  win.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (app.isPackaged || !devUrl || !url.startsWith(devUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
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
    // Apply the persisted proxy before any provider request or child process.
    try {
      const settings = await host.request<AppSettings>(Methods.settingsGet, {}, { timeoutMs: 10_000 });
      applyProxyEnvironment(settings.proxy);
    } catch (err) {
      log("could not load settings; using system proxy", err);
    }
    updates.onChange((state) => sendToRenderer({ kind: "updates/state", state }));
    setupIpc();
    startScheduler();
    createWindow();
    createTray();
    if (process.env.SENASTR_E2E && win) runE2eSmoke(win);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Stay resident in the tray (macOS keeps the app alive without windows by
    // convention; the tray makes the same true everywhere).
    if (process.platform !== "darwin" && !closeToTray) app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    shuttingDown = true;
    if (schedulerTimer) clearInterval(schedulerTimer);
    try {
      host?.dispose();
    } catch {
      /* already gone */
    }
  });
}
