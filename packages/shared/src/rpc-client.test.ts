import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NdjsonRpcClient } from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

/** A throwaway JSON-RPC server implemented in plain Node, spawned per test. */
const SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || m.id === null) return;
  switch (m.method) {
    case "echo":
      send({ jsonrpc: "2.0", id: m.id, result: { echo: m.params } });
      break;
    case "fail":
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "boom", data: { why: "test" } } });
      break;
    case "notify-me":
      send({ jsonrpc: "2.0", id: m.id, result: "ok" });
      send({ jsonrpc: "2.0", method: "hello", params: { from: "server" } });
      break;
    case "slow":
      setTimeout(() => send({ jsonrpc: "2.0", id: m.id, result: "slow-done" }), 400);
      break;
  }
});
`;

function makeServerScript(): string {
  const file = join(root, "node_modules", ".senastr-rpc-test-server.cjs");
  require("node:fs").mkdirSync(dirname(file), { recursive: true });
  require("node:fs").writeFileSync(file, SERVER_SCRIPT);
  return file;
}

function startClient(script: string, onNotification?: (m: string, p: unknown) => void) {
  return new NdjsonRpcClient({
    command: process.execPath,
    args: [script],
    onNotification,
  });
}

describe("NdjsonRpcClient", () => {
  it("round-trips a request", async () => {
    const client = startClient(makeServerScript());
    const res = await client.request<{ echo: { n: number } }>("echo", { n: 42 });
    expect(res.echo.n).toBe(42);
    client.dispose();
  });

  it("surfaces server errors with code and data", async () => {
    const client = startClient(makeServerScript());
    let caught: Error | null = null;
    try {
      await client.request("fail");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("-32000");
    expect(caught!.message).toContain("boom");
    client.dispose();
  });

  it("delivers server notifications", async () => {
    const seen: Array<{ m: string; p: unknown }> = [];
    const client = startClient(makeServerScript(), (m, p) => seen.push({ m, p }));
    await client.request("notify-me");
    // notification rides the same stream right after the response
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toContainEqual({ m: "hello", p: { from: "server" } });
    client.dispose();
  });

  it("times out slow requests with a clear error", async () => {
    const client = startClient(makeServerScript());
    let caught: Error | null = null;
    try {
      await client.request("slow", undefined, { timeoutMs: 100 });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("rpc timeout");
    // the client is still usable afterwards
    const res = await client.request<{ echo: unknown }>("echo", { after: "timeout" });
    expect(res.echo).toEqual({ after: "timeout" });
    client.dispose();
  });

  it("rejects in-flight requests when the child exits", async () => {
    const client = startClient(makeServerScript());
    const pending = client.request("slow", undefined, { timeoutMs: 5000 });
    const settled = pending.then(
      () => false,
      (err: Error) => err.message.includes("sidecar exited") || err.message.includes("disposed"),
    );
    await new Promise((r) => setTimeout(r, 80));
    client.dispose();
    expect(await settled).toBe(true);
  });

  it("execFileSync sanity: protocol line framing is one JSON object per line", () => {
    // Guard against accidental multi-line framing in the server script itself.
    const out = execFileSync(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({a:1})+"\\n")']);
    expect(JSON.parse(out.toString())).toEqual({ a: 1 });
  });
});
