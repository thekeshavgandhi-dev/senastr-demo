import type {
  ChatMessage,
  ProviderApiStyle,
  ProviderKind,
  Session,
  SkillRecord,
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
}

/** Normalized stream events from any provider. */
export type ProviderEvent =
  | { kind: "text"; delta: string }
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
  runTool(req: { sessionId: string; tool: string; args: Record<string, unknown> }): Promise<ToolResult>;
}

export interface AgentOptions {
  /** Safety valve: max model→tool round-trips per turn. Default 24. */
  maxSteps?: number;
  /** Injectable provider factory (tests use this with a scripted provider). */
  providerFactory?: (spec: ModelSpec) => Provider;
}

export type { ChatMessage, ToolCall, ToolDefinition, ToolResult, Usage, Session };
