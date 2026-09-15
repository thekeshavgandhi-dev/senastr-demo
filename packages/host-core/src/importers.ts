import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ExternalAgentSource,
  ExternalSessionSummary,
  ImportScanResult,
  ModelConfigImportEntry,
} from "@senastr/shared";

/**
 * Session + model-config import (parity: pi-desktop `session/importScan`,
 * `session/importRun`, `modelConfig/importScan`, `modelConfig/importRun`).
 *
 * Four external agents are supported, each with a defensive reader over the
 * format it actually writes on disk:
 *
 *   claude-code  ~/.claude/projects/<project>/<session>.jsonl
 *   codex        ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
 *   opencode     ~/.local/share/opencode/storage/{session,message,part}/…
 *   pi           ~/.pi/agent/sessions/<dir>/<session>.jsonl
 *
 * Parsers skip malformed lines rather than failing a whole import: a truncated
 * log should still yield the messages it does contain.
 */

const SOURCES: ExternalAgentSource[] = ["claude-code", "codex", "opencode", "pi"];

export interface ImporterOptions {
  /** Override the home directory (tests). */
  home?: string;
  /** Restrict the scan to these sources. */
  sources?: ExternalAgentSource[];
  /** Cap on files scanned per source. */
  maxFiles?: number;
}

interface HomePaths {
  claudeProjects: string;
  codexSessions: string;
  opencodeStorage: string;
  piSessions: string;
  codexConfig: string;
  opencodeConfig: string;
  claudeSettings: string;
}

function homePaths(home: string): HomePaths {
  return {
    claudeProjects: join(home, ".claude", "projects"),
    codexSessions: join(home, ".codex", "sessions"),
    opencodeStorage: join(home, ".local", "share", "opencode", "storage"),
    piSessions: join(home, ".pi", "agent", "sessions"),
    codexConfig: join(home, ".codex", "config.toml"),
    opencodeConfig: join(home, ".config", "opencode", "opencode.json"),
    claudeSettings: join(home, ".claude", "settings.json"),
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJsonLines(file: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* truncated / malformed line — keep going */
    }
  }
  return out;
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function walkFiles(root: string, match: (name: string, path: string) => boolean, cap = 5000): string[] {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < cap) {
    const dir = queue.shift() as string;
    for (const entry of listDir(dir)) {
      const full = join(dir, entry);
      if (isDir(full)) {
        queue.push(full);
        continue;
      }
      if (match(entry, full)) out.push(full);
      if (out.length >= cap) break;
    }
  }
  return out;
}

function toMillis(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds vs milliseconds heuristic.
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function truncateTitle(text: string, max = 60): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && (b.type === "text" || b.type === "input_text" || b.type === "output_text") && typeof b.text === "string")
      .map((b: any) => b.text as string)
      .join("\n")
      .trim();
  }
  return "";
}

/** Claude Code injects synthetic user lines that all start with an XML-ish tag. */
function isSyntheticUserText(text: string): boolean {
  return text.trimStart().startsWith("<");
}

function makeMessage(
  role: ChatMessage["role"],
  content: string,
  createdAt: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id: randomUUID(), role, content, createdAt, ...extra };
}

export function importedSessionId(source: ExternalAgentSource, externalId: string): string {
  const safe = externalId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return `import-${source}-${safe}`;
}

function safeExternalId(source: ExternalAgentSource, externalId: string): string {
  return importedSessionId(source, externalId);
}

/* ------------------------------------------------------------------ */
/* claude code                                                         */
/* ------------------------------------------------------------------ */

function scanClaude(paths: HomePaths, maxFiles: number): ExternalSessionSummary[] {
  const out: ExternalSessionSummary[] = [];
  let scanned = 0;
  for (const projectDir of listDir(paths.claudeProjects)) {
    const dir = join(paths.claudeProjects, projectDir);
    if (!isDir(dir)) continue;
    for (const file of listDir(dir)) {
      if (!file.endsWith(".jsonl") || scanned >= maxFiles) continue;
      scanned += 1;
      const filePath = join(dir, file);
      const lines = readJsonLines(filePath).filter(isAnyRecord);
      const convo = lines.filter((l) => (l.type === "user" || l.type === "assistant") && l.isSidechain !== true && l.message);
      if (convo.length === 0) continue;
      const firstUser = convo.find((l) => l.type === "user" && blockText(l.message?.content) && !isSyntheticUserText(blockText(l.message?.content)));
      const model = convo.find((l) => l.type === "assistant" && l.message?.model)?.message?.model ?? null;
      out.push({
        source: "claude-code",
        externalId: basename(file, ".jsonl"),
        title: truncateTitle(blockText(firstUser?.message?.content)) || basename(file, ".jsonl"),
        projectPath: typeof convo[0]?.cwd === "string" ? convo[0].cwd : null,
        model: model ? String(model) : null,
        createdAt: toMillis(convo[0]?.timestamp),
        updatedAt: toMillis(convo[convo.length - 1]?.timestamp),
        messageCount: convo.length,
        filePath,
      });
    }
  }
  return out;
}

function convertClaude(summary: ExternalSessionSummary): ChatMessage[] {
  const lines = readJsonLines(summary.filePath).filter(isAnyRecord).filter(
    (l) => (l.type === "user" || l.type === "assistant") && l.isSidechain !== true && l.message,
  );
  const messages: ChatMessage[] = [];
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const line of lines) {
    const createdAt = toMillis(line.timestamp);
    const content = line.message?.content;
    const blocks = Array.isArray(content) ? (content as any[]) : null;
    if (line.type === "assistant") {
      const text = blockText(content);
      const toolCalls: ChatMessage["toolCalls"] = [];
      for (const b of blocks ?? []) {
        if (b?.type === "tool_use" && b.id) {
          toolCalls.push({ id: String(b.id), name: String(b.name ?? "tool"), arguments: (b.input ?? {}) as Record<string, unknown> });
          pending.set(String(b.id), { name: String(b.name ?? "tool"), args: (b.input ?? {}) as Record<string, unknown> });
        }
      }
      if (text || toolCalls.length) {
        messages.push(makeMessage("assistant", text, createdAt, toolCalls.length ? { toolCalls } : {}));
      }
      continue;
    }
    const toolResults = (blocks ?? []).filter((b) => b?.type === "tool_result");
    if (toolResults.length > 0) {
      for (const b of toolResults) {
        const callId = String(b.tool_use_id ?? "");
        const call = pending.get(callId);
        pending.delete(callId);
        const text = typeof b.content === "string" ? b.content : blockText(b.content);
        messages.push(
          makeMessage("tool", text, createdAt, {
            toolCallId: callId,
            toolName: call?.name,
          }),
        );
      }
      continue;
    }
    const text = blockText(content);
    if (text && !isSyntheticUserText(text)) messages.push(makeMessage("user", text, createdAt));
  }
  return messages;
}

/* ------------------------------------------------------------------ */
/* codex                                                               */
/* ------------------------------------------------------------------ */

function scanCodex(paths: HomePaths, maxFiles: number): ExternalSessionSummary[] {
  const files = walkFiles(paths.codexSessions, (name) => name.endsWith(".jsonl"), maxFiles);
  const out: ExternalSessionSummary[] = [];
  for (const filePath of files) {
    const entries = readJsonLines(filePath).filter(isAnyRecord);
    let header: any = null;
    const messages: ChatMessage[] = [];
    for (const entry of entries) {
      const payload = entry.payload ?? entry;
      if (entry.type === "session_meta" || payload?.type === "session_meta") {
        header = payload;
        continue;
      }
      if (entry.type === "response_item" && payload?.type === "message" && typeof payload.role === "string") {
        const text = blockText(payload.content);
        if (text) messages.push(makeMessage(payload.role === "assistant" ? "assistant" : "user", text, toMillis(entry.timestamp)));
      }
      if (entry.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") {
        messages.push(makeMessage("user", payload.message, toMillis(entry.timestamp)));
      }
    }
    if (messages.length === 0) continue;
    const externalId = String(header?.id ?? basename(filePath, ".jsonl").replace(/^rollout-/, ""));
    const firstUser = messages.find((m) => m.role === "user");
    out.push({
      source: "codex",
      externalId,
      title: truncateTitle(firstUser?.content ?? "") || basename(filePath, ".jsonl"),
      projectPath: typeof header?.cwd === "string" ? header.cwd : null,
      model: typeof header?.model === "string" ? header.model : null,
      createdAt: toMillis(header?.timestamp, messages[0]?.createdAt),
      updatedAt: toMillis(null, messages[messages.length - 1]?.createdAt),
      messageCount: messages.length,
      filePath,
    });
  }
  return out;
}

function convertCodex(summary: ExternalSessionSummary): ChatMessage[] {
  const entries = readJsonLines(summary.filePath).filter(isAnyRecord);
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    const payload = entry.payload ?? entry;
    const createdAt = toMillis(entry.timestamp);
    if (entry.type === "response_item" && payload?.type === "message" && typeof payload.role === "string") {
      const text = blockText(payload.content);
      if (text) messages.push(makeMessage(payload.role === "assistant" ? "assistant" : "user", text, createdAt));
      continue;
    }
    if (entry.type === "response_item" && payload?.type === "function_call" && payload.name) {
      messages.push(
        makeMessage("assistant", "", createdAt, {
          toolCalls: [
            {
              id: String(payload.call_id ?? payload.id ?? randomUUID()),
              name: String(payload.name),
              arguments: safeParseObject(payload.arguments),
            },
          ],
        }),
      );
      continue;
    }
    if (entry.type === "response_item" && payload?.type === "function_call_output") {
      messages.push(
        makeMessage("tool", typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? ""), createdAt, {
          toolCallId: String(payload.call_id ?? ""),
        }),
      );
      continue;
    }
    if (entry.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") {
      messages.push(makeMessage("user", payload.message, createdAt));
    }
  }
  return messages;
}

function safeParseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* keep raw */
    }
    return { _raw: value };
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* opencode                                                            */
/* ------------------------------------------------------------------ */

function scanOpenCode(paths: HomePaths, maxFiles: number): ExternalSessionSummary[] {
  const sessionRoot = join(paths.opencodeStorage, "session");
  const out: ExternalSessionSummary[] = [];
  let scanned = 0;
  for (const projectDir of listDir(sessionRoot)) {
    const dir = join(sessionRoot, projectDir);
    if (!isDir(dir)) continue;
    for (const file of listDir(dir)) {
      if (!file.endsWith(".json") || scanned >= maxFiles) continue;
      scanned += 1;
      const session = readJson(join(dir, file));
      if (!session || typeof session.id !== "string") continue;
      const messageDir = join(paths.opencodeStorage, "message", session.id);
      const messageFiles = listDir(messageDir).filter((f) => f.endsWith(".json")).sort();
      if (messageFiles.length === 0) continue;
      const first = readJson(join(messageDir, messageFiles[0])) ?? {};
      out.push({
        source: "opencode",
        externalId: session.id,
        title: truncateTitle(String(session.title ?? "")) || session.id,
        projectPath: typeof session.directory === "string" ? session.directory : typeof session.path === "string" ? session.path : null,
        model: typeof session.modelID === "string" ? session.modelID : typeof first.modelID === "string" ? first.modelID : null,
        createdAt: toMillis(session.time?.created, toMillis(first.time?.created)),
        updatedAt: toMillis(session.time?.updated, toMillis(session.time?.created)),
        messageCount: messageFiles.length,
        filePath: join(dir, file),
      });
    }
  }
  return out;
}

function convertOpenCode(summary: ExternalSessionSummary, paths: HomePaths): ChatMessage[] {
  const messageDir = join(paths.opencodeStorage, "message", summary.externalId);
  const files = listDir(messageDir).filter((f) => f.endsWith(".json")).sort();
  const messages: ChatMessage[] = [];
  const pending = new Map<string, string>();
  for (const file of files) {
    const record = readJson(join(messageDir, file));
    if (!record) continue;
    const role = record.role === "assistant" ? "assistant" : "user";
    const createdAt = toMillis(record.time?.created);
    const parts: string[] = [];
    const toolCalls: ChatMessage["toolCalls"] = [];
    const partDir = join(paths.opencodeStorage, "part", String(record.id));
    for (const partFile of listDir(partDir).filter((f) => f.endsWith(".json")).sort()) {
      const part = readJson(join(partDir, partFile));
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      if (part.type === "tool" && part.callID) {
        toolCalls.push({
          id: String(part.callID),
          name: String(part.tool ?? "tool"),
          arguments: (part.state?.input ?? {}) as Record<string, unknown>,
        });
        pending.set(String(part.callID), String(part.tool ?? "tool"));
      }
    }
    if (role === "assistant") {
      if (parts.length || toolCalls.length) {
        messages.push(makeMessage("assistant", parts.join("\n").trim(), createdAt, toolCalls.length ? { toolCalls } : {}));
      }
    } else if (parts.length) {
      messages.push(makeMessage("user", parts.join("\n").trim(), createdAt));
    }
    for (const call of toolCalls) {
      const output = readToolResult(paths, String(call.id));
      if (output != null) {
        messages.push(makeMessage("tool", output, createdAt, { toolCallId: call.id, toolName: pending.get(call.id) }));
      }
    }
  }
  return messages;
}

function readToolResult(paths: HomePaths, callId: string): string | null {
  const dirs = listDir(join(paths.opencodeStorage, "part")).slice(0, 500);
  for (const messageId of dirs) {
    const partDir = join(paths.opencodeStorage, "part", messageId);
    if (!isDir(partDir)) continue;
    for (const file of listDir(partDir)) {
      const part = readJson(join(partDir, file));
      if (part?.type === "tool" && String(part.callID) === callId && part.state?.output != null) {
        return String(part.state.output);
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* pi                                                                  */
/* ------------------------------------------------------------------ */

function scanPi(paths: HomePaths, maxFiles: number): ExternalSessionSummary[] {
  const out: ExternalSessionSummary[] = [];
  let scanned = 0;
  for (const dir of listDir(paths.piSessions)) {
    const dirPath = join(paths.piSessions, dir);
    if (!isDir(dirPath)) continue;
    for (const file of listDir(dirPath)) {
      if (!file.endsWith(".jsonl") || scanned >= maxFiles) continue;
      scanned += 1;
      const filePath = join(dirPath, file);
      const entries = readJsonLines(filePath).filter(isAnyRecord);
      const header = entries.find((e) => e.type === "session");
      if (!header?.id) continue;
      const convo = entries.filter((e) => e.type === "message" && e.message);
      if (convo.length === 0) continue;
      const firstUser = convo.find((e) => e.message?.role === "user" && blockText(e.message?.content));
      const modelEntry = convo.find((e) => e.message?.model);
      out.push({
        source: "pi",
        externalId: String(header.id),
        title: truncateTitle(blockText(firstUser?.message?.content)) || String(header.name ?? header.id),
        projectPath: typeof header.cwd === "string" ? header.cwd : null,
        model: modelEntry?.message?.model ? String(modelEntry.message.model) : null,
        createdAt: toMillis(header.timestamp, toMillis(convo[0]?.timestamp)),
        updatedAt: toMillis(convo[convo.length - 1]?.timestamp),
        messageCount: convo.length,
        filePath,
      });
    }
  }
  return out;
}

function convertPi(summary: ExternalSessionSummary): ChatMessage[] {
  const entries = readJsonLines(summary.filePath).filter(isAnyRecord);
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const createdAt = toMillis(entry.timestamp ?? entry.message.timestamp);
    const role = entry.message.role;
    const text = blockText(entry.message.content);
    if (role === "assistant") {
      const toolCalls = Array.isArray(entry.message.toolCalls)
        ? (entry.message.toolCalls as any[]).map((tc) => ({
            id: String(tc.id ?? randomUUID()),
            name: String(tc.name ?? "tool"),
            arguments: safeParseObject(tc.arguments),
          }))
        : undefined;
      if (text || toolCalls?.length) {
        messages.push(makeMessage("assistant", text, createdAt, toolCalls?.length ? { toolCalls } : {}));
      }
      continue;
    }
    if (role === "toolResult" || role === "tool") {
      messages.push(
        makeMessage("tool", text, createdAt, {
          toolCallId: entry.message.toolCallId ? String(entry.message.toolCallId) : undefined,
          toolName: entry.message.toolName ? String(entry.message.toolName) : undefined,
        }),
      );
      continue;
    }
    if (role === "user" || role === "system") {
      if (text && role === "user") messages.push(makeMessage("user", text, createdAt));
    }
  }
  return messages;
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

export function scanExternalSessions(options: ImporterOptions = {}): ImportScanResult {
  const home = options.home ?? homedir();
  const paths = homePaths(home);
  const wanted = options.sources?.length ? options.sources : SOURCES;
  const maxFiles = Math.min(Math.max(options.maxFiles ?? 400, 1), 5000);
  const sessions: ExternalSessionSummary[] = [];
  const skipped: Array<{ source: ExternalAgentSource; reason: string }> = [];

  const runners: Record<ExternalAgentSource, () => ExternalSessionSummary[]> = {
    "claude-code": () => {
      if (!existsSync(paths.claudeProjects)) return [];
      return scanClaude(paths, maxFiles);
    },
    codex: () => {
      if (!existsSync(paths.codexSessions)) return [];
      return scanCodex(paths, maxFiles);
    },
    opencode: () => {
      if (!existsSync(paths.opencodeStorage)) return [];
      return scanOpenCode(paths, maxFiles);
    },
    pi: () => {
      if (!existsSync(paths.piSessions)) return [];
      return scanPi(paths, maxFiles);
    },
  };

  for (const source of wanted) {
    try {
      const found = runners[source]();
      if (found.length === 0) {
        skipped.push({ source, reason: sourceDirMissing(paths, source) ? "not installed" : "no sessions found" });
      }
      sessions.push(...found);
    } catch (err) {
      skipped.push({ source, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions, skipped };
}

function sourceDirMissing(paths: HomePaths, source: ExternalAgentSource): boolean {
  switch (source) {
    case "claude-code":
      return !existsSync(paths.claudeProjects);
    case "codex":
      return !existsSync(paths.codexSessions);
    case "opencode":
      return !existsSync(paths.opencodeStorage);
    case "pi":
      return !existsSync(paths.piSessions);
    default:
      return true;
  }
}

export interface ConvertedExternalSession {
  id: string;
  title: string;
  projectPath: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/** Convert one scanned external session into senastr transcript shape. */
export function convertExternalSession(
  summary: ExternalSessionSummary,
  options: ImporterOptions = {},
): ConvertedExternalSession {
  const home = options.home ?? homedir();
  const paths = homePaths(home);
  let messages: ChatMessage[] = [];
  switch (summary.source) {
    case "claude-code":
      messages = convertClaude(summary);
      break;
    case "codex":
      messages = convertCodex(summary);
      break;
    case "opencode":
      messages = convertOpenCode(summary, paths);
      break;
    case "pi":
      messages = convertPi(summary);
      break;
    default:
      messages = [];
  }
  return {
    id: safeExternalId(summary.source, summary.externalId),
    title: summary.title || `${summary.source} import`,
    projectPath: summary.projectPath,
    model: summary.model,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messages,
  };
}

/**
 * Best-effort scan of the model/provider configuration other agents keep on
 * disk, so "import my providers" is one click instead of retyping keys.
 */
export function scanModelConfigs(options: ImporterOptions = {}): ModelConfigImportEntry[] {
  const home = options.home ?? homedir();
  const paths = homePaths(home);
  const entries: ModelConfigImportEntry[] = [];

  const codex = existsSync(paths.codexConfig) ? readFileSync(paths.codexConfig, "utf8") : "";
  if (codex) {
    for (const line of codex.split("\n")) {
      const match = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
      if (match) {
        entries.push({
          source: "codex",
          label: `Codex · ${match[1]}`,
          providerId: "codex-openai",
          providerLabel: "OpenAI (imported from Codex)",
          model: match[1],
          baseUrl: "https://api.openai.com/v1",
          filePath: paths.codexConfig,
        });
      }
    }
  }

  const opencode = readJson(paths.opencodeConfig);
  if (opencode?.provider && typeof opencode.provider === "object") {
    for (const [id, value] of Object.entries(opencode.provider as Record<string, any>)) {
      const models = value?.models && typeof value.models === "object" ? Object.keys(value.models) : [];
      const baseUrl = value?.options?.baseURL ?? value?.options?.baseUrl;
      for (const model of models.slice(0, 20)) {
        entries.push({
          source: "opencode",
          label: `OpenCode · ${id}/${model}`,
          providerId: `opencode-${id}`,
          providerLabel: `OpenCode ${id}`,
          model,
          baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
          filePath: paths.opencodeConfig,
        });
      }
    }
  }

  const claude = readJson(paths.claudeSettings);
  if (claude?.model && typeof claude.model === "string") {
    entries.push({
      source: "claude-code",
      label: `Claude Code · ${claude.model}`,
      providerId: "claude-code-anthropic",
      providerLabel: "Anthropic (imported from Claude Code)",
      model: claude.model,
      baseUrl: "https://api.anthropic.com",
      filePath: paths.claudeSettings,
    });
  }

  return entries;
}

function isAnyRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
