import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  RpcError,
  type JsonRpcResponse,
} from "@senastr/shared";

export interface RequestContext {
  protocolVersion: number;
}

export type MethodHandler = (params: any, ctx: RequestContext) => unknown | Promise<unknown>;

export interface RpcServerOptions {
  stdin: Readable;
  stdout: Writable;
  log?: (line: string) => void;
}

/**
 * NDJSON JSON-RPC server. Stdin carries one request/notification per line;
 * stdout is protocol-only (responses and notifications). Diagnostics go to
 * stderr so the wire format stays clean.
 */
export class RpcServer {
  private handlers = new Map<string, MethodHandler>();
  private notificationHandler: ((method: string, params: unknown) => void) | undefined;
  private closed = false;

  constructor(private readonly opts: RpcServerOptions) {}

  onMethod(method: string, handler: MethodHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  onNotification(handler: (method: string, params: unknown) => void): this {
    this.notificationHandler = handler;
    return this;
  }

  /** Push an event to the connected client. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  start(): void {
    const rl = createInterface({ input: this.opts.stdin });
    rl.on("line", (line) => {
      void this.handleLine(line);
    });
  }

  close(): void {
    this.closed = true;
  }

  private async handleLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return;

    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.write({
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCodes.PARSE_ERROR, message: "parse error" },
      } satisfies JsonRpcResponse);
      return;
    }

    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      this.write({
        jsonrpc: "2.0",
        id: msg?.id ?? null,
        error: { code: ErrorCodes.INVALID_REQUEST, message: "invalid request" },
      } satisfies JsonRpcResponse);
      return;
    }

    // Notifications: no id, never answered.
    if (msg.id === undefined || msg.id === null) {
      this.notificationHandler?.(msg.method, msg.params);
      return;
    }

    // senastr's protocol uses numeric request ids (the shared client always
    // sends numbers); reject anything else early.
    const id: unknown = msg.id;
    if (typeof id !== "number") {
      this.write({
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCodes.INVALID_REQUEST, message: "request id must be a number" },
      } satisfies JsonRpcResponse);
      return;
    }
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.sendError(id, ErrorCodes.METHOD_NOT_FOUND, `unknown method: ${msg.method}`);
      return;
    }

    try {
      const result = await handler(msg.params ?? {}, { protocolVersion: PROTOCOL_VERSION });
      if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      if (err instanceof RpcError) {
        this.sendError(id, err.code, err.message, err.data);
      } else {
        this.sendError(id, ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private sendError(id: number | null, code: number, message: string, data?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: data !== undefined ? { code, message, data } : { code, message },
    } satisfies JsonRpcResponse);
  }

  private write(msg: unknown): void {
    if (this.closed) return;
    try {
      this.opts.stdout.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.opts.log?.(`stdout write failed: ${String(err)}`);
    }
  }
}
