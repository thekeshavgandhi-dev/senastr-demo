import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ErrorCodes,
  RpcError,
  type CapabilityLevel,
  type McpServerConfig,
  type McpServerInput,
  type McpServerStatus,
  type McpServerSummary,
  type ToolDefinition,
  type ToolParameters,
} from "@senastr/shared";
import { SecretBox, isEncryptedValue } from "./secrets";
import { JsonFileStore } from "./store";

export const MASKED_SECRET = "••••••";
const CONNECT_TIMEOUT_MS = 12_000;
const TOOL_TIMEOUT_MS = 120_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpConnection {
  initialize(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface ActiveConnection {
  fingerprint: string;
  client: McpConnection;
  tools: McpTool[];
}

export interface McpQuery {
  level?: CapabilityLevel;
  projectPath?: string;
}

/** Persistent MCP registry plus a small native stdio/Streamable-HTTP client.
 * Connections are lazy and reused across turns; editing or disabling a record
 * closes it immediately. */
export class McpService {
  private readonly store: JsonFileStore<McpServerConfig[]>;
  private readonly connections = new Map<string, ActiveConnection>();
  /** A broken command should not charge every model step another 12-second
   * handshake. Editing the record or pressing Test clears this fingerprint. */
  private readonly failedFingerprints = new Map<string, string>();
  private readonly statuses = new Map<string, McpServerStatus>();
  private readonly routes = new Map<string, { serverId: string; toolName: string }>();

  private readonly secrets: SecretBox;

  constructor(dataDir: string, secrets?: SecretBox) {
    this.secrets = secrets ?? new SecretBox(dataDir);
    this.store = new JsonFileStore<McpServerConfig[]>(join(dataDir, "mcp-servers.json"), []);
    this.migratePlaintextSecrets();
  }

  /** Encrypt env/header values that older builds stored in cleartext. */
  private migratePlaintextSecrets(): void {
    const stored = this.store.get();
    let changed = false;
    const next = stored.map((server) => {
      if (!this.secrets.mapNeedsEncryption(server.env) && !this.secrets.mapNeedsEncryption(server.headers)) {
        return server;
      }
      changed = true;
      return {
        ...server,
        env: this.secrets.encryptMap(server.env),
        headers: this.secrets.encryptMap(server.headers),
      };
    });
    if (changed) this.store.update(() => next);
  }

  /** Decrypt a stored record for internal use (spawning, HTTP calls). */
  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  private reveal(server: McpServerConfig): McpServerConfig {
    return {
      ...server,
      env: this.secrets.decryptMap(server.env),
      headers: this.secrets.decryptMap(server.headers),
    };
  }

  /** Encrypt a record's secret maps before persisting. */
  private protect(server: McpServerConfig): McpServerConfig {
    return {
      ...server,
      env: this.secrets.encryptMap(server.env),
      headers: this.secrets.encryptMap(server.headers),
    };
  }

  list(query: McpQuery = {}): McpServerSummary[] {
    const projectPath = normalizeProjectPath(query.projectPath);
    return this.store
      .get()
      .filter((server) => {
        const level = server.level ?? "global";
        if (query.level && level !== query.level) return false;
        if (level === "project" && (!projectPath || normalizeProjectPath(server.projectPath) !== projectPath)) {
          return false;
        }
        return true;
      })
      .map((server) => this.reveal(server))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(maskServer);
  }

  listStatuses(query: McpQuery = {}): McpServerStatus[] {
    return this.list(query).map((server) => this.statuses.get(server.id) ?? idleStatus(server.id));
  }

  get(id: string, query: McpQuery = {}): McpServerConfig {
    const projectPath = normalizeProjectPath(query.projectPath);
    const server = this.store.get().find((candidate) => {
      if (candidate.id !== id) return false;
      if (query.level && (candidate.level ?? "global") !== query.level) return false;
      return (candidate.level ?? "global") !== "project" ||
        (!!projectPath && normalizeProjectPath(candidate.projectPath) === projectPath);
    });
    if (!server) throw new RpcError(ErrorCodes.HOST_ERROR, `MCP server not found: ${id}`);
    const revealed = this.reveal(server);
    return { ...revealed, env: cloneMap(revealed.env), headers: cloneMap(revealed.headers) };
  }

  set(input: McpServerInput): McpServerSummary {
    const id = requireId(input?.id);
    const storedExisting = this.store.get().find((server) => server.id === id);
    const existing = storedExisting ? this.reveal(storedExisting) : undefined;
    const next = this.protect(validateServer(input, existing));
    const duplicate = this.store.get().find(
      (server) => server.id !== existing?.id && server.id === next.id,
    );
    if (duplicate) throw new RpcError(ErrorCodes.INVALID_PARAMS, `MCP server id already exists: ${id}`);

    this.store.update((all) => {
      const index = all.findIndex((server) => server.id === id);
      if (index < 0) return [...all, next];
      const updated = [...all];
      updated[index] = next;
      return updated;
    });
    this.dropConnection(id);
    this.statuses.set(id, idleStatus(id));
    return maskServer(next);
  }

  setEnabled(id: string, enabled: boolean, query: McpQuery = {}): McpServerSummary {
    const current = this.get(id, query);
    const next = this.protect({ ...current, enabled, updatedAt: Date.now() });
    this.store.update((all) => all.map((server) => (server.id === id ? next : server)));
    if (!enabled) this.dropConnection(id);
    this.statuses.set(id, idleStatus(id));
    return maskServer(next);
  }

  delete(id: string, query: McpQuery = {}): void {
    this.get(id, query);
    this.store.update((all) => all.filter((server) => server.id !== id));
    this.dropConnection(id);
    this.statuses.delete(id);
  }

  /** Connect one saved server and return its live status. */
  async test(id: string, query: McpQuery = {}): Promise<McpServerStatus> {
    const server = this.get(id, query);
    this.dropConnection(id);
    await this.connect(server).catch(() => undefined);
    return this.statuses.get(id) ?? idleStatus(id);
  }

  /** MCP tools active for a session's project, in model-provider format. */
  async listToolDefinitions(projectPath?: string | null): Promise<ToolDefinition[]> {
    const active = this.active(projectPath);
    const definitions: ToolDefinition[] = [];
    const activeIds = new Set(active.map((server) => server.id));
    for (const [name, route] of this.routes) {
      if (!activeIds.has(route.serverId)) this.routes.delete(name);
    }

    const settled = await Promise.all(
      active.map(async (server) => ({
        server,
        tools: await this.connect(server).catch(() => [] as McpTool[]),
      })),
    );
    const usedNames = new Set<string>();
    for (const { server, tools } of settled) {
      for (const tool of tools) {
        let fullName = mcpToolName(server.id, tool.name);
        if (usedNames.has(fullName) || (this.routes.has(fullName) && this.routes.get(fullName)?.toolName !== tool.name)) {
          fullName = `${fullName.slice(0, 56)}_${shortHash(`${server.id}:${tool.name}`)}`;
        }
        usedNames.add(fullName);
        this.routes.set(fullName, { serverId: server.id, toolName: tool.name });
        definitions.push({
          name: fullName,
          description: `[MCP · ${server.label}] ${tool.description || tool.name}`,
          parameters: normalizeToolParameters(tool.inputSchema),
          risk: "exec",
          source: "mcp",
          plugin: server.id,
        });
      }
    }
    return definitions;
  }

  hasTool(name: string): boolean {
    return this.routes.has(name);
  }

  async callTool(name: string, args: Record<string, unknown>, projectPath?: string | null): Promise<string> {
    let route = this.routes.get(name);
    if (!route) {
      await this.listToolDefinitions(projectPath);
      route = this.routes.get(name);
    }
    if (!route) throw new RpcError(ErrorCodes.TOOL_NOT_FOUND, `unknown MCP tool: ${name}`);
    const server = this.active(projectPath).find((candidate) => candidate.id === route!.serverId);
    if (!server) throw new RpcError(ErrorCodes.TOOL_NOT_FOUND, `MCP server is not active: ${route.serverId}`);
    await this.connect(server);
    const entry = this.connections.get(server.id);
    if (!entry || !entry.tools.some((tool) => tool.name === route!.toolName)) {
      throw new RpcError(ErrorCodes.TOOL_NOT_FOUND, `MCP tool is no longer advertised: ${route.toolName}`);
    }
    const result = await entry.client.callTool(route.toolName, args);
    return formatToolResult(result);
  }

  dispose(): void {
    for (const entry of this.connections.values()) entry.client.close();
    this.connections.clear();
    this.failedFingerprints.clear();
    this.routes.clear();
  }

  private active(projectPath?: string | null): McpServerConfig[] {
    const normalized = normalizeProjectPath(projectPath);
    return this.store
      .get()
      .map((server) => this.reveal(server))
      .filter((server) =>
      server.enabled &&
      ((server.level ?? "global") === "global" ||
        (!!normalized && normalizeProjectPath(server.projectPath) === normalized)),
    );
  }

  private async connect(server: McpServerConfig): Promise<McpTool[]> {
    const fingerprint = serverFingerprint(server);
    const existing = this.connections.get(server.id);
    if (existing?.fingerprint === fingerprint) return existing.tools;
    if (existing) this.dropConnection(server.id);
    if (this.failedFingerprints.get(server.id) === fingerprint) {
      throw new Error(this.statuses.get(server.id)?.message || `MCP server ${server.label} is unavailable`);
    }

    this.statuses.set(server.id, {
      serverId: server.id,
      state: "connecting",
      toolCount: 0,
      updatedAt: Date.now(),
    });
    const client: McpConnection = server.transport === "http"
      ? new HttpMcpConnection(server)
      : new StdioMcpConnection(server);
    try {
      const tools = await client.initialize();
      this.failedFingerprints.delete(server.id);
      this.connections.set(server.id, { fingerprint, client, tools });
      this.statuses.set(server.id, {
        serverId: server.id,
        state: "ready",
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        updatedAt: Date.now(),
      });
      return tools;
    } catch (error) {
      client.close();
      this.failedFingerprints.set(server.id, fingerprint);
      this.statuses.set(server.id, {
        serverId: server.id,
        state: "failed",
        toolCount: 0,
        message: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      });
      throw error;
    }
  }

  private dropConnection(id: string): void {
    this.connections.get(id)?.client.close();
    this.connections.delete(id);
    this.failedFingerprints.delete(id);
    for (const [name, route] of this.routes) {
      if (route.serverId === id) this.routes.delete(name);
    }
  }
}

class StdioMcpConnection implements McpConnection {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private stderr = "";

  constructor(private readonly server: McpServerConfig) {}

  async initialize(): Promise<McpTool[]> {
    const command = this.server.command!;
    const cwd = this.server.projectPath && existsSync(this.server.projectPath)
      ? this.server.projectPath
      : process.cwd();
    this.process = spawn(command, this.server.args ?? [], {
      cwd,
      env: { ...process.env, ...(this.server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-1600);
    });
    this.process.once("error", (error) => this.rejectAll(error));
    this.process.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.rejectAll(
        new Error(
          `MCP process exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ""}${detail ? `: ${detail.slice(-300)}` : ""}`,
        ),
      );
    });

    await this.request("initialize", initializeParams(), CONNECT_TIMEOUT_MS);
    this.notify("notifications/initialized", {});
    const listed = await this.request("tools/list", {}, CONNECT_TIMEOUT_MS);
    return normalizeTools(listed);
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, TOOL_TIMEOUT_MS);
  }

  close(): void {
    this.rejectAll(new Error("MCP connection closed"));
    this.process?.kill("SIGTERM");
    this.process = null;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin.writable) {
        reject(new Error("MCP process is not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.process?.stdin.writable) {
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        // Diagnostics on stdout violate MCP framing; keep waiting for JSON.
      }
    }
  }

  private onMessage(message: any): void {
    if (typeof message?.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "MCP request failed"));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class HttpMcpConnection implements McpConnection {
  private nextId = 1;
  private sessionId: string | undefined;
  private closed = false;

  constructor(private readonly server: McpServerConfig) {}

  async initialize(): Promise<McpTool[]> {
    await this.request("initialize", initializeParams(), CONNECT_TIMEOUT_MS);
    await this.notify("notifications/initialized", {});
    return normalizeTools(await this.request("tools/list", {}, CONNECT_TIMEOUT_MS));
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, TOOL_TIMEOUT_MS);
  }

  close(): void {
    this.closed = true;
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    if (!response) throw new Error(`MCP ${method} returned no response`);
    if (response.error) throw new Error(response.error.message || `MCP ${method} failed`);
    return response.result;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, CONNECT_TIMEOUT_MS, true);
  }

  private async post(payload: unknown, timeoutMs: number, notification = false): Promise<any> {
    if (this.closed) throw new Error("MCP connection is closed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.server.url!, {
        method: "POST",
        headers: {
          ...(this.server.headers ?? {}),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sessionId = res.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
      if (!res.ok) throw new Error(`MCP HTTP request failed (HTTP ${res.status})`);
      if (notification || res.status === 202) return null;
      const text = await res.text();
      if (!text.trim()) return null;
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
        const data = text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter((line) => line && line !== "[DONE]");
        for (const row of data.reverse()) {
          try {
            return JSON.parse(row);
          } catch {
            // Try the previous data event.
          }
        }
        throw new Error("MCP server returned an invalid event stream");
      }
      return JSON.parse(text);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`MCP request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "senastr", version: "0.1.0" },
  };
}

function normalizeTools(result: unknown): McpTool[] {
  const tools = result && typeof result === "object" && !Array.isArray(result)
    ? (result as { tools?: unknown }).tools
    : undefined;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name) return [];
    return [{
      name: item.name,
      description: typeof item.description === "string" ? item.description : undefined,
      inputSchema: item.inputSchema,
    }];
  });
}

function normalizeToolParameters(value: unknown): ToolParameters {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const schema = value as Record<string, unknown>;
    if (schema.type === "object" || schema.properties) {
      return {
        type: "object",
        properties:
          schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
            ? (schema.properties as Record<string, unknown>)
            : {},
        ...(Array.isArray(schema.required)
          ? { required: schema.required.filter((item): item is string => typeof item === "string") }
          : {}),
      };
    }
  }
  return { type: "object", properties: {} };
}

function validateServer(input: McpServerInput, existing?: McpServerConfig): McpServerConfig {
  const id = requireId(input.id);
  const label = (input.label?.trim() || id).slice(0, 120);
  const transport = input.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "MCP transport must be stdio or http");
  }
  const level: CapabilityLevel = input.level === "project" ? "project" : "global";
  const projectPath = level === "project" ? requireProjectPath(input.projectPath) : undefined;
  const command = cleanOptional(input.command);
  const url = cleanOptional(input.url)?.replace(/\/+$/, "");
  if (transport === "stdio" && !command) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "a command is required for a stdio MCP server");
  }
  if (transport === "http") {
    if (!url) throw new RpcError(ErrorCodes.INVALID_PARAMS, "a URL is required for an HTTP MCP server");
    validateHttpUrl(url);
  }
  const now = Date.now();
  return {
    id,
    label,
    description: cleanOptional(input.description),
    transport,
    command: transport === "stdio" ? command : undefined,
    args: transport === "stdio" ? cleanArgs(input.args) : undefined,
    env: transport === "stdio" ? mergeSecretMap(existing?.env, input.env) : undefined,
    url: transport === "http" ? url : undefined,
    headers: transport === "http" ? mergeSecretMap(existing?.headers, input.headers) : undefined,
    enabled: input.enabled ?? existing?.enabled ?? true,
    level,
    projectPath,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function maskServer(server: McpServerConfig): McpServerSummary {
  return {
    ...server,
    env: maskMap(server.env),
    headers: maskMap(server.headers),
  };
}

function maskMap(value?: Record<string, string>): Record<string, string> | undefined {
  if (!value || !Object.keys(value).length) return undefined;
  return Object.fromEntries(Object.keys(value).map((key) => [key, MASKED_SECRET]));
}

function cloneMap(value?: Record<string, string>): Record<string, string> | undefined {
  return value ? { ...value } : undefined;
}

function mergeSecretMap(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return existing ? { ...existing } : undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    const key = rawKey.trim();
    const value = String(rawValue).trim();
    if (!key || !value) continue;
    if (key.includes("\r") || key.includes("\n") || value.includes("\r") || value.includes("\n")) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "MCP environment/header values cannot contain line breaks");
    }
    out[key] = value === MASKED_SECRET && existing?.[key] ? existing[key] : value;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const args = value.filter((item): item is string => typeof item === "string");
  return args.length ? args : undefined;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "MCP server id must be a lowercase slug");
  }
  return value;
}

function cleanOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireProjectPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "projectPath is required for a project MCP server");
  }
  return resolve(value);
}

function normalizeProjectPath(value?: string | null): string | undefined {
  return typeof value === "string" && value.trim() ? resolve(value) : undefined;
}

function validateHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "MCP URL must be valid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "MCP URL must be HTTP(S) without embedded credentials");
  }
}

function idleStatus(id: string): McpServerStatus {
  return { serverId: id, state: "idle", toolCount: 0, updatedAt: Date.now() };
}

function serverFingerprint(server: McpServerConfig): string {
  return JSON.stringify({
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
    level: server.level,
    projectPath: server.projectPath,
  });
}

export function mcpToolName(serverId: string, toolName: string): string {
  const server = sanitizeToolPart(serverId).slice(0, 20) || "server";
  const tool = sanitizeToolPart(toolName).slice(0, 34) || "tool";
  const basic = `mcp_${server}_${tool}`;
  return basic.length <= 58 ? basic : `${basic.slice(0, 51)}_${shortHash(basic)}`;
}

function sanitizeToolPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function formatToolResult(result: unknown): string {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const parts = record.content.map((part) => {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const item = part as Record<string, unknown>;
          if (item.type === "text" && typeof item.text === "string") return item.text;
        }
        return JSON.stringify(part);
      });
      const text = parts.filter(Boolean).join("\n");
      if (record.isError) throw new Error(text || "MCP tool failed");
      return text || JSON.stringify(result, null, 2);
    }
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
