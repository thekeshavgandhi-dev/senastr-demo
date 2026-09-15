import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ErrorCodes, RpcError, type ScratchInfo } from "@senastr/shared";

/** Stale scratch dirs older than this are removed by the startup sweep even
 *  if their session still exists (parity: pi-desktop scratch.rs). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-session scratch directories (parity: pi-desktop `session/getScratchPath`).
 *
 * Temporary files an agent turn produces (intermediate scripts, downloaded
 * data, drafts) live under `<data>/scratch/<sessionId>/` instead of the user's
 * workspace, so the project directory and `git status` stay clean.
 */
export class ScratchService {
  private readonly base: string;

  constructor(dataDir: string) {
    this.base = join(dataDir, "scratch");
  }

  private sessionDir(sessionId: string): string {
    if (!isSafeId(sessionId)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "invalid session id for scratch directory");
    }
    return join(this.base, sessionId);
  }

  /** Absolute scratch path for a session, creating the directory when asked. */
  path(sessionId: string, create = false): ScratchInfo {
    const dir = this.sessionDir(sessionId);
    if (create) mkdirSync(dir, { recursive: true });
    return { sessionId, dir, exists: existsSync(dir) };
  }

  /** Remove a session's scratch directory (idempotent). */
  remove(sessionId: string): void {
    try {
      rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch {
      /* best effort — a locked file must not fail the session delete */
    }
  }

  /** Startup sweep: drop directories whose session is gone or that are stale. */
  sweep(liveSessionIds: Set<string>): number {
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(this.base);
    } catch {
      return 0;
    }
    const now = Date.now();
    for (const entry of entries) {
      const dir = join(this.base, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const age = now - statSync(dir).mtimeMs;
        if (!liveSessionIds.has(entry) || age > MAX_AGE_MS) {
          rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        /* skip unreadable entries */
      }
    }
    return removed;
  }
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length < 200 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
