/**
 * senastr wire protocol.
 *
 * All inter-process traffic in senastr is NDJSON JSON-RPC 2.0:
 *   - one JSON object per line
 *   - requests carry a numeric `id`, responses echo it
 *   - notifications (events) carry only `method`
 *
 * This package is the single source of truth for method names, error codes
 * and the shapes that cross the process boundary. Every side (Electron main,
 * host-core sidecar, agent runtime, demo script) imports from here.
 */

export const PROTOCOL_VERSION = 1;
export const SENASTR_VERSION = "0.1.0";

/** Default timeout for a single RPC request. Long-polling style methods
 *  (tool/run, which may wait on a permission prompt) pass an explicit
 *  timeoutMs override. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Permission prompts are denied automatically after this long (ADR 0005). */
export const PERMISSION_TIMEOUT_MS = 120_000;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  /** Null only on protocol-level errors (parse/invalid request). */
  id: number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/** JSON-RPC 2.0 standard codes + senastr application codes. */
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // application
  HOST_ERROR: -32000,
  PATH_ESCAPES_PROJECT: -32001,
  TOOL_NOT_FOUND: -32002,
  PERMISSION_DENIED: -32003,
  PERMISSION_TIMEOUT: -32004,
  SESSION_NOT_FOUND: -32005,
  PROVIDER_ERROR: -32006,
  PROVIDER_NOT_FOUND: -32007,
  PLUGIN_INVALID: -32008,
  EXEC_TIMEOUT: -32009,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Error with a stable numeric code that survives the JSON-RPC boundary. */
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * Method names. Kept as a const map (not a union) so both sides can
 * `typeof Methods[keyof typeof Methods]` when building typed clients.
 */
export const Methods = {
  hostPing: "host/ping",
  hostToolsList: "host/tools/list",

  sessionList: "session/list",
  sessionCreate: "session/create",
  sessionGet: "session/get",
  sessionRename: "session/rename",
  sessionSetMode: "session/set-mode",
  sessionSetProject: "session/set-project",
  sessionDelete: "session/delete",
  sessionAppendMessages: "session/append-messages",

  providerList: "provider/list",
  providerGet: "provider/get",
  providerSet: "provider/set",
  providerDelete: "provider/delete",
  providerTest: "provider/test",
  providerDiscoverModels: "provider/discover-models",

  skillList: "skill/list",
  skillActive: "skill/active",
  skillSet: "skill/set",
  skillDelete: "skill/delete",
  skillSetEnabled: "skill/set-enabled",

  mcpList: "mcp/list",
  mcpSet: "mcp/set",
  mcpDelete: "mcp/delete",
  mcpSetEnabled: "mcp/set-enabled",
  mcpTest: "mcp/test",

  toolRun: "tool/run",

  permissionRespond: "permission/respond",
  permissionList: "permission/list",
  permissionClear: "permission/clear",

  subagentList: "subagent/list",
  subagentActive: "subagent/active",
  subagentSet: "subagent/set",
  subagentDelete: "subagent/delete",
  subagentSetEnabled: "subagent/set-enabled",

  scheduledList: "scheduled/list",
  scheduledSet: "scheduled/set",
  scheduledDelete: "scheduled/delete",
  scheduledSetEnabled: "scheduled/set-enabled",
  scheduledRuns: "scheduled/runs",
  scheduledRecordRun: "scheduled/record-run",

  reviewList: "review/list",
  reviewRollback: "review/rollback",

  projectGetContext: "project/get-context",
  projectSetContext: "project/set-context",

  pluginList: "plugin/list",
  pluginInstall: "plugin/install",
  pluginUninstall: "plugin/uninstall",
  pluginSetEnabled: "plugin/set-enabled",
} as const;

export type MethodName = (typeof Methods)[keyof typeof Methods];

/** Server → client notifications. */
export const Notifications = {
  permissionRequested: "permission/requested",
} as const;

export type NotificationName = (typeof Notifications)[keyof typeof Notifications];
