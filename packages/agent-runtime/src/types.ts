import type {
  ChatMessage,
  ModelRef,
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
  /** Enabled subagent definitions visible to the Task tool. */
  listSubagents?(projectPath?: string | null): Promise<SubagentRecord[]>;
  /** Standing instructions + memory. Null projectPath = global layer. */
  getProjectContext?(projectPath: string | null): Promise<ProjectContext>;
  /**
   * Durable memory for the system prompt: the memory index plus passages
   * recalled for `query`, already rendered and size-capped by the host.
   * Returns "" when there is nothing to recall.
   */
  memoryPrompt?(projectPath: string, query: string, limit?: number): Promise<string>;
  /** Resolve a model reference to a runnable spec (API keys included). */
  resolveModel?(ref: ModelRef): Promise<ModelSpec>;
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
  /**
   * Load a strongly-matching skill body automatically instead of waiting for
   * an explicit `use_skill` call. Default true; it is the safety net for a
   * model that forgets to activate a skill.
   */
  autoActivateSkills?: boolean;
  /**
   * Summarise compacted-away history with the model instead of dropping it
   * behind a placeholder. Default true; costs one extra request per
   * compaction, and falls back to the placeholder if it fails.
   */
  summarizeHistory?: boolean;
  /** Max concurrent subagents inside one `batch_tasks` call. Default 4. */
  maxDelegationConcurrency?: number;
}

export type { ChatMessage, ToolCall, ToolDefinition, ToolResult, Usage, Session };
