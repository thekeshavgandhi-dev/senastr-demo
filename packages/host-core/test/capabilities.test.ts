import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MASKED_PROVIDER_SECRET,
  MASKED_SECRET,
  McpService,
  ProviderStore,
  SkillService,
  mcpToolName,
} from "../src/index";

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider settings", () => {
  it("keeps an existing key when an edit omits it and persists advanced fields", () => {
    const store = new ProviderStore(temp("senastr-provider-"));
    store.set({
      id: "openrouter",
      kind: "openai",
      vendorKey: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret-key",
      apiStyle: "chat_completions",
      headers: { "X-Title": "senastr" },
      models: ["vendor/model"],
    });
    const updated = store.set({
      id: "openrouter",
      kind: "openai",
      vendorKey: "openrouter",
      label: "OpenRouter renamed",
      baseUrl: "https://openrouter.ai/api/v1",
      apiStyle: "chat_completions",
      headers: { "X-Title": "desktop" },
      models: ["vendor/model"],
      enabled: false,
    });
    expect(updated).toMatchObject({
      label: "OpenRouter renamed",
      hasApiKey: true,
      enabled: false,
      apiStyle: "chat_completions",
      headers: { "X-Title": MASKED_PROVIDER_SECRET },
    });
    expect(store.get("openrouter")).toMatchObject({
      apiKey: "secret-key",
      headers: { "X-Title": "desktop" },
    });

    const preserved = store.set({
      ...store.get("openrouter"),
      apiKey: MASKED_PROVIDER_SECRET,
      headers: { "X-Title": MASKED_PROVIDER_SECRET },
    });
    expect(preserved.headers).toEqual({ "X-Title": MASKED_PROVIDER_SECRET });
    expect(store.get("openrouter")).toMatchObject({
      apiKey: "secret-key",
      headers: { "X-Title": "desktop" },
    });
  });
});

describe("skills", () => {
  it("merges enabled global and matching project skills", () => {
    const service = new SkillService(temp("senastr-skills-"));
    const project = temp("senastr-skill-project-");
    const other = temp("senastr-skill-other-");
    service.set({ name: "Global review", content: "Review every diff.", level: "global" });
    service.set({ name: "Project style", content: "Use project conventions.", level: "project", projectPath: project });
    service.set({ name: "Other", content: "Not visible here.", level: "project", projectPath: other });
    const disabled = service.set({ name: "Disabled", content: "Do not load.", level: "global" });
    service.setEnabled(disabled.id, false, { level: "global" });

    expect(service.active(project).map((skill) => skill.name)).toEqual(["Global review", "Project style"]);
    expect(service.active(other).map((skill) => skill.name)).toEqual(["Global review", "Other"]);
  });
});

describe("MCP registry and runtime", () => {
  it("masks stored secrets, handshakes over stdio, and calls advertised tools", async () => {
    const data = temp("senastr-mcp-");
    const script = join(data, "server.cjs");
    writeFileSync(
      script,
      `const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: "test", version: "1" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "hello", description: "Say hello", inputSchema: { type: "object", properties: { name: { type: "string" } } } }] } });
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "hello " + msg.params.arguments.name }] } });
});`,
    );

    const service = new McpService(data);
    service.set({
      id: "test-server",
      label: "Test server",
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: { TOKEN: "very-secret" },
      enabled: true,
    });
    expect(service.list()[0].env).toEqual({ TOKEN: MASKED_SECRET });
    service.set({
      id: "test-server",
      label: "Test server",
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: { TOKEN: MASKED_SECRET },
      enabled: true,
    });
    expect(service.get("test-server").env?.TOKEN).toBe("very-secret");

    const status = await service.test("test-server");
    expect(status).toMatchObject({ state: "ready", toolCount: 1, toolNames: ["hello"] });
    const tools = await service.listToolDefinitions(null);
    expect(tools[0]).toMatchObject({ name: mcpToolName("test-server", "hello"), source: "mcp", risk: "exec" });
    expect(await service.callTool(tools[0].name, { name: "senastr" }, null)).toBe("hello senastr");
    service.dispose();
  });
});
