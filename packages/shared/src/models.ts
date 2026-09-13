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

export type ProviderKind = "openai" | "anthropic";

export interface ProviderConfig {
  /** Stable slug, e.g. "openai", "local-ollama". */
  id: string;
  kind: ProviderKind;
  label: string;
  /** For "openai": any OpenAI-compatible /v1 base (OpenAI, Ollama, vLLM,
   *  gateways). For "anthropic": API root (default https://api.anthropic.com). */
  baseUrl?: string;
  apiKey?: string;
  models: string[];
  defaultModel?: string;
}

/** Provider config with the secret masked — safe to send to the renderer. */
export interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  hasApiKey: boolean;
  models: string[];
  defaultModel?: string;
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
  source: "builtin" | "plugin";
  /** Set when source === "plugin". */
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
  tools: string[];
  installedAt: number;
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
