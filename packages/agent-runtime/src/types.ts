import type {
  ChatMessage,
  MessageAttachment,
  ModelRef,
  NetworkProxySettings,
  ThinkingLevel,
  ProjectContext,
  ProviderApiStyle,
  ProviderKind,
  Session,
  SkillRecord,
  SubagentRecord,
  ToolCall,
  ToolDefinition,
  ToolResult,
  Usage,
} from "@senastr/shared";

/** Everything the loop needs to reach a model. The desktop resolves this
 *  from the host's provider registry on every turn (keys never live in the
 *  renderer). */
export interface ModelSpec {
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  /** Legacy single key; `apiKeys` (when present) is the key pool. */
  apiKey?: string;
  /** Key pool. When a request hits a rate limit (429) or a rejected key
   * (401/403), the next key in the pool is used automatically. */
  apiKeys?: string[];
  apiStyle?: ProviderApiStyle;
  headers?: Record<string, string>;
  /** Client-side throttle: max model requests per minute for this provider. */
  rateLimitPerMin?: number;
  /** Provider registry id; identifies the key pool / throttle bucket. */
  providerId?: string;
  /** Reasoning level requested for this turn (parity: thinking levels). */
  thinkingLevel?: ThinkingLevel;
  /** Sampling temperature from the model configuration. */
  temperature?: number;
  /** Output token cap from the model configuration. */
  maxOutputTokens?: number;
  /** Context window from the model configuration (drives compaction). */
  contextWindow?: number;
  /** Outbound proxy for this provider's requests (see network-proxy.ts). */
  proxy?: NetworkProxySettings;
}

/** Normalized stream events from any provider. */
export type ProviderEvent =
  | { kind: "text"; delta: string }
  /** Reasoning/thinking text, kept on a separate channel from the answer. */
  | { kind: "reasoning"; delta: string }
  | { kind: "tool-call"; id: string; name: string; arguments: Record<string, unknown> }
  | { kind: "done"; usage?: Usage; finishReason?: string };

export interface ProviderChatParams {
  model: string;
  /** System prompt; kept out of the persisted transcript. */
  system?: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  maxTokens?: number;
  /** Reasoning level for this request (from the session / model config). */
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
}

export interface Provider {
  streamChat(params: ProviderChatParams): AsyncIterable<ProviderEvent>;
}

/**
 * The agent loop's view of the host. The desktop implements this with an
 * NDJSON JSON-RPC client; tests implement it in-memory.
 */
export interface HostBridge {
  getSession(id: string): Promise<Session>;
  appendMessages(id: string, messages: ChatMessage[]): Promise<unknown>;
  listTools(sessionId?: string): Promise<ToolDefinition[]>;
  /** Optional for lightweight/test hosts. Desktop host-core implements it. */
  listSkills?(projectPath?: string | null): Promise<SkillRecord[]>;
  /** Enabled subagent definitions visible to the Task tool. */
  listSubagents?(projectPath?: string | null): Promise<SubagentRecord[]>;
  /** Standing instructions + memory. Null projectPath = global layer. */
  getProjectContext?(projectPath: string | null): Promise<ProjectContext>;
  /** Resolve a model reference to a runnable spec (API keys included). */
  resolveModel?(ref: ModelRef): Promise<ModelSpec>;
  /** Hydrate an attachment's bytes for a multimodal request. */
  readAttachment?(storeId: string): Promise<{ mimeType: string; base64: string; name: string }>;
  /** Record one completed turn's token usage (parity: stats/getTokenUsageHistory). */
  recordUsage?(record: {
    sessionId: string;
    providerId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    stopReason?: string;
  }): Promise<unknown>;
  runTool(req: { sessionId: string; tool: string; args: Record<string, unknown> }): Promise<ToolResult>;
}

export interface AgentOptions {
  /** Safety valve: max model→tool round-trips per turn. Default 24. */
  maxSteps?: number;
  /** Character budget for the model window per request. Older turns are
   *  dropped behind a checkpoint note once the budget is exceeded. */
  contextCharBudget?: number;
  /** Injectable provider factory (tests use this with a scripted provider). */
  providerFactory?: (spec: ModelSpec) => Provider;
}

export type { ChatMessage, MessageAttachment, ToolCall, ToolDefinition, ToolResult, Usage, Session };
