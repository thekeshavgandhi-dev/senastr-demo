import type { ToolCall } from "./tools";

/** Roles used inside a persisted session transcript. `tool` messages carry
 *  the result of one tool call (linked via toolCallId). */
export type Role = "user" | "assistant" | "tool";

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
}

export interface SessionMeta {
  id: string;
  title: string;
  /** Absolute path of the local project this session works on. Null until
   *  the user opens one. */
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface Session extends SessionMeta {
  messages: ChatMessage[];
}

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
  apiKey?: string;
  apiStyle?: ProviderApiStyle;
  /** Optional non-authentication headers for gateways and organization
   * routing. Reserved credential headers are rejected by host-core. */
  headers?: Record<string, string>;
  models: string[];
  defaultModel?: string;
  /** Disabled providers stay configured but are omitted from model pickers. */
  enabled?: boolean;
}

/** Renderer-safe provider metadata. The API key is omitted and all custom
 * header values are replaced with a secret mask. */
export interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  vendorKey?: string;
  label: string;
  baseUrl?: string;
  hasApiKey: boolean;
  apiStyle: ProviderApiStyle;
  headers?: Record<string, string>;
  models: string[];
  defaultModel?: string;
  enabled: boolean;
}

/** Draft connection used by the setup dialog for live model discovery. It is
 * never persisted unless the user subsequently saves the provider. */
export interface ProviderDiscoveryInput {
  /** Existing provider id, used to preserve masked draft credentials. */
  id?: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
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
}

export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tools: string[];
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

export type TurnStopReason = "stop" | "max-steps" | "aborted" | "error";

/** Events the agent runtime emits while a turn is running. Forwarded
 *  verbatim from main to the renderer as `senastr/event`. */
export type AgentEvent =
  | { type: "turn/start"; sessionId: string; turnId: string }
  | { type: "assistant/delta"; delta: string }
  | { type: "tool/call"; call: ToolCall }
  | { type: "tool/result"; callId: string; ok: boolean; result: ToolResult }
  | { type: "turn/end"; stopReason: TurnStopReason; usage: Usage; error?: string };

/** How the UI references the model for a turn. */
export interface ModelRef {
  providerId: string;
  model: string;
}
