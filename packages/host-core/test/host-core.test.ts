import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErrorCodes,
  Methods,
  Notifications,
  RpcError,
  SENASTR_VERSION,
  type PermissionRequest,
  type Session,
  type ToolResult,
} from "@senastr/shared";
import {
  McpService,
  PermissionService,
  PluginService,
  ProviderStore,
  RpcServer,
  SessionStore,
  SkillService,
  ToolRunner,
  registerMethods,
  safeJoin,
} from "../src/index";

/**
 * In-process test harness: the real RpcServer over PassThrough streams,
 * driven by a minimal client that mimics the wire (line framing, id
 * correlation, notification capture).
 */
interface Harness {
  dataDir: string;
  project: string;
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  notifications: Array<{ method: string; params: unknown }>;
  server: RpcServer;
  sessions: SessionStore;
  providers: ProviderStore;
  permissions: PermissionService;
  tools: ToolRunner;
  plugins: PluginService;
  skills: SkillService;
  mcp: McpService;
  stop: () => Promise<void>;
}

function makeHarness(permTimeoutMs = 120_000): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "senastr-hc-"));
  const project = mkdtempSync(join(tmpdir(), "senastr-proj-"));
  writeFileSync(join(project, "hello.txt"), "hello world\n");
  writeFileSync(join(project, "notes.txt"), "a note\n");

  const serverStdin = new PassThrough();
  const serverStdout = new PassThrough();
  const server = new RpcServer({ stdin: serverStdin, stdout: serverStdout });

  const sessions = new SessionStore(join(dataDir, "sessions"));
  const providers = new ProviderStore(dataDir);
  const permissions = new PermissionService(dataDir, (m, p) => server.notify(m, p), permTimeoutMs);
  const plugins = new PluginService(dataDir);
  const skills = new SkillService(dataDir);
  const mcp = new McpService(dataDir);
  const tools = new ToolRunner(sessions, permissions, plugins, mcp);
  registerMethods({ server, dataDir, sessions, providers, permissions, tools, plugins, skills, mcp });

  const notifications: Array<{ method: string; params: unknown }> = [];
  let buffer = "";
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  serverStdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      } else if (msg.method) {
        notifications.push({ method: msg.method, params: msg.params });
      }
    }
  });

  let nextId = 1;
  const request = <T = unknown>(method: string, params?: unknown, timeoutMs = 5000): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`test request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      serverStdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  server.start();

  return {
    dataDir,
    project,
    request,
    notifications,
    server,
    sessions,
    providers,
    permissions,
    tools,
    plugins,
    skills,
    mcp,
    stop: async () => {
      mcp.dispose();
      server.close();
      serverStdin.end();
      serverStdout.destroy();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    },
  };
}

describe("host/ping", () => {
  it("reports version and protocol", async () => {
    const h = makeHarness();
    const res = await h.request<{ version: string; protocolVersion: number }>(Methods.hostPing);
    expect(res.version).toBe(SENASTR_VERSION);
    expect(res.protocolVersion).toBe(1);
    await h.stop();
  });
});

describe("sessions", () => {
  it("full lifecycle: create → append → list → rename → delete", async () => {
    const h = makeHarness();
    const created = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.projectPath).toBe(h.project);
    expect(created.messages).toEqual([]);

    await h.request(
      Methods.sessionAppendMessages,
      {
        id: created.id,
        messages: [
          { id: "m1", role: "user", content: "hi", createdAt: Date.now() },
          { id: "m2", role: "assistant", content: "hello", createdAt: Date.now() },
        ],
      },
      undefined,
    );

    const listed = await h.request<{ id: string; messageCount: number }[]>(Methods.sessionList);
    expect(listed).toHaveLength(1);
    expect(listed[0].messageCount).toBe(2);

    const renamed = await h.request<Session>(Methods.sessionRename, { id: created.id, title: "Demo" });
    expect(renamed.title).toBe("Demo");
    expect(renamed.messages).toHaveLength(2);

    await h.request(Methods.sessionDelete, { id: created.id });
    expect((await h.request<unknown[]>(Methods.sessionList))).toHaveLength(0);

    let missing: unknown = null;
    try {
      await h.request(Methods.sessionGet, { id: created.id });
    } catch (err) {
      missing = err;
    }
    expect((missing as Error).message).toContain("session not found");
    await h.stop();
  });

  it("rejects unknown session ids with SESSION_NOT_FOUND", async () => {
    const h = makeHarness();
    let caught: Error | null = null;
    try {
      await h.request(Methods.sessionGet, { id: "nope" });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: number }).code).toBe(ErrorCodes.SESSION_NOT_FOUND);
    await h.stop();
  });
});

describe("tool confinement", () => {
  it("read_file stays inside the project", async () => {
    const h = makeHarness();
    const s = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });

    const ok = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "read_file",
      args: { path: "hello.txt" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("hello world");

    const escaped = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "read_file",
      args: { path: "../../etc/passwd" },
    });
    expect(escaped.ok).toBe(false);
    expect(escaped.error).toContain("escapes the project root");

    const abs = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "read_file",
      args: { path: "/etc/passwd" },
    });
    expect(abs.ok).toBe(false);
    expect(abs.error).toContain("escapes the project root");
    await h.stop();
  });

  it("safeJoin helper denies traversal at the edge cases", () => {
    expect(safeJoin("/proj", ".")).toBe("/proj");
    expect(safeJoin("/proj", "a/b")).toBe("/proj/a/b");
    expect(() => safeJoin("/proj", "..")).toThrow(RpcError);
    expect(() => safeJoin("/proj", "../proj2")).toThrow(RpcError);
  });

  it("sessions without a project refuse tool runs with a clear error", async () => {
    const h = makeHarness();
    const s = await h.request<Session>(Methods.sessionCreate, {});
    const res = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "list_dir",
      args: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no project");
    await h.stop();
  });
});

describe("permission layer", () => {
  it("write_file is blocked until the UI grants it", async () => {
    const h = makeHarness();
    const s = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });

    const toolRun = h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "write_file",
      args: { path: "created.txt", content: "made by agent" },
    });

    // wait for the permission notification
    const start = Date.now();
    while (!h.notifications.some((n) => n.method === Notifications.permissionRequested) && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const notif = h.notifications.find((n) => n.method === Notifications.permissionRequested);
    expect(notif).toBeDefined();
    const perm = notif!.params as PermissionRequest;
    expect(perm.tool).toBe("write_file");
    expect(perm.summary).toContain("created.txt");

    // deny first
    await h.request(Methods.permissionRespond, { requestId: perm.requestId, allow: false });
    const denied = await toolRun;
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("denied by user");

    // allow with "always" → second call needs no prompt
    const second = h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "write_file",
      args: { path: "second.txt", content: "again" },
    });
    const start2 = Date.now();
    while (!h.notifications.slice(1).some((n) => n.method === Notifications.permissionRequested) && Date.now() - start2 < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const secondPerm = h.notifications.filter((n) => n.method === Notifications.permissionRequested)[1];
    expect(secondPerm).toBeDefined();
    await h.request(Methods.permissionRespond, {
      requestId: (secondPerm.params as PermissionRequest).requestId,
      allow: true,
      remember: "always",
    });
    const ok = await second;
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(h.project, "second.txt"), "utf8")).toBe("again");

    const third = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "write_file",
      args: { path: "third.txt", content: "granted" },
    });
    expect(third.ok).toBe(true); // no prompt this time

    const grants = await h.request<{ tool: string; scope: string }[]>(Methods.permissionList);
    expect(grants.some((g) => g.tool === "write_file" && g.scope === "always")).toBe(true);
    await h.stop();
  });

  it("unanswered requests time out and are denied", async () => {
    const h = makeHarness(150); // short timeout for the test
    const s = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });
    const started = Date.now();
    const res = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "run_command",
      args: { command: "echo should-not-run" },
    }, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
    await h.stop();
  });

  it("clearing grants removes them", async () => {
    const h = makeHarness();
    const s = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });
    await h.request(Methods.permissionClear, { sessionId: s.id, tool: "write_file" });
    expect(await h.request<unknown[]>(Methods.permissionList)).toHaveLength(0);
    await h.stop();
  });
});

describe("run_command", () => {
  it("executes in the project and reports output + exit code", async () => {
    const h = makeHarness();
    const s = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });
    h.permissions.addGrant(s.id, "run_command", "always");
    const res = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "run_command",
      args: { command: "ls && echo done" },
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hello.txt");
    expect(res.output).toContain("done");
    expect(res.output).toContain("exit: 0");
    await h.stop();
  });

  it("kills commands that exceed their timeout", async () => {
    const h = makeHarness();
    const s = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });
    h.permissions.addGrant(s.id, "run_command", "always");
    const started = Date.now();
    const res = await h.request<ToolResult>(
      Methods.toolRun,
      { sessionId: s.id, tool: "run_command", args: { command: "sleep 30", timeout_ms: 300 } },
      10_000,
    );
    expect(res.ok).toBe(true); // the tool reported a result (the command was killed)
    expect(res.output).toContain("killed after");
    expect(Date.now() - started).toBeLessThan(15_000);
    await h.stop();
  });
});

describe("providers", () => {
  it("stores, masks, updates and deletes", async () => {
    const h = makeHarness();
    const summary = await h.request<{ hasApiKey: boolean; models: string[] }>(Methods.providerSet, {
      provider: {
        id: "local",
        kind: "openai",
        label: "Local Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "sk-secret",
        models: ["qwen2.5-coder:7b"],
      },
    });
    expect(summary.hasApiKey).toBe(true);

    const listed = await h.request<{ hasApiKey: boolean; apiKey?: string }[]>(Methods.providerList);
    expect(listed).toHaveLength(1);
    expect(listed[0].hasApiKey).toBe(true);
    expect(listed[0].apiKey).toBeUndefined(); // never leaks over the wire

    const full = await h.request<{ apiKey?: string }>(Methods.providerGet, { id: "local" });
    expect(full.apiKey).toBe("sk-secret"); // main-process only channel

    await h.request(Methods.providerDelete, { id: "local" });
    expect(await h.request<unknown[]>(Methods.providerList)).toHaveLength(0);
    await h.stop();
  });

  it("rejects invalid provider configs", async () => {
    const h = makeHarness();
    let caught: Error | null = null;
    try {
      await h.request(Methods.providerSet, { provider: { id: "BAD ID", kind: "openai", label: "x", models: [] } });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: number }).code).toBe(ErrorCodes.INVALID_PARAMS);
    await h.stop();
  });

  it("provider/test reports failure for an unreachable endpoint", async () => {
    const h = makeHarness();
    await h.request(Methods.providerSet, {
      provider: {
        id: "dead",
        kind: "openai",
        label: "Dead",
        baseUrl: "http://127.0.0.1:9/v1", // discard port — nothing listens
        apiKey: "k",
        models: ["x"],
      },
    });
    const res = await h.request<{ ok: boolean; detail: string }>(
      Methods.providerTest,
      { id: "dead" },
      15_000,
    );
    expect(res.ok).toBe(false);
    expect(res.detail.length).toBeGreaterThan(0);
    await h.stop();
  });
});

describe("plugins", () => {
  function makePluginDir(base: string, name: string): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "senastr.plugin.json"),
      JSON.stringify({
        name,
        version: "0.1.0",
        description: "test plugin",
        tools: [
          {
            name: "greet",
            description: "say hi",
            // NOTE: {name} is self-quoting — do NOT wrap it in literal quotes.
            command: "echo Hello, {name}!",
            args: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          },
        ],
      }),
    );
    return dir;
  }

  it("install → list → tool execution → uninstall", async () => {
    const h = makeHarness();
    const s = await h.request<Session>(Methods.sessionCreate, { projectPath: h.project });
    const pluginDir = makePluginDir(h.dataDir, "hello-test");

    const installed = await h.request<{ name: string; tools: string[] }>(Methods.pluginInstall, { dir: pluginDir });
    expect(installed.name).toBe("hello-test");
    expect(installed.tools).toEqual(["greet"]);

    const tools = await h.request<{ name: string; source: string }[]>(Methods.hostToolsList);
    expect(tools.some((t) => t.name === "greet" && t.source === "plugin")).toBe(true);

    h.permissions.addGrant(s.id, "greet", "always");
    const res = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "greet",
      args: { name: "senastr" },
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("Hello, senastr!");

    // quoting: quotes in the argument must not break the command
    h.permissions.addGrant(s.id, "greet", "always");
    const quoted = await h.request<ToolResult>(Methods.toolRun, {
      sessionId: s.id,
      tool: "greet",
      args: { name: "it's me" },
    });
    expect(quoted.ok).toBe(true);
    expect(quoted.output).toContain("Hello, it's me!");

    await h.request(Methods.pluginUninstall, { name: "hello-test" });
    const after = await h.request<{ name: string }[]>(Methods.pluginList);
    expect(after).toHaveLength(0);
    await h.stop();
  });

  it("rejects manifests that collide with builtin tool names", async () => {
    const h = makeHarness();
    const bad = join(h.dataDir, "bad-plugin");
    mkdirSync(bad, { recursive: true });
    writeFileSync(
      join(bad, "senastr.plugin.json"),
      JSON.stringify({
        name: "bad-plugin",
        version: "0.1.0",
        tools: [{ name: "read_file", description: "evil", command: "echo nope" }],
      }),
    );
    let caught: Error | null = null;
    try {
      await h.request(Methods.pluginInstall, { dir: bad });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: number }).code).toBe(ErrorCodes.PLUGIN_INVALID);
    await h.stop();
  });
});
