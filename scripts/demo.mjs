#!/usr/bin/env node
/**
 * senastr headless demo.
 *
 * Boots the real host-core sidecar over NDJSON JSON-RPC (exactly the same
 * transport the desktop uses), then exercises it:
 *   1. ping / tool catalog
 *   2. session + project setup
 *   3. read tool (no approval)
 *   4. write tool → permission prompt → deny
 *   5. write tool → permission prompt → allow "always"
 *   6. shell tool
 *   7. plugin install + plugin tool execution
 *   8. (optional) a REAL model turn via the agent runtime
 *
 * Real model turn — set these and re-run:
 *   SENASTR_DEMO_KIND=openai|anthropic
 *   SENASTR_DEMO_MODEL=<model id>
 *   SENASTR_DEMO_API_KEY=<key>
 *   SENASTR_DEMO_BASE_URL=<optional endpoint>
 *   SENASTR_DEMO_PROMPT=<optional prompt>
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostScript = join(root, "packages", "host-core", "dist", "main.js");

if (!existsSync(hostScript)) {
  console.error("host-core is not built yet — run `pnpm build:packages` first.");
  process.exit(1);
}

// ---------------------------------------------------------------- sidecar --
const dataDir = process.env.SENASTR_DATA_DIR ?? mkdtempSync(join(tmpdir(), "senastr-demo-data-"));
const project = mkdtempSync(join(tmpdir(), "senastr-demo-project-"));
writeFileSync(join(project, "hello.txt"), "Hello from the senastr demo!\n");
writeFileSync(
  join(project, "README.md"),
  "# demo project\n\nA tiny project used by `pnpm demo` to exercise the senastr host core.\n",
);

const child = spawn(process.execPath, [hostScript, "--data-dir", dataDir], {
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
const notifications = [];
let lineBuffer = "";

child.stdout.on("data", (chunk) => {
  lineBuffer += chunk.toString("utf8");
  let idx;
  while ((idx = lineBuffer.indexOf("\n")) >= 0) {
    const line = lineBuffer.slice(0, idx).trim();
    lineBuffer = lineBuffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else res(msg.result);
    } else if (msg.method) {
      notifications.push({ method: msg.method, params: msg.params });
    }
  }
});

child.on("exit", (code) => {
  for (const { rej } of pending.values()) rej(new Error("sidecar exited"));
});

function request(method, params, timeoutMs = 10_000) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      res: (v) => {
        clearTimeout(timer);
        res(v);
      },
      rej: (e) => {
        clearTimeout(timer);
        rej(e);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const waitNotification = async (method, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = notifications.find((n) => n.method === method);
    if (found) {
      notifications.splice(notifications.indexOf(found), 1);
      return found;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for notification ${method}`);
};

const line = (label) => console.log(`\n\x1b[1m\u25B8 ${label}\x1b[0m`);

try {
  line("1. host/ping");
  const ping = await request("host/ping");
  console.log(`   host-core ${ping.version} (protocol v${ping.protocolVersion}) — data: ${ping.dataDir}`);

  line("2. tool catalog");
  const tools = await request("host/tools/list");
  console.log(`   ${tools.map((t) => `${t.name} [${t.risk}]`).join(", ")}`);

  line("3. session + project");
  const session = await request("session/create", { projectPath: project, title: "demo" });
  console.log(`   session ${session.id.slice(0, 8)}… → ${project}`);

  line("4. read_file (no approval needed)");
  const read = await request("tool/run", { sessionId: session.id, tool: "read_file", args: { path: "hello.txt" } });
  console.log(`   ok=${read.ok}\n   ${read.output}`);

  line("5. write_file → permission prompt → DENY");
  const writeRun = request("tool/run", {
    sessionId: session.id,
    tool: "write_file",
    args: { path: "secret.txt", content: "do not create me" },
  });
  const perm1 = await waitNotification("permission/requested");
  console.log(`   prompt: "${perm1.params.summary}"`);
  await request("permission/respond", { requestId: perm1.params.requestId, allow: false });
  const denied = await writeRun;
  console.log(`   result: ok=${denied.ok} — ${denied.error}`);

  line("6. write_file → permission prompt → ALLOW (always)");
  const writeRun2 = request("tool/run", {
    sessionId: session.id,
    tool: "write_file",
    args: { path: "from-agent.txt", content: "created by the agent loop\n" },
  });
  const perm2 = await waitNotification("permission/requested");
  console.log(`   prompt: "${perm2.params.summary}"`);
  await request("permission/respond", { requestId: perm2.params.requestId, allow: true, remember: "always" });
  const allowed = await writeRun2;
  console.log(`   result: ok=${allowed.ok} — ${allowed.output}`);
  console.log(`   on disk: ${readFileSync(join(project, "from-agent.txt"), "utf8").trim()}`);

  line("7. run_command (already granted for write; exec asks again)");
  const shellRun = request("tool/run", {
    sessionId: session.id,
    tool: "run_command",
    args: { command: "ls -1" },
  });
  const perm3 = await waitNotification("permission/requested");
  await request("permission/respond", { requestId: perm3.params.requestId, allow: true, remember: "always" });
  const shell = await shellRun;
  console.log(`   ${shell.output}`);

  line("8. plugin install + plugin tool");
  const pluginDir = join(root, "examples", "plugins", "hello-senastr");
  const installed = await request("plugin/install", { dir: pluginDir });
  console.log(`   installed ${installed.name} v${installed.version} (tools: ${installed.tools.join(", ")})`);
  const pluginRun = request("tool/run", {
    sessionId: session.id,
    tool: "greet",
    args: { name: "you" },
  });
  const perm4 = await waitNotification("permission/requested");
  await request("permission/respond", { requestId: perm4.params.requestId, allow: true, remember: "always" });
  const greeted = await pluginRun;
  console.log(`   ${greeted.output?.trim()}`);

  // --------------------------------------------------- optional real turn --
  const kind = process.env.SENASTR_DEMO_KIND;
  const model = process.env.SENASTR_DEMO_MODEL;
  const apiKey = process.env.SENASTR_DEMO_API_KEY;
  if (kind && model && apiKey) {
    line("9. REAL model turn through the agent runtime");
    await request("provider/set", {
      provider: {
        id: "demo",
        kind,
        label: "demo",
        baseUrl: process.env.SENASTR_DEMO_BASE_URL,
        apiKey,
        models: [model],
        defaultModel: model,
      },
    });
    const { AgentRuntime } = require(join(root, "packages", "agent-runtime", "dist", "index.js"));
    const { Methods } = require(join(root, "packages", "shared", "dist", "index.js"));
    const hostBridge = {
      getSession: (id) => request(Methods.sessionGet, { id }),
      appendMessages: (id, messages) => request(Methods.sessionAppendMessages, { id, messages }),
      listTools: () => request(Methods.hostToolsList),
      runTool: (req) => request(Methods.toolRun, req, undefined, 300_000),
    };
    // tool/run may wait on a permission prompt; auto-approve from this script
    const autoApprove = setInterval(() => {
      const found = notifications.find((n) => n.method === "permission/requested");
      if (found) {
        notifications.splice(notifications.indexOf(found), 1);
        console.log(`   (auto-approved: ${found.params.summary})`);
        void request("permission/respond", {
          requestId: found.params.requestId,
          allow: true,
          remember: "always",
        });
      }
    }, 100);

    const runtime = new AgentRuntime(hostBridge);
    const prompt =
      process.env.SENASTR_DEMO_PROMPT ?? "List the files in this project and give it a one-sentence description.";
    console.log(`   prompt: ${prompt}`);
    const turn = runtime.runTurn({
      sessionId: session.id,
      userMessage: prompt,
      model: { kind, model, baseUrl: process.env.SENASTR_DEMO_BASE_URL, apiKey },
    });
    process.stdout.write("   assistant: ");
    for await (const ev of turn) {
      if (ev.type === "assistant/delta") process.stdout.write(ev.delta);
      else if (ev.type === "tool/call") process.stdout.write(`\n   [tool] ${ev.call.name} ${JSON.stringify(ev.call.arguments)}`);
      else if (ev.type === "tool/result") process.stdout.write(`\n   [tool→] ${ev.result.ok ? "ok" : `fail: ${ev.result.error}`}`);
      else if (ev.type === "turn/end") {
        process.stdout.write("\n");
        console.log(`   stopReason: ${ev.stopReason}${ev.error ? ` — ${ev.error}` : ""}`);
      }
    }
    clearInterval(autoApprove);
  } else {
    line("9. real model turn skipped (set SENASTR_DEMO_KIND/SENASTR_DEMO_MODEL/SENASTR_DEMO_API_KEY to try)");
  }

  console.log("\n\x1b[32m✓ senastr core demo complete\x1b[0m");
} catch (err) {
  console.error("\n✗ demo failed:", err);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
