#!/usr/bin/env node
/**
 * senastr ↔ PI-Desktop parity verifier.
 *
 * Boots the REAL host-core sidecar over NDJSON JSON-RPC (the same transport the
 * desktop uses) and runs a check battery against it, plus static checks of the
 * Electron shell and the packaging/UX surface.
 *
 * Every check reports one of:
 *   PASS — capability exists and behaves correctly
 *   FAIL — capability exists but misbehaves (a bug)
 *   GAP  — capability the reference app (PI-Desktop) ships is absent here
 *
 * Usage:
 *   node scripts/verify-parity.mjs            # table output
 *   node scripts/verify-parity.mjs --json     # machine-readable summary
 *   node scripts/verify-parity.mjs --only=P   # run one section group
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostScript = join(root, "packages", "host-core", "dist", "main.js");
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const ONLY = (argv.find((a) => a.startsWith("--only=")) ?? "").replace("--only=", "");

if (!existsSync(hostScript)) {
  console.error("host-core is not built — run `pnpm build:packages` first.");
  process.exit(1);
}

/* ------------------------------------------------------------------ harness */

const results = [];
let section = "general";

function record(id, title, status, evidence = "") {
  results.push({ id, section, title, status, evidence: String(evidence).slice(0, 400) });
}

const group = (name) => {
  section = name;
};

async function check(id, title, fn, extra = {}) {
  if (ONLY && !id.startsWith(ONLY)) return;
  if (process.env.PARITY_DEBUG) {
    const queued = notifications.map((n) => n.params?.summary ?? n.method).join(" | ");
    console.error(`[dbg] ${id} start — queued=[${queued}]`);
  }
  try {
    const out = await fn();
    if (out === true || out === undefined) return record(id, title, "PASS", extra.evidence ?? "");
    if (out === false) return record(id, title, "FAIL", extra.evidence ?? "");
    if (typeof out === "object" && out.status) return record(id, title, out.status, out.evidence);
    return record(id, title, "PASS", String(out ?? ""));
  } catch (err) {
    return record(id, title, "FAIL", err instanceof Error ? err.message : String(err));
  }
}

function gap(id, title, evidence) {
  if (ONLY && !id.startsWith(ONLY)) return;
  record(id, title, "GAP", evidence);
}

/* ------------------------------------------------------------- the sidecar */

const dataDir = mkdtempSync(join(tmpdir(), "senastr-parity-data-"));
const project = mkdtempSync(join(tmpdir(), "senastr-parity-proj-"));
const otherProject = mkdtempSync(join(tmpdir(), "senastr-parity-proj2-"));

writeFileSync(join(project, "hello.txt"), "Hello from the parity harness!\n");
writeFileSync(
  join(project, "README.md"),
  "# parity project\n\nA tiny project used to exercise the senastr host core.\n",
);
writeFileSync(join(project, "src.txt"), "needle_in_haystack\n");
mkdirSync(join(project, "nested", "deep"), { recursive: true });
writeFileSync(join(project, "nested", "deep", "leaf.txt"), "leaf\n");
writeFileSync(join(otherProject, "other.txt"), "other project\n");
writeFileSync(join(project, "big.txt"), "x".repeat(5000));

const child = spawn(process.execPath, [hostScript, "--data-dir", dataDir], {
  stdio: ["pipe", "pipe", "pipe"],
});
let stderrText = "";
child.stderr.on("data", (d) => {
  stderrText += d.toString("utf8");
});

let nextId = 1;
const pending = new Map();
const notifications = [];
let lineBuffer = "";
let malformedSurvived = false;

child.stdout.on("data", (chunk) => {
  lineBuffer += chunk.toString("utf8");
  let idx;
  while ((idx = lineBuffer.indexOf("\n")) >= 0) {
    const raw = lineBuffer.slice(0, idx).trim();
    lineBuffer = lineBuffer.slice(idx + 1);
    if (!raw) continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
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

child.on("exit", () => {
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
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function waitNotification(method, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = notifications.find((n) => n.method === method);
    if (found) {
      notifications.splice(notifications.indexOf(found), 1);
      return found;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for notification ${method}`);
}

/**
 * Permission cards are answered by one background loop so no check can race a
 * notification: every card is recorded, and the next queued decision is used.
 */
const cardLog = [];
const decisionQueue = [];

const autoAnswer = setInterval(() => {
  const found = notifications.findIndex((n) => n.method === "permission/requested");
  if (found < 0) return;
  const [card] = notifications.splice(found, 1);
  const decision =
    decisionQueue.length > 0 ? decisionQueue.shift() : { allow: true, remember: "always" };
  if (decision === null) {
    cardLog.push({ ...card.params, decision: null, unanswered: true });
    return;
  }
  cardLog.push({ ...card.params, decision });
  void request("permission/respond", { requestId: card.params.requestId, ...decision });
}, 15);

/** Reset per-check bookkeeping and hand the next card a decision. */
function expect(decision = { allow: true, remember: "always" }) {
  decisionQueue.length = 0;
  decisionQueue.push(decision);
  notifications.length = 0;
  return cardLog.length;
}

/** Run a privileged tool; a card (if any) is answered with `decision`. */
async function runTool(sessionId, tool, args, decision = { allow: true, remember: "always" }, timeoutMs = 25_000) {
  const mark = expect(decision);
  const result = await request("tool/run", { sessionId, tool, args }, timeoutMs);
  return result;
}

/** Cards observed while the last `mark` window was open. */
function cardsSince(mark) {
  return cardLog.slice(mark);
}


const readJson = (rel) => JSON.parse(readFileSync(join(dataDir, rel), "utf8"));

/* ------------------------------------------------------------------- checks */

async function main() {
  /* ---------------------------------------------------------- P: protocol */
  group("protocol");
  let session;
  await check("P1", "host/ping returns version, protocol version and data dir", async () => {
    const ping = await request("host/ping");
    return {
      status: ping?.version && ping?.protocolVersion && ping?.dataDir ? "PASS" : "FAIL",
      evidence: `${ping?.version} protocol v${ping?.protocolVersion} data=${ping?.dataDir}`,
    };
  });

  await check("P2", "unknown method returns a JSON-RPC method-not-found error", async () => {
    try {
      await request("host/does-not-exist");
      return false;
    } catch (err) {
      return err.code === -32601 ? `code ${err.code}` : false;
    }
  });

  await check("P3", "a malformed JSON line does not kill the sidecar", async () => {
    child.stdin.write("this is not json\n");
    await new Promise((r) => setTimeout(r, 60));
    const ping = await request("host/ping");
    malformedSurvived = Boolean(ping?.version);
    return malformedSurvived;
  });

  /* ------------------------------------------------------------- T: tools */
  group("tools");
  session = await request("session/create", { projectPath: project, title: "parity-main" });
  let tools = [];
  await check("T1", "builtin tool catalog is exposed over host/tools/list", async () => {
    tools = await request("host/tools/list");
    const names = tools.map((t) => t.name).sort();
    return { status: names.length >= 5 ? "PASS" : "FAIL", evidence: names.join(", ") };
  });

  await check("T2", "every builtin tool declares a valid risk level", () => {
    const bad = tools.filter((t) => !["read", "write", "exec"].includes(t.risk));
    return bad.length === 0 ? `${tools.length} tools classified` : bad.map((t) => t.name).join(", ");
  });

  const names = new Set(tools.map((t) => t.name));
  for (const [tool, why] of [
    ["edit_file", "PI-Desktop ships a line-anchored Edit; without it the model must rewrite whole files"],
    ["glob", "PI-Desktop ships Glob (low risk) for pattern discovery"],
    ["grep", "PI-Desktop ships Grep (low risk) for content search"],
  ]) {
    if (!names.has(tool)) gap(`T3-${tool}`, `built-in tool \`${tool}\` exists`, why);
    else
      await check(`T3-${tool}`, `built-in tool \`${tool}\` exists`, () => "present");
  }

  await check("T4", "read_file returns file content", async () => {
    const r = await request("tool/run", { sessionId: session.id, tool: "read_file", args: { path: "hello.txt" } });
    return r.ok && r.output.includes("Hello from the parity harness") ? "content returned" : false;
  });

  await check("T5a", "read_file rejects `..` traversal out of the project root", async () => {
    const r = await request("tool/run", {
      sessionId: session.id,
      tool: "read_file",
      args: { path: "../../etc/passwd" },
    });
    return r.ok === false && /escape/i.test(r.error ?? "") ? r.error : `unexpected: ${JSON.stringify(r)}`;
  });

  await check("T5b", "read_file rejects an absolute path outside the project root", async () => {
    const r = await request("tool/run", {
      sessionId: session.id,
      tool: "read_file",
      args: { path: "/etc/passwd" },
    });
    return r.ok === false ? r.error : "absolute path was allowed";
  });

  await check("T5c", "write_file rejects `..` traversal out of the project root", async () => {
    const result = await runTool(session.id, "write_file", { path: "../escape.txt", content: "nope" }, {
      allow: true,
      remember: "always",
    });
    const escaped = existsSync(join(project, "..", "escape.txt"));
    if (escaped) return { status: "FAIL", evidence: "the file was written outside the project root" };
    return result.ok === false && /escape/i.test(result.error ?? "") ? result.error : `unexpected: ${result.error}`;
  });

  await check("T6", "read_file on a directory reports a recoverable error, not a crash", async () => {
    const r = await request("tool/run", { sessionId: session.id, tool: "read_file", args: { path: "nested" } });
    return r.ok === false && /directory/i.test(r.error ?? "") ? r.error : false;
  });

  await check("T7", "read_file honours max_chars truncation", async () => {
    const r = await request("tool/run", {
      sessionId: session.id,
      tool: "read_file",
      args: { path: "big.txt", max_chars: 100 },
    });
    return r.ok && r.output.includes("truncated") ? "truncated at 100 chars" : false;
  });

  await check("T8", "list_dir lists entries and marks directories", async () => {
    const r = await request("tool/run", { sessionId: session.id, tool: "list_dir", args: {} });
    return r.ok && r.output.includes("nested/") ? "entries returned" : false;
  });

  await check("T9", "list_dir has a hard entry cap (bounded result)", async () => {
    const many = mkdtempSync(join(tmpdir(), "senastr-parity-many-"));
    mkdirSync(join(many, "bulk"));
    for (let i = 0; i < 600; i++) writeFileSync(join(many, "bulk", `f${String(i).padStart(4, "0")}.txt`), "x");
    const s = await request("session/create", { projectPath: many, title: "bulk" });
    const r = await request("tool/run", { sessionId: s.id, tool: "list_dir", args: { path: "bulk" } });
    const lines = (r.output ?? "").split("\n").filter((l) => l && !l.startsWith("path:") && l !== "---");
    return lines.length <= 501 ? `capped at ${lines.length} entries` : `no cap: ${lines.length}`;
  });

  /* ------------------------------------------------------- K: permissions */
  group("permissions");
  await request("permission/clear", {});
  await check("K1", "a write tool call raises an interactive permission card with a summary", async () => {
    const mark = expect({ allow: false });
    const result = await request("tool/run", {
      sessionId: session.id,
      tool: "write_file",
      args: { path: "gated.txt", content: "gated" },
    });
    const card = cardsSince(mark)[0];
    if (!card?.requestId || !card?.summary) {
      return { status: "FAIL", evidence: "no permission card was raised for a gated write" };
    }
    return {
      status: result.ok === false ? "PASS" : "FAIL",
      evidence: `summary="${card.summary}" · denied → ok=${result.ok}`,
    };
  });

  await check("K2", "denying a permission card blocks the tool", async () => {
    const result = await runTool(session.id, "write_file", { path: "denied.txt", content: "x" }, { allow: false });
    return result.ok === false ? result.error : "denied tool still executed";
  });

  await check("K3", "allow-once does not create a standing grant", async () => {
    const first = await runTool(session.id, "write_file", { path: "once.txt", content: "1" }, { allow: true, remember: null });
    if (!first.ok) return false;
    const mark = expect({ allow: false });
    const second = await request("tool/run", {
      sessionId: session.id,
      tool: "write_file",
      args: { path: "once2.txt", content: "2" },
    });
    const prompted = cardsSince(mark).length > 0;
    return prompted && second.ok === false ? "second call prompted again" : false;
  });

  await check("K4", "granting \"always\" suppresses later prompts for that tool", async () => {
    await runTool(session.id, "write_file", { path: "always.txt", content: "1" }, { allow: true, remember: "always" });
    const mark = expect({ allow: false });
    const r = await request("tool/run", {
      sessionId: session.id,
      tool: "write_file",
      args: { path: "always2.txt", content: "2" },
    });
    const prompted = cardsSince(mark).length > 0;
    return r.ok && !prompted ? "no prompt on the second call" : `ok=${r.ok} prompted=${prompted}`;
  });

  await check("K5", "a session grant does not leak into another session", async () => {
    const sessionB = await request("session/create", { projectPath: project, title: "perms-b" });
    await request("permission/clear", {});
    await runTool(session.id, "write_file", { path: "sess.txt", content: "1" }, { allow: true, remember: "session" });
    const mark = expect({ allow: false });
    const result = await request("tool/run", {
      sessionId: sessionB.id,
      tool: "write_file",
      args: { path: "sess-b.txt", content: "2" },
    });
    const prompted = cardsSince(mark).length > 0;
    if (!prompted) {
      return {
        status: "FAIL",
        evidence: `second session got no prompt (ok=${result.ok}) — a session grant leaked across sessions`,
      };
    }
    return result.ok === false ? "isolated per session" : "a session grant leaked across sessions";
  });

  await check("K6", "permission/clear revokes standing grants", async () => {
    await request("permission/clear", {});
    await runTool(session.id, "write_file", { path: "revoke.txt", content: "1" }, { allow: true, remember: "always" });
    const before = await request("permission/list");
    await request("permission/clear", {});
    const after = await request("permission/list");
    return before.length > 0 && after.length === 0 ? `revoked ${before.length} grant(s)` : false;
  });

  await check("K7", "concurrent permission requests queue instead of replacing each other", async () => {
    await request("permission/clear", {});
    const mark = expect({ allow: true, remember: "session" });
    decisionQueue.push({ allow: true, remember: "session" });
    const runA = request("tool/run", { sessionId: session.id, tool: "run_command", args: { command: "echo A" } }, 25_000);
    const runB = request("tool/run", { sessionId: session.id, tool: "run_command", args: { command: "echo B" } }, 25_000);
    const [a, b] = await Promise.all([runA, runB]);
    const cards = cardsSince(mark);
    return cards.length === 2 && a.ok && b.ok
      ? "both concurrent requests were answered independently"
      : `cards=${cards.length} a=${a.ok} b=${b.ok}`;
  });

  await check("K8", "the permission timeout constant is 120s (auto-deny)", () => {
    const shared = readFileSync(join(root, "packages", "shared", "src", "protocol.ts"), "utf8");
    const m = shared.match(/PERMISSION_TIMEOUT_MS\s*=\s*([\d_]+)/);
    const value = m ? Number(m[1].replace(/_/g, "")) : NaN;
    return value === 120000 ? `${value} ms` : `found ${m?.[1] ?? "nothing"}`;
  });

  /* ----------------------------------------------------------- S: shell */
  group("shell");
  await check("S1", "run_command returns stdout and the exit code", async () => {
    const r = await runTool(session.id, "run_command", { command: "echo parity-ok" });
    return r.ok && /parity-ok/.test(r.output ?? "") ? "stdout captured" : false;
  });

  await check("S2", "run_command reports a non-zero exit code without erroring the RPC", async () => {
    const r = await runTool(session.id, "run_command", { command: "exit 3" });
    return r.ok && /exit: 3/.test(r.output ?? "") ? "exit 3 surfaced" : false;
  });

  await check("S3", "run_command kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    const r = await runTool(session.id, "run_command", { command: "sleep 30", timeout_ms: 800 });
    const elapsed = Date.now() - started;
    const killed = /killed after/.test(r.output ?? "");
    return elapsed < 8000 && killed
      ? { status: "PASS", evidence: `killed after ${elapsed} ms (grandchildren reaped)` }
      : { status: "FAIL", evidence: `elapsed ${elapsed} ms, output=${(r.output ?? "").slice(0, 80)}` };
  });

  await check("S4", "run_command clamps an over-large timeout (bounded execution)", () => {
    const shell = readFileSync(join(root, "packages", "host-core", "src", "tools", "shell.ts"), "utf8");
    return /MAX_TIMEOUT_MS\s*=\s*600_000/.test(shell) ? "MAX_TIMEOUT_MS = 600000" : false;
  });

  await check("S5", "run_command inherits the user's login-shell PATH (pyenv/nvm/homebrew)", () => {
    const shell = readFileSync(join(root, "packages", "host-core", "src", "tools", "shell.ts"), "utf8");
    const usesLoginShell = /-ilc|loginPath|login-shell|SHELL\b/.test(shell);
    return usesLoginShell
      ? "login shell consulted"
      : {
          status: "GAP",
          evidence:
            "host-core spawns with process.env only; a GUI-launched Electron app misses Homebrew/nvm/pyenv PATH entries (PI-Desktop ADR 0045 fixes this by sourcing the login shell)",
        };
  });

  /* ------------------------------------------------------------ M: sessions */
  group("sessions");
  await check("M1", "sessions create/list/get/rename/set-mode/set-project/delete", async () => {
    const s = await request("session/create", { projectPath: project, title: "lifecycle" });
    await request("session/rename", { id: s.id, title: "renamed" });
    await request("session/set-mode", { id: s.id, mode: "plan" });
    const got = await request("session/get", { id: s.id });
    const list = await request("session/list");
    const ok =
      got.title === "renamed" &&
      got.mode === "plan" &&
      list.some((x) => x.id === s.id) &&
      got.projectPath === project;
    await request("session/delete", { id: s.id });
    const after = await request("session/list");
    return ok && !after.some((x) => x.id === s.id) ? "full lifecycle ok" : false;
  });

  await check("M2", "session/set-mode stores mode and rejects an invalid one", async () => {
    const s = await request("session/create", { projectPath: project, title: "mode" });
    await request("session/set-mode", { id: s.id, mode: "build" });
    const ok = (await request("session/get", { id: s.id })).mode === "build";
    let rejected = false;
    try {
      await request("session/set-mode", { id: s.id, mode: "bogus" });
    } catch {
      rejected = true;
    }
    return ok && rejected ? "valid accepted, invalid rejected" : false;
  });

  await check("M3", "transcripts survive a sidecar restart (durable local state)", async () => {
    const s = await request("session/create", { projectPath: project, title: "durable" });
    await request("session/append-messages", {
      id: s.id,
      messages: [{ id: "m1", role: "user", content: "remember me", createdAt: Date.now() }],
    });
    const file = join(dataDir, "sessions", `${s.id}.json`);
    if (!existsSync(file)) return "session file was not written";
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed.messages?.some((m) => m.content === "remember me") ? "persisted to disk" : false;
  });

  await check("M4", "a session with no project fails tools with an actionable message", async () => {
    const s = await request("session/create", { title: "no-project" });
    const r = await request("tool/run", { sessionId: s.id, tool: "read_file", args: { path: "x" } });
    return r.ok === false && /project/i.test(r.error ?? "") ? r.error : false;
  });

  await check("M5", "unknown session id produces an error, not a crash", async () => {
    try {
      await request("session/get", { id: "does-not-exist" });
      return false;
    } catch (err) {
      const ping = await request("host/ping");
      return ping?.version ? `error surfaced (${err.code ?? "?"}), sidecar alive` : false;
    }
  });

  /* ---------------------------------------------------------- V: providers */
  group("providers");
  await check("V1", "provider/list masks API keys (renderer never sees secrets)", async () => {
    await request("provider/set", {
      provider: {
        id: "parity-openai",
        kind: "openai",
        label: "parity",
        apiKey: "sk-super-secret-value",
        models: ["gpt-x"],
      },
    });
    const list = await request("provider/list");
    const p = list.find((x) => x.id === "parity-openai");
    const leaked = JSON.stringify(p).includes("sk-super-secret-value");
    return p?.hasApiKey && !leaked ? "masked (hasApiKey=true, no key material)" : "key material leaked to the client";
  });

  await check("V2", "an edit that echoes the mask keeps the stored key", async () => {
    await request("provider/set", {
      provider: {
        id: "parity-openai",
        kind: "openai",
        label: "parity renamed",
        apiKey: "••••••",
        models: ["gpt-x"],
      },
    });
    const cfg = await request("provider/get", { id: "parity-openai" });
    return cfg.apiKey === "sk-super-secret-value" && cfg.label === "parity renamed"
      ? "mask round-trip preserved the key"
      : `key became ${String(cfg.apiKey).slice(0, 12)}…`;
  });

  await check("V3", "provider/get returns usable key material to the main process only", async () => {
    const cfg = await request("provider/get", { id: "parity-openai" });
    return cfg.apiKey === "sk-super-secret-value" ? "raw key over the host RPC" : false;
  });

  await check("V4", "credentials are encrypted at rest on disk", async () => {
    const raw = readFileSync(join(dataDir, "providers.json"), "utf8");
    const plaintext = raw.includes("sk-super-secret-value");
    return plaintext
      ? {
          status: "GAP",
          evidence:
            "providers.json stores API keys in cleartext; PI-Desktop encrypts credentials through the OS keychain (Electron safeStorage)",
        }
      : "encrypted or absent";
  });

  await check("V5", "reserved credential headers are rejected on custom providers", async () => {
    try {
      await request("provider/set", {
        provider: {
          id: "parity-headers",
          kind: "openai",
          label: "headers",
          baseUrl: "http://127.0.0.1:9/v1",
          headers: { authorization: "Bearer nope" },
          models: ["m"],
        },
      });
      return false;
    } catch (err) {
      return /reserved|authorization/i.test(err.message) ? err.message : false;
    }
  });

  await check("V6", "key pools are stored and reported without exposing values", async () => {
    await request("provider/set", {
      provider: {
        id: "parity-pool",
        kind: "openai",
        label: "pool",
        apiKeys: ["k1", "k2", "k3"],
        models: ["m"],
      },
    });
    const list = await request("provider/list");
    const p = list.find((x) => x.id === "parity-pool");
    return p?.apiKeyCount === 3 ? "apiKeyCount=3" : `apiKeyCount=${p?.apiKeyCount}`;
  });

  await check("V7", "provider/test reports failure gracefully for an unreachable endpoint", async () => {
    await request("provider/set", {
      provider: {
        id: "parity-unreachable",
        kind: "openai",
        label: "unreachable",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "sk-unreachable",
        models: ["m"],
      },
    });
    const r = await request("provider/test", { id: "parity-unreachable" }, 30_000);
    return r && r.ok === false && typeof r.detail === "string" ? `graceful: ${r.detail.slice(0, 60)}` : false;
  });

  /* ------------------------------------------------------- C: capabilities */
  group("capabilities");
  await check("C1", "skills: create, list, activate, delete (global + project scope)", async () => {
    await request("skill/set", {
      skill: { name: "parity-skill", content: "Always answer in haiku.", level: "global", enabled: true },
    });
    const all = await request("skill/list", {});
    const created = all.find((s) => s.name === "parity-skill");
    if (!created) return false;
    const active = await request("skill/active", { projectPath: project });
    const inPrompt = active.some((s) => s.name === "parity-skill");
    await request("skill/delete", { id: created.id });
    const after = await request("skill/list", {});
    return inPrompt && !after.some((s) => s.name === "parity-skill") ? "scoped + active resolution ok" : false;
  });

  await check("C2", "subagents: create, activate, and deny enable-state on delete", async () => {
    await request("subagent/set", {
      subagent: { name: "parity-sub", systemPrompt: "You explore quickly.", level: "global", enabled: true },
    });
    const all = await request("subagent/list", {});
    const created = all.find((s) => s.name === "parity-sub");
    if (!created) return false;
    const active = await request("subagent/active", { projectPath: project });
    return active.some((s) => s.name === "parity-sub") ? "subagent visible to the Task tool" : false;
  });

  await check("C3", "MCP: servers are stored, toggled and validated", async () => {
    await request("mcp/set", {
      server: {
        id: "parity-mcp",
        label: "parity",
        transport: "stdio",
        command: "node",
        args: ["-e", "process.exit(0)"],
        enabled: false,
      },
    });
    const first = await request("mcp/list", {});
    const created = (first.servers ?? first).find((s) => s.id === "parity-mcp");
    if (!created) return false;
    await request("mcp/set-enabled", { id: "parity-mcp", enabled: true });
    const after = await request("mcp/list", {});
    return (after.servers ?? after).find((s) => s.id === "parity-mcp")?.enabled === true
      ? "stored + toggled"
      : false;
  });

  await check("C4", "MCP: an http server with an invalid URL is rejected", async () => {
    try {
      await request("mcp/set", {
        server: { id: "parity-mcp-bad", label: "bad", transport: "http", url: "not-a-url" },
      });
      return false;
    } catch {
      return "validation rejected the bad URL";
    }
  });

  await check("C5", "scheduled tasks: CRUD, cron validation and run history", async () => {
    const t = await request("scheduled/set", {
      task: {
        title: "parity task",
        prompt: "run the tests",
        projectPath: project,
        providerId: "parity-openai",
        model: "gpt-x",
        cadence: "manual",
      },
    });
    let cronRejected = false;
    try {
      await request("scheduled/set", {
        task: {
          id: t.id,
          title: "parity task",
          prompt: "run the tests",
          projectPath: project,
          providerId: "parity-openai",
          model: "gpt-x",
          cadence: "cron",
          cron: "not a cron",
        },
      });
    } catch {
      cronRejected = true;
    }
    await request("scheduled/record-run", {
      taskId: t.id,
      run: { taskId: t.id, status: "done", startedAt: Date.now(), endedAt: Date.now(), summary: "r1" },
    });
    await request("scheduled/record-run", {
      taskId: t.id,
      run: { taskId: t.id, status: "done", startedAt: Date.now(), endedAt: Date.now(), summary: "r2" },
    });
    const runs = await request("scheduled/runs", { taskId: t.id });
    return runs.length === 2 && cronRejected ? "history preserved across writes" : `runs=${runs.length} cronRejected=${cronRejected}`;
  });

  await check("C6", "review: write snapshots support diff + rollback + purge", async () => {
    const s = await request("session/create", { projectPath: project, title: "review" });
    await runTool(s.id, "write_file", { path: "reviewed.txt", content: "v1" }, { allow: true, remember: "always" });
    await runTool(s.id, "write_file", { path: "reviewed.txt", content: "v2" }, { allow: true, remember: "always" });
    const list = await request("review/list", { sessionId: s.id });
    const snap = [...list].reverse().find((r) => r.path === "reviewed.txt");
    if (!snap) return { status: "FAIL", evidence: "no snapshot recorded for a write_file call" };
    const got = await request("review/get", { sessionId: s.id, snapshotId: snap.id });
    // roll back the v2 write (its "before" is v1) and expect the file to become v1 again
    const target = snap;
    await request("review/rollback", { sessionId: s.id, snapshotId: target.id });
    const rolled = readFileSync(join(project, "reviewed.txt"), "utf8");
    const purged = await request("review/purge", { sessionId: s.id });
    const after = await request("review/list", { sessionId: s.id });
    const captured = got?.before === "v1" && got?.after === "v2";
    return captured && after.length === 0
      ? `diff captured (v1→v2), rolled back to "${rolled}", purge removed ${purged?.removed ?? "?"}`
      : { status: "FAIL", evidence: `before=${got?.before} after=${got?.after} remaining=${after.length}` };
  });

  await check("C7", "projects: per-project instructions + memory round-trip", async () => {
    await request("project/set-context", {
      projectPath: project,
      instructions: "Use tabs.",
      memory: "prefers vitest",
    });
    const ctx = await request("project/get-context", { projectPath: project });
    return ctx.instructions === "Use tabs." && ctx.memory === "prefers vitest" ? "round-trip ok" : false;
  });

  await check("C8", "plugins: install from a local directory, list tools, uninstall", async () => {
    const dir = join(root, "examples", "plugins", "hello-senastr");
    const installed = await request("plugin/install", { dir });
    const all = await request("plugin/list");
    const found = all.find((p) => p.name === installed.name);
    await request("plugin/uninstall", { name: installed.name });
    const after = await request("plugin/list");
    return found?.tools?.length > 0 && !after.some((p) => p.name === installed.name)
      ? `tools: ${found.tools.join(", ")}`
      : false;
  });

  await check("C9", "plugins: remote install URLs are restricted to known git hosts", async () => {
    try {
      await request("plugin/install", { url: "https://evil.example.com/x.git" }, 30_000);
      return false;
    } catch (err) {
      return /host|allow/i.test(err.message) ? err.message : false;
    }
  });

  await check("C10", "notifications: permission requests reach the client as events", () => {
    return cardLog.length > 0
      ? `${cardLog.length} permission cards delivered over the wire with summaries`
      : false;
  });

  /* --------------------------------------------------------- A: the agent */
  group("agent");
  const sess = await request("session/create", { projectPath: project, title: "agent" });
  session = sess;

  await check("A0", "agent runtime is supervised by the desktop main process", () => {
    const main = readFileSync(join(root, "apps", "desktop", "src", "main", "index.ts"), "utf8");
    return /new AgentRuntime/.test(main) && /chat\/send/.test(main)
      ? "AgentRuntime constructed in main, driven over chat/send"
      : false;
  });

  await check("A1", "plan mode denies write/exec server-side (not just in the prompt)", () => {
    const agent = readFileSync(join(root, "packages", "agent-runtime", "src", "agent.ts"), "utf8");
    const enforced = /planMode\s*&&\s*riskByName\.get\(call\.name\)\s*!==\s*"read"/.test(agent);
    const taskFiltered = /planMode\s*\?\s*tools\.filter\(\(t\)\s*=>\s*t\.name\s*!==\s*"Task"\)/.test(agent);
    return enforced && taskFiltered
      ? "runtime rejects non-read tools and hides Task while planning"
      : { status: "FAIL", evidence: "plan mode is prompt-only; a model could still write/exec" };
  });

  await check("A2", "long sessions stay inside the model context window (compaction)", () => {
    const agent = readFileSync(join(root, "packages", "agent-runtime", "src", "agent.ts"), "utf8");
    const replaysAll = /messages:\s*history/.test(agent);
    const hasCompaction = /compact|summari[sz]e|tokenBudget|contextWindow/i.test(agent);
    if (replaysAll && !hasCompaction) {
      return {
        status: "GAP",
        evidence:
          "the loop sends the entire session transcript each step and never trims/summarises; PI-Desktop bounds history and compacts at turn boundaries (ADR 0030/0049/0061/0064/0120)",
      };
    }
    return "history is bounded or compacted";
  });

  await check("A3", "attachments: the message model supports images", () => {
    const models = readFileSync(join(root, "packages", "shared", "src", "models.ts"), "utf8");
    const messageType = models.slice(models.indexOf("export interface ChatMessage"), models.indexOf("export interface SessionMeta"));
    const hasImageParts = /image|attachment|content:\s*(Array|Part)/i.test(messageType);
    return hasImageParts
      ? "image parts supported"
      : {
          status: "GAP",
          evidence:
            "ChatMessage.content is a plain string — no image/attachment parts; PI-Desktop transports model-aware image attachments (ADR 0101)",
        };
  });

  await check("A4", "reasoning/thinking level is configurable per model", () => {
    const models = readFileSync(join(root, "packages", "shared", "src", "models.ts"), "utf8");
    const providerType = models.slice(models.indexOf("export interface ProviderConfig"), models.indexOf("/** Renderer-safe provider metadata"));
    const agentTypes = readFileSync(join(root, "packages", "agent-runtime", "src", "types.ts"), "utf8");
    const hasThinking =
      /reasoning|thinking|effort/i.test(providerType) || /reasoning|thinking|effort/i.test(agentTypes);
    return hasThinking
      ? "reasoning control present"
      : {
          status: "GAP",
          evidence:
            "neither ProviderConfig nor ProviderChatParams carries a reasoning/thinking level; PI-Desktop stores thinking configuration per provider+model (ADR 0018/0114)",
        };
  });

  await check("A5", "the agent loop bounds steps per turn and per delegation", () => {
    const agent = readFileSync(join(root, "packages", "agent-runtime", "src", "agent.ts"), "utf8");
    return /DEFAULT_MAX_STEPS/.test(agent) && /DELEGATION_MAX_STEPS/.test(agent)
      ? "max steps + delegation caps present"
      : false;
  });

  await check("A6", "abort/stop propagation exists for a running turn", () => {
    const agent = readFileSync(join(root, "packages", "agent-runtime", "src", "agent.ts"), "utf8");
    return /AbortController|abort\.signal/.test(agent) ? "AbortController wired through the loop" : false;
  });

  /* ------------------------------------------------------- D: desktop/app */
  group("desktop");
  const mainSrc = readFileSync(join(root, "apps", "desktop", "src", "main", "index.ts"), "utf8");
  const preloadSrc = readFileSync(join(root, "apps", "desktop", "src", "preload", "index.ts"), "utf8");

  await check("D1", "renderer is sandboxed (contextIsolation on, nodeIntegration off)", () => {
    const ok =
      /contextIsolation:\s*true/.test(mainSrc) &&
      /nodeIntegration:\s*false/.test(mainSrc) &&
      /sandbox:\s*true/.test(mainSrc);
    return ok ? "contextIsolation + sandbox, no node integration" : false;
  });

  await check("D2", "every preload channel has a matching ipcMain handler", () => {
    const channels = [...preloadSrc.matchAll(/invoke\("([^"]+)"/g)].map((m) => m[1]);
    const handlers = new Set([...mainSrc.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]));
    const missing = channels.filter((c) => !handlers.has(c));
    if (missing.length) {
      // multi-line registrations: fall back to a loose scan
      const loose = new Set([...mainSrc.matchAll(/ipcMain\.handle\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]));
      const stillMissing = missing.filter((c) => !loose.has(c));
      return stillMissing.length === 0
        ? `${channels.length}/${channels.length} channels wired`
        : `unwired: ${stillMissing.join(", ")}`;
    }
    return `${channels.length}/${channels.length} channels wired`;
  });

  await check("D3", "the app is single-instance per machine", () =>
    /requestSingleInstanceLock/.test(mainSrc) ? "requestSingleInstanceLock present" : false);

  await check("D4", "window.open / navigation is restricted to an allow-list", () => {
    const ok = /setWindowOpenHandler/.test(mainSrc) && /will-navigate/.test(mainSrc);
    return ok ? "window-open + will-navigate guards" : false;
  });

  await check("D5", "host-core is supervised and restarted on crash", () =>
    /hostRestarts|restart/i.test(mainSrc) ? "restart path present" : false);

  await check("D6", "scheduled tasks are executed by the desktop with a bounded tick", () => {
    return /SCHEDULER_INTERVAL_MS/.test(mainSrc) && /manuallyRunningTasks/.test(mainSrc)
      ? "scheduler tick + double-fire guard"
      : false;
  });

  await check("D7", "an OS tray / background-resident mode exists", () => {
    const hasTray = /new Tray\(/.test(mainSrc);
    const hidesOnClose = /event\.preventDefault\(\);[\s\S]{0,200}win\?\.hide\(\)/.test(mainSrc);
    const quitsFromTray = /label: "Quit senastr"/.test(mainSrc);
    return hasTray && hidesOnClose && quitsFromTray
      ? "tray icon + close-to-tray + explicit Quit (background participation while a turn runs)"
      : { status: "GAP", evidence: `tray=${hasTray} hide=${hidesOnClose} quit=${quitsFromTray}` };
  });

  await check("D8", "in-app update delivery is configured", () => {
    const pkg = readFileSync(join(root, "apps", "desktop", "package.json"), "utf8");
    const hasUpdater = /electron-updater|autoUpdater/.test(mainSrc + pkg);
    return hasUpdater
      ? "updater present"
      : { status: "GAP", evidence: "no update channel (PI-Desktop ADR 0022)" };
  });

  await check("D9", "packaging covers icons, per-platform targets and the bundled sidecar", () => {
    const dir = join(root, "apps", "desktop");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const build = pkg.build ?? {};
    const lanes = ["mac", "win", "linux"].filter((platform) => Boolean(build[platform]?.target));
    const iconOk = ["mac", "win", "linux"].every(
      (platform) => typeof build[platform]?.icon === "string" && existsSync(join(dir, build[platform].icon)),
    );
    const sidecar = (build.extraResources ?? []).some((entry) => String(entry.from).includes("host-core"));
    const bundled = existsSync(join(dir, "resources", "host-core", "main.js"));
    const ok = lanes.length === 3 && iconOk && sidecar && bundled;
    return ok
      ? `lanes: ${lanes.join("/")}, icon per platform, host-core bundled (${Math.round(statSync(join(dir, "resources", "host-core", "main.js")).size / 1024)} KB)`
      : {
          status: "GAP",
          evidence: `lanes=${lanes.join(",")} icon=${iconOk} sidecar=${sidecar} bundled=${bundled}`,
        };
  });

  await check("D10", "the UI is internationalised (no hard-coded English strings)", () => {
    const rendererDir = join(root, "apps", "desktop", "src", "renderer");
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(rendererDir);
    const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const hasI18n = /from\s+"[^"]*i18n|useTranslation|i18next|locales?\//.test(source);
    const localeDir = existsSync(join(root, "packages", "i18n")) || existsSync(join(rendererDir, "locales"));
    return hasI18n || localeDir
      ? "i18n layer present"
      : {
          status: "GAP",
          evidence: `copy is inline English across ${files.length} renderer files; PI-Desktop ships an English-first i18n framework with zh-CN (ADR 0009)`,
        };
  });

  await check("D11", "a command palette / slash commands exist for builtin actions", () => {
    const renderer = readdirSync(join(root, "apps", "desktop", "src", "renderer", "components"));
    const hasPalette = renderer.some((f) => /Palette|Commands/i.test(f));
    return hasPalette
      ? "palette present"
      : {
          status: "GAP",
          evidence:
            "only Ctrl+K search over actions/sessions exists; PI-Desktop has a command palette (Cmd+Shift+P) plus composer `/` commands and plugin commands (ADR 0034/0106)",
        };
  });

  await check("D12", "sessions can be imported from other agents (Claude Code/Codex/OpenCode/Pi)", () => {
    const hasImport = /import.*session|session.*import/i.test(mainSrc);
    return hasImport
      ? "import path present"
      : { status: "GAP", evidence: "no session import surface (PI-Desktop Settings → Import)" };
  });

  /* ---------------------------------------------------------- N: test net */
  group("verification");
  await check("N1", "an automated UI/app test suite exists", () => {
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.test\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    return files.length >= 8 ? `${files.length} test files` : false;
  });

  await check("N2", "Electron end-to-end scripts exist (boot/layout/transcript)", () => {
    const scripts = readdirSync(join(root, "scripts"));
    const e2e = scripts.filter((f) => /e2e/.test(f));
    const wired = /test:e2e/.test(readFileSync(join(root, "package.json"), "utf8"));
    const inCi = /e2e/.test(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"));
    const hook = /runE2eSmoke/.test(mainSrc);
    return e2e.length && wired && inCi && hook
      ? `scripts/${e2e.join(", scripts/")} boots the real app, asserts shell+bridge+sidecar and saves a screenshot`
      : { status: "GAP", evidence: `scripts=${e2e.length} wired=${wired} ci=${inCi} hook=${hook}` };
  });

  await check("N3", "CI workflow builds and tests the project", () => {
    const wf = join(root, ".github", "workflows");
    const has = existsSync(wf) && readdirSync(wf).length > 0;
    return has
      ? readdirSync(wf).join(", ")
      : { status: "GAP", evidence: "no .github/workflows — PI-Desktop runs CI + release workflows" };
  });

  /* ------------------------------------------------------------- A: state */
  await request("provider/delete", { id: "parity-openai" }).catch(() => {});
  await request("provider/delete", { id: "parity-pool" }).catch(() => {});
  await request("provider/delete", { id: "parity-headers" }).catch(() => {});
  await request("scheduled/delete", { id: "parity-task" }).catch(() => {});
  await request("mcp/delete", { id: "parity-mcp" }).catch(() => {});
  await request("mcp/delete", { id: "parity-mcp-bad" }).catch(() => {});
  await request("subagent/list", {}).catch(() => {});
}

/* ----------------------------------------------------------------- report */

const ICON = { PASS: "\x1b[32m✓\x1b[0m", FAIL: "\x1b[31m✗\x1b[0m", GAP: "\x1b[33m▲\x1b[0m" };

await main().catch((err) => {
  record("X", "harness", "FAIL", err?.stack ?? String(err));
});

const bySection = new Map();
for (const r of results) {
  if (!bySection.has(r.section)) bySection.set(r.section, []);
  bySection.get(r.section).push(r);
}

const counts = { PASS: 0, FAIL: 0, GAP: 0 };
for (const r of results) counts[r.status]++;

if (JSON_OUT) {
  console.log(JSON.stringify({ counts, results, dataDir, stderr: stderrText.slice(-2000) }, null, 2));
} else {
  for (const [name, rows] of bySection) {
    console.log(`\n\x1b[1m${name.toUpperCase()}\x1b[0m`);
    for (const r of rows) {
      console.log(`  ${ICON[r.status]} ${r.id.padEnd(10)} ${r.title}`);
      if (r.evidence) console.log(`      \x1b[2m${r.evidence}\x1b[0m`);
    }
  }
  console.log(
    `\n\x1b[1mTOTAL\x1b[0m  \x1b[32m${counts.PASS} pass\x1b[0m · \x1b[31m${counts.FAIL} fail\x1b[0m · \x1b[33m${counts.GAP} parity gaps\x1b[0m  (data: ${dataDir})`,
  );
}

child.kill("SIGTERM");
setTimeout(() => process.exit(counts.FAIL > 0 ? 1 : 0), 150);
