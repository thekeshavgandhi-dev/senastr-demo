import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PERMISSION_TIMEOUT_MS,
  type GrantScope,
  type PermissionGrant,
  type PermissionRequest,
} from "@senastr/shared";
import { JsonFileStore } from "./store";

export interface PermissionDecision {
  allowed: boolean;
  remember: GrantScope | null;
  timedOut: boolean;
}

interface PendingPermission {
  request: PermissionRequest;
  timer: NodeJS.Timeout;
  resolve: (decision: PermissionDecision) => void;
}

/**
 * The permission gateway (ADR 0005).
 *
 * Rules, frozen:
 *  - grants are per (toolName, session) or "always"
 *  - a write/exec tool without a grant creates an interactive request and
 *    the host blocks until the UI answers
 *  - unanswered requests are DENIED after PERMISSION_TIMEOUT_MS (120s)
 *
 * The service is transport-agnostic: `notify` is injected so the same code
 * runs behind the real server and in tests.
 */
export class PermissionService {
  private grants: JsonFileStore<PermissionGrant[]>;
  private pending = new Map<string, PendingPermission>();

  constructor(
    dataDir: string,
    private readonly notify: (method: string, params: unknown) => void,
    private readonly timeoutMs: number = PERMISSION_TIMEOUT_MS,
  ) {
    this.grants = new JsonFileStore<PermissionGrant[]>(join(dataDir, "grants.json"), []);
  }

  hasGrant(sessionId: string, tool: string): boolean {
    return this.grants.get().some(
      (g) => g.tool === tool && (g.scope === "always" || (g.scope === "session" && g.sessionId === sessionId)),
    );
  }

  /**
   * Ask for approval. Resolves when the UI answers or the timeout fires.
   * Returns before resolving only if a grant already covers the call.
   */
  request(params: {
    sessionId: string;
    tool: string;
    args: Record<string, unknown>;
    summary: string;
  }): Promise<PermissionDecision> {
    const request: PermissionRequest = {
      requestId: randomUUID(),
      sessionId: params.sessionId,
      tool: params.tool,
      args: params.args,
      summary: params.summary,
      createdAt: Date.now(),
    };
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        resolve({ allowed: false, remember: null, timedOut: true });
      }, this.timeoutMs);
      this.pending.set(request.requestId, { request, timer, resolve });
      this.notify("permission/requested", request);
    });
  }

  /** UI answered a pending request. Returns false for unknown requestIds. */
  respond(requestId: string, allow: boolean, remember: GrantScope | null): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (allow && remember) {
      this.addGrant(entry.request.sessionId, entry.request.tool, remember);
    }
    entry.resolve({ allowed: allow, remember: allow && remember ? remember : null, timedOut: false });
    return true;
  }

  /** Test hook: how many requests are currently waiting on the UI. */
  pendingCount(): number {
    return this.pending.size;
  }

  addGrant(sessionId: string, tool: string, scope: GrantScope): void {
    this.grants.update((all) => {
      const filtered = all.filter((g) => {
        if (g.tool !== tool) return true;
        if (scope === "always") return false; // "always" subsumes session grants
        return !(g.scope === "session" && g.sessionId === sessionId);
      });
      filtered.push({
        sessionId: scope === "always" ? null : sessionId,
        tool,
        scope,
        createdAt: Date.now(),
      });
      return filtered;
    });
  }

  list(): PermissionGrant[] {
    return this.grants.get();
  }

  clear(sessionId?: string, tool?: string): void {
    this.grants.update((all) =>
      all.filter((g) => {
        if (tool && g.tool !== tool) return true;
        if (sessionId && g.sessionId !== sessionId) return true;
        return false;
      }),
    );
  }
}
