import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCodes, RpcError, type ReviewSnapshot } from "@senastr/shared";

/** Snapshots cap content so one huge file cannot blow up the review store. */
const MAX_SNAPSHOT_CHARS = 200_000;
const MAX_SNAPSHOTS_PER_SESSION = 200;

/**
 * Before/after images of agent file writes, one JSON file per session.
 * Powers the Review tab (diffs) and rollback. Written only by the tool
 * runner; read/rolled-back through explicit RPC methods.
 */
export class ReviewStore {
  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private readAll(sessionId: string): ReviewSnapshot[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file(sessionId), "utf8")) as ReviewSnapshot[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeAll(sessionId: string, snapshots: ReviewSnapshot[]): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(sessionId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshots.slice(-MAX_SNAPSHOTS_PER_SESSION), null, 2), "utf8");
    renameSync(tmp, target);
  }

  /** Record a write. `before` is null when the file did not exist. */
  append(sessionId: string, path: string, before: string | null, after: string): ReviewSnapshot {
    let truncated = false;
    const cap = (text: string): string => {
      if (text.length <= MAX_SNAPSHOT_CHARS) return text;
      truncated = true;
      return text.slice(0, MAX_SNAPSHOT_CHARS);
    };
    const snapshot: ReviewSnapshot = {
      id: randomUUID(),
      sessionId,
      path,
      before: before == null ? null : cap(before),
      after: cap(after),
      truncated,
      createdAt: Date.now(),
    };
    const all = this.readAll(sessionId);
    all.push(snapshot);
    this.writeAll(sessionId, all);
    return snapshot;
  }

  list(sessionId: string): ReviewSnapshot[] {
    return this.readAll(sessionId);
  }

  get(sessionId: string, id: string): ReviewSnapshot {
    const found = this.readAll(sessionId).find((s) => s.id === id);
    if (!found) throw new RpcError(ErrorCodes.HOST_ERROR, `review snapshot not found: ${id}`);
    return found;
  }

  /** Latest snapshot for a path (rollback target). */
  latestForPath(sessionId: string, path: string): ReviewSnapshot | null {
    const all = this.readAll(sessionId).filter((s) => s.path === path);
    return all.length ? all[all.length - 1] : null;
  }

  purge(sessionId: string): void {
    try {
      unlinkSync(this.file(sessionId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
