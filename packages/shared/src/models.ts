import type { ToolCall } from "./tools";
import type { ThinkingLevel } from "./thinking-levels";
import type { NetworkProxySettings } from "./network-proxy";

export type { ThinkingLevel };

/** Roles used inside a persisted session transcript. `tool` messages carry
 *  the result of one tool call (linked via toolCallId). */
export type Role = "user" | "assistant" | "tool";

/** A user-supplied file or image riding along with a message. Image payloads
 *  never live in the transcript: `storeId` points at a copy under
 *  `<data>/attachments/` that only the host core can read. */
export interface MessageAttachment {
  id: string;
  kind: "image" | "file";
  /** Original file name, for display only. */
  name: string;
  /** MIME type, e.g. `image/png`. */
  mimeType: string;
  /** Bytes on disk (or of the pasted text, for large pastes). */
  bytes?: number;
  /** Host-core attachment id; resolve with `attachment/read`. */
  storeId?: string;
  /** Project-relative path, for files pulled out of the workspace. */
  path?: string;
  /** Inline text content for large pastes. */
  text?: string;
  /** Hydration-only: base64 payload resolved by the runtime just before a
   *  model request. Never persisted in a transcript. */
  dataBase64?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool messages: which call this is the result of. */
  toolCallId?: string;
  /** Present on tool messages: the tool name (denormalized for the UI). */
  toolName?: string;
  /** Files/images the user attached to this message (parity: pi-desktop). */
  attachments?: MessageAttachment[];
  /** Reasoning text streamed by a reasoning model, kept for display. */
  reasoning?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  /** Absolute path of the local project this session works on. Null until
   *  the user opens one. */
  projectPath: string | null;
  /** Durable operating mode. Plan mode is read-only until a submitted plan
   *  is approved. Defaults to "build" for sessions created before modes. */
  mode: SessionMode;
  /** Reasoning level for this session (parity: pi-desktop thinking levels).
   *  Absent means "use the model's default / strongest enabled level". */
  thinkingLevel?: ThinkingLevel;
  /** Session this one was forked from, when it was created by a fork. */
  forkedFrom?: string;
  /** Id of the revision currently active, when revisions are in play. */
  activeRevision?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface Session extends SessionMeta {
  messages: ChatMessage[];
}

/** The placeholder shown for any stored secret (API key, header value, env
 * value). Sending the mask back to host-core means "keep the stored value". */
export const SECRET_MASK = "••••••";

export type ProviderKind = "openai" | "anthropic" | "google";

/** The HTTP wire format used by a provider. `kind` is retained as the broad
 * runtime family while this value lets compatible gateways choose the exact
 * API they expose. */
export type ProviderApiStyle =
  | "chat_completions"
  | "responses"
  | "anthropic_messages"
  | "google_generative_ai";

export interface ProviderConfig {
  /** Stable slug, e.g. "openai", "local-ollama". */
  id: string;
  kind: ProviderKind;
  /** Stable catalog key when this was created from a named service preset. */
  vendorKey?: string;
  label: string;
  /** API root. Operation suffixes such as /chat/completions are added by the
   * runtime and should not be included here. */
  baseUrl?: string;
  /** Legacy single key. `apiKeys` is preferred; when present it wins. */
  apiKey?: string;
  /** Key pool. The runtime rotates through these automatically when one
   * hits its rate limit (HTTP 429) or is rejected (401/403), so a burst of
   * usage does not stall the agent. Entries equal to {@link SECRET_MASK}
   * mean "keep the stored key at this position". */
  apiKeys?: string[];
  apiStyle?: ProviderApiStyle;
  /** Optional non-authentication headers for gateways and organization
   * routing. Reserved credential headers are rejected by host-core. */
  headers?: Record<string, string>;
  /** Optional client-side throttle: max model requests per minute across the
   * whole key pool (0/undefined = no throttling). Keeps you under the
   * provider's own limits before they get a chance to reject you. */
  rateLimitPerMin?: number;
  models: string[];
  defaultModel?: string;
  /** Per-model overrides: context window, output cap, temperature and the
   * reasoning ladder (parity: pi-desktop model configuration). */
  modelConfigs?: Record<string, ModelConfig>;
  /** Disabled providers stay configured but are omitted from model pickers. */
  enabled?: boolean;
}

/**
 * Per-model configuration. Every field is optional: absent means "use the
 * built-in default for this provider family".
 */
export interface ModelConfig {
  /** Context window in tokens (drives the context-usage bar + compaction). */
  contextWindow?: number;
  /** Maximum output tokens per request. */
  maxOutputTokens?: number;
  /** Sampling temperature; omitted means the provider default. */
  temperature?: number;
  /** Does this model accept a reasoning/thinking control? */
  reasoning?: boolean;
  /** Levels the model publishes, in canonical order. */
  supportedThinkingLevels?: ThinkingLevel[];
  /** Level a new session starts at when none is stored. */
  defaultThinkingLevel?: ThinkingLevel | null;
  /** Provider-specific spelling of each level (e.g. `{"high":"high"}`). */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/** Renderer-safe model configuration (no credentials involved). */
export interface ModelConfigSummary {
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
}

/** Renderer-safe provider metadata. API keys are omitted (only the count is
 * exposed) and all custom header values are replaced with a secret mask. */
export interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  vendorKey?: string;
  label: string;
  baseUrl?: string;
  hasApiKey: boolean;
  /** How many keys are stored in the provider's key pool. */
  apiKeyCount: number;
  apiStyle: ProviderApiStyle;
  headers?: Record<string, string>;
  rateLimitPerMin?: number;
  models: string[];
  defaultModel?: string;
  /** Per-model overrides (context window, output cap, temperature, reasoning). */
  modelConfigs?: Record<string, ModelConfig>;
  enabled: boolean;
}

/** Draft connection used by the setup dialog for live model discovery. It is
 * never persisted unless the user subsequently saves the provider. */
export interface ProviderDiscoveryInput {
  /** Existing provider id, used to preserve masked draft credentials. */
  id?: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** Legacy single key for the probe request. */
  apiKey?: string;
  /** Key pool draft; masked entries resolve against the stored keys. The
   * first resolved key is used for the probe. */
  apiKeys?: string[];
  apiStyle?: ProviderApiStyle;
  headers?: Record<string, string>;
}

export interface ProviderTestResult {
  ok: boolean;
  detail: string;
  /** Model ids reported by the endpoint (best effort). */
  models?: string[];
}

export type ToolRisk = "read" | "write" | "exec";

export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** read: no approval; write/exec: gated by the permission layer. */
  risk: ToolRisk;
  source: "builtin" | "plugin" | "mcp";
  /** Plugin name, or MCP server id, for contributed tools. */
  plugin?: string;
}

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Human readable one-liner shown in the dialog. */
  summary: string;
  createdAt: number;
}

export type GrantScope = "session" | "always";

export interface PermissionGrant {
  /** null when scope is "always". */
  sessionId: string | null;
  tool: string;
  scope: GrantScope;
  createdAt: number;
}

export interface PluginToolDef {
  name: string;
  description: string;
  /** Shell command template. `{arg}` placeholders are substituted from the
   *  tool arguments (shell-quoted). */
  command: string;
  args?: ToolParameters;
}

/** A slash/palette command contributed by a plugin (parity: pi-desktop
 *  `contributes.commands`). `command` runs through the same confined,
 *  permission-gated shell as plugin tools. */
export interface PluginCommandDef {
  /** Slash alias, unique across the merged command namespace. */
  name: string;
  title?: string;
  description?: string;
  keywords?: string[];
  /** Optional shell command template (same `{arg}` substitution as tools). */
  command?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions?: {
    fs?: string[];
    net?: string[];
  };
  tools?: PluginToolDef[];
  commands?: PluginCommandDef[];
}

export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tools: string[];
  commands?: PluginCommandDef[];
  permissions?: {
    fs?: string[];
    net?: string[];
  };
  enabled: boolean;
  installedAt: number;
}

/** The storage level for a user-owned capability. Project records are active
 * only when their project path matches the current session. */
export type CapabilityLevel = "global" | "project";

export interface SkillRecord {
  id: string;
  name: string;
  description?: string;
  /** Markdown instructions appended to the agent system prompt while active. */
  content: string;
  enabled: boolean;
  level: CapabilityLevel;
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SkillInput {
  id?: string;
  name: string;
  description?: string;
  content: string;
  enabled?: boolean;
  level?: CapabilityLevel;
  projectPath?: string;
}

export type McpTransport = "stdio" | "http";
export type McpConnectionState = "idle" | "connecting" | "ready" | "failed";

export interface McpServerConfig {
  id: string;
  label: string;
  description?: string;
  transport: McpTransport;
  /** stdio executable and argument vector. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable HTTP endpoint and optional request headers. */
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  level: CapabilityLevel;
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

/** Renderer-safe MCP record. Environment and header values are masked once
 * stored; sending the mask back leaves the existing value unchanged. */
export interface McpServerSummary extends Omit<McpServerConfig, "env" | "headers"> {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpServerInput {
  id: string;
  label?: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  level?: CapabilityLevel;
  projectPath?: string;
}

export interface McpServerStatus {
  serverId: string;
  state: McpConnectionState;
  toolCount: number;
  toolNames?: string[];
  message?: string;
  updatedAt: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type TurnStopReason = "stop" | "max-steps" | "aborted" | "error" | "plan" | "goal";

/** Events the agent runtime emits while a turn is running. Forwarded
 *  verbatim from main to the renderer as `senastr/event`. */
export type AgentEvent =
  | { type: "turn/start"; sessionId: string; turnId: string }
  | { type: "assistant/delta"; delta: string }
  /** Reasoning/thinking text from a reasoning model (display only). */
  | { type: "assistant/reasoning"; delta: string }
  | { type: "tool/call"; call: ToolCall }
  | { type: "tool/result"; callId: string; ok: boolean; result: ToolResult }
  | {
      type: "turn/end";
      stopReason: TurnStopReason;
      usage: Usage;
      error?: string;
      /** Present when the request window had to drop or trim history. */
      compaction?: { dropped: number; truncated: boolean };
    }
  | { type: "ask/request"; request: AskRequest }
  | { type: "ask/resolved"; requestId: string; sessionId: string }
  | { type: "plan/proposed"; sessionId: string; proposal: PlanProposal }
  | { type: "plan/resolved"; sessionId: string; decision: "approved" | "rejected" }
  | { type: "subagent/start"; sessionId: string; delegation: DelegationSummary }
  | { type: "subagent/end"; sessionId: string; delegation: DelegationSummary };

/** How the UI references the model for a turn. */
export interface ModelRef {
  providerId: string;
  model: string;
}

/* ------------------------------------------------------------------ */
/* Ask-user tool                                                       */
/* ------------------------------------------------------------------ */

/** One question inside an ask_user tool call. */
export interface AskQuestion {
  id: string;
  /** Short label shown above the question. */
  header?: string;
  question: string;
  /** Suggested options. Empty/omitted = free-text answer. */
  options?: string[];
  multiSelect?: boolean;
}

/** A paused turn waiting for the user to answer. */
export interface AskRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  questions: AskQuestion[];
  createdAt: number;
}

/** Answers mirror questions by position: selected option strings (possibly
 * empty) or null when the question was skipped. */
export type AskAnswers = Array<string[] | null>;

/* ------------------------------------------------------------------ */
/* Plan mode                                                           */
/* ------------------------------------------------------------------ */

/**
 * Operating mode. `build` is the everyday agent; `plan` researches and freezes
 * an implementation plan for approval; `goal` locks an objective and acceptance
 * criteria and lets the agent choose the path (parity: pi-desktop's Agent /
 * Plan / Goal modes).
 */
export type SessionMode = "build" | "plan" | "goal";

export const SESSION_MODES: readonly SessionMode[] = ["build", "plan", "goal"] as const;

export function isSessionMode(value: unknown): value is SessionMode {
  return value === "build" || value === "plan" || value === "goal";
}

/** Structured plan submitted via the submit_plan tool while in plan mode. */
export interface PlanProposal {
  sessionId: string;
  toolCallId: string;
  summary: string;
  steps: string[];
  risks?: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Subagents                                                           */
/* ------------------------------------------------------------------ */

/** A named delegate personality the model can spawn via the Task tool. */
export interface SubagentRecord {
  id: string;
  name: string;
  description?: string;
  /** Extra system-prompt block for delegated runs. */
  systemPrompt: string;
  model?: ModelRef | null;
  enabled: boolean;
  level: CapabilityLevel;
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SubagentInput {
  id?: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model?: ModelRef | null;
  enabled?: boolean;
  level?: CapabilityLevel;
  projectPath?: string;
}

export type DelegationStatus = "running" | "done" | "error" | "stopped";

/** One Task-tool delegation owned by a session. */
export interface DelegationSummary {
  id: string;
  sessionId: string;
  agentName: string;
  description: string;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  turns?: number;
  /** Final report (present once settled; truncated for transport). */
  report?: string;
  usage?: Usage;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Scheduled tasks                                                     */
/* ------------------------------------------------------------------ */

export type ScheduleCadence = "manual" | "hourly" | "daily" | "weekly" | "cron";
export type ScheduledRunStatus = "running" | "done" | "error";

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  projectPath: string;
  providerId: string;
  model: string;
  cadence: ScheduleCadence;
  /** 5-field cron expression when cadence is "cron". */
  cron?: string;
  enabled: boolean;
  /** Headless session the task runs in (created on first run). */
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: ScheduledRunStatus;
}

export interface ScheduledTaskInput {
  id?: string;
  title: string;
  prompt: string;
  projectPath: string;
  providerId: string;
  model: string;
  cadence?: ScheduleCadence;
  cron?: string;
  enabled?: boolean;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  sessionId?: string;
  status: ScheduledRunStatus;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Review snapshots                                                    */
/* ------------------------------------------------------------------ */

/** Before/after image of one agent file write, for review + rollback. */
export interface ReviewSnapshot {
  id: string;
  sessionId: string;
  /** Path relative to the project root. */
  path: string;
  /** Previous content; null when the file is new. */
  before: string | null;
  after: string;
  truncated: boolean;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Project instructions + memory                                       */
/* ------------------------------------------------------------------ */

export interface ProjectContext {
  /** Null = global instructions shared by every project. */
  projectPath: string | null;
  instructions: string;
  memory: string;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Git + pull requests                                                 */
/* ------------------------------------------------------------------ */

export interface GitInfo {
  branch: string | null;
  /** Number of changed paths in `git status --porcelain`. */
  dirty: number;
  error?: string;
}

export interface PullSummary {
  number: number;
  title: string;
  url: string;
  author?: string;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  isDraft: boolean;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export interface AppNotification {
  id: string;
  title: string;
  body?: string;
  kind: "info" | "success" | "error" | "ask" | "plan" | "scheduled";
  sessionId?: string;
  taskId?: string;
  createdAt: number;
  read: boolean;
}

/* ------------------------------------------------------------------ */
/* Session revisions                                                   */
/* ------------------------------------------------------------------ */

/** A named snapshot of a session transcript. Revisions are append-only:
 *  activating one truncates the live transcript back to that point without
 *  deleting the revision itself, so an experiment is always recoverable. */
export interface SessionRevision {
  id: string;
  sessionId: string;
  label: string;
  /** Message count captured by this revision. */
  messageCount: number;
  /** Turn count when the revision was taken (informational). */
  title: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Projects + project groups                                           */
/* ------------------------------------------------------------------ */

/** A project the user added to the workspace. Sessions bind to a path; the
 *  project record keeps ordering, a display name and grouping durable. */
export interface ProjectRecord {
  path: string;
  name?: string;
  addedAt: number;
  lastOpenedAt: number;
  pinned?: boolean;
  /** Ordered id of the group this project belongs to, when any. */
  groupId?: string;
  /** Session count at last refresh (informational for the sidebar). */
  sessionCount?: number;
}

export interface ProjectGroup {
  id: string;
  name: string;
  createdAt: number;
}

export interface ProjectInput {
  path: string;
  name?: string;
  pinned?: boolean;
  groupId?: string | null;
}

export interface ProjectGroupInput {
  id?: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/* Token usage history                                                 */
/* ------------------------------------------------------------------ */

/** One completed turn's token accounting. Written by the host core when a
 *  turn ends, so usage survives even if the window is closed. */
export interface UsageRecord {
  id: string;
  sessionId: string;
  at: number;
  providerId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: TurnStopReason;
}

export interface TokenUsageBucket {
  /** ISO date for `day`, ISO week for `week`, `YYYY-MM` for `month`. */
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface TokenUsageHistory {
  buckets: TokenUsageBucket[];
  totals: { inputTokens: number; outputTokens: number; turns: number };
}

/* ------------------------------------------------------------------ */
/* Application settings                                                */
/* ------------------------------------------------------------------ */

/** Settings owned by the host so the desktop, the demo and any future client
 *  agree on them. Renderer-only preferences (theme, layout) stay local. */
export interface AppSettings {
  /** UI language tag (parity: pi-desktop i18n). */
  language?: string;
  /** Outbound network proxy (see network-proxy.ts). */
  proxy?: NetworkProxySettings;
  /** Update policy. */
  updates?: {
    autoCheck?: boolean;
    /** Channel the app should follow, e.g. "latest". */
    channel?: string;
  };
  /** Command shell used by `run_command` on Windows (parity: command shells). */
  commandShell?: string;
  /** Maximum model→tool round trips per turn. */
  maxSteps?: number;
}

/* ------------------------------------------------------------------ */
/* Session + model-config import                                       */
/* ------------------------------------------------------------------ */

export type ExternalAgentSource = "claude-code" | "codex" | "opencode" | "pi";

export interface ExternalSessionSummary {
  source: ExternalAgentSource;
  externalId: string;
  title: string;
  projectPath: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number | null;
  /** Where the session was read from (for display + provenance). */
  filePath: string;
}

export interface ImportScanResult {
  sessions: ExternalSessionSummary[];
  /** Sources that were looked at but had nothing to offer. */
  skipped: Array<{ source: ExternalAgentSource; reason: string }>;
}

export interface ImportRunResult {
  imported: number;
  sessions: SessionMeta[];
  errors: Array<{ externalId: string; error: string }>;
}

export interface ModelConfigImportEntry {
  source: ExternalAgentSource;
  label: string;
  providerId: string;
  providerLabel: string;
  model: string;
  baseUrl?: string;
  filePath: string;
}

/* ------------------------------------------------------------------ */
/* Workspace file index (@ file references)                            */
/* ------------------------------------------------------------------ */

export interface FileIndexResult {
  paths: string[];
  /** True when the directory had more entries than the cap. */
  truncated: boolean;
  /** Milliseconds spent scanning (informational). */
  elapsedMs: number;
}

/* ------------------------------------------------------------------ */
/* In-app updates                                                      */
/* ------------------------------------------------------------------ */

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error"
  | "unsupported";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  /** 0-100 while downloading. */
  progress?: number;
  error?: string;
  checkedAt?: number;
  /** True when the build can self-update (electron-updater configured). */
  canSelfUpdate: boolean;
}

/* ------------------------------------------------------------------ */
/* Scratch directories                                                 */
/* ------------------------------------------------------------------ */

export interface ScratchInfo {
  sessionId: string;
  /** Absolute path of the per-session scratch directory. */
  dir: string;
  /** True when the directory exists on disk right now. */
  exists: boolean;
}
