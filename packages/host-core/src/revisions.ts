import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ErrorCodes, RpcError, type SessionRevision } from "@senastr/shared";

interface RevisionRecord extends SessionRevision {
  /** The transcript as it existed when the revision was taken. */
  messages: unknown[];
  /** Session title at snapshot time, restored with the transcript. */
  sessionTitle: string;
  mode: string;
}

/**
 * Session revisions (parity: pi-desktop `session/saveRevision`,
 * `session/listRevisions`, `session/activateRevision`).
 *
 * A revision is a full transcript snapshot kept under
 * `<data>/revisions/<sessionId>/<revisionId>.json`. Activating one restores
 * that transcript; the revision files themselves are never pruned
 * automatically so an experiment can always be recovered.
 */
export class RevisionService {
  constructor(private readonly dir: string) {}

  private sessionDir(sessionId: string): string {
    return join(this.dir, sessionId);
  }

  private file(sessionId: string, revisionId: string): string {
    return join(this.sessionDir(sessionId), `${revisionId}.json`);
  }

  save(input: {
    sessionId: string;
    label?: string;
    title: string;
    mode: string;
    messages: unknown[];
  }): SessionRevision {
    const sessionId = requireId(input?.sessionId, "sessionId");
    const record: RevisionRecord = {
      id: randomUUID(),
      sessionId,
      label: (input.label ?? "").trim() || defaultLabel(input.messages.length),
      title: input.title,
      sessionTitle: input.title,
      mode: input.mode,
      messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
      createdAt: Date.now(),
      messages: Array.isArray(input.messages) ? input.messages : [],
    };
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const target = this.file(sessionId, record.id);
    writeFileSync(`${target}.tmp`, JSON.stringify(record, null, 2), "utf8");
    writeFileSync(target, JSON.stringify(record, null, 2), "utf8");
    try {
      unlinkSync(`${target}.tmp`);
    } catch {
      /* best effort */
    }
    return toSummary(record);
  }

  list(sessionId: string): SessionRevision[] {
    const dir = this.sessionDir(requireId(sessionId, "sessionId"));
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SessionRevision[] = [];
    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as RevisionRecord;
        out.push(toSummary(record));
      } catch {
        /* skip unreadable snapshots */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(sessionId: string, revisionId: string): RevisionRecord {
    try {
      return JSON.parse(readFileSync(this.file(requireId(sessionId, "sessionId"), revisionId), "utf8")) as RevisionRecord;
    } catch {
      throw new RpcError(ErrorCodes.SESSION_NOT_FOUND, `revision not found: ${revisionId}`);
    }
  }

  delete(sessionId: string, revisionId: string): void {
    try {
      unlinkSync(this.file(requireId(sessionId, "sessionId"), revisionId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RpcError(ErrorCodes.SESSION_NOT_FOUND, `revision not found: ${revisionId}`);
      }
    }
  }

  /** Remove every revision of a deleted session. */
  purge(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    try {
      for (const file of readdirSync(dir)) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          /* ignore */
        }
      }
      unlinkSync(dir);
    } catch {
      /* nothing to purge */
    }
  }
}

function toSummary(record: RevisionRecord): SessionRevision {
  const { messages: _messages, sessionTitle: _title, mode: _mode, ...summary } = record;
  return summary;
}

function defaultLabel(messageCount: number): string {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `${messageCount} messages · ${stamp}`;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} is required`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} is not a valid id`);
  }
  return value;
}
