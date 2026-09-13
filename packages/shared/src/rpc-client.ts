/**
 * NDJSON JSON-RPC client over a child process.
 *
 * This is the same transport the desktop uses for the host-core sidecar and
 * the demo script uses headlessly. The client owns the child lifecycle and
 * correlates responses by request id; server-pushed events arrive as
 * notifications.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol";

export interface NdjsonRpcClientOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Server → client notifications. */
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Default per-request timeout; individual requests can override. */
  timeoutMs?: number;
  /** Called with the child's stderr lines (sidecar logs). */
  onStderr?: (line: string) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class NdjsonRpcClient {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private disposed = false;

  constructor(private readonly opts: NdjsonRpcClientOptions) {
    this.child = spawn(opts.command, opts.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });

    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => this.onLine(line));

    const errRl = createInterface({ input: this.child.stderr! });
    errRl.on("line", (line) => {
      if (opts.onStderr) opts.onStderr(line);
    });

    this.child.on("error", (err) => {
      this.failAll(new Error(`sidecar spawn failed: ${err.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.failAll(new Error(`sidecar exited (code=${code}, signal=${signal})`));
      opts.onExit?.({ code, signal });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("client is disposed"));
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = options?.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child.stdin!.write(JSON.stringify(message) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Fire-and-forget client → server notification. */
  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.child.stdin!.write(JSON.stringify(message) + "\n");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("client disposed"));
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  private onLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // never let a malformed line kill the client
    }
    if ("id" in msg && msg.id !== undefined) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      clearTimeout(pending.timer);
      const response = msg as JsonRpcResponse;
      if (response.error) {
        pending.reject(
          new Error(`rpc ${response.error.code}: ${response.error.message}`).withData?.(response.error.data) ??
            new Error(`rpc ${response.error.code}: ${response.error.message}`),
        );
      } else {
        pending.resolve(response.result);
      }
    } else if ("method" in msg && msg.method) {
      const notification = msg as JsonRpcNotification;
      this.opts.onNotification?.(notification.method, notification.params);
    }
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(err);
    }
  }
}

// Tiny helper so callers can read the structured payload off an rpc error.
declare global {
  interface Error {
    withData?: (data: unknown) => Error;
  }
}

export function rpcErrorData(err: unknown): unknown {
  return (err as { data?: unknown } | null)?.data;
}
