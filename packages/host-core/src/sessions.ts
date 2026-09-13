import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ErrorCodes, RpcError, type ChatMessage, type Session, type SessionMeta, type SessionMode } from "@senastr/shared";

interface SessionRecord {
  id: string;
  title: string;
  projectPath: string | null;
  /** Durable operating mode. Missing on records predating modes → "build". */
  mode?: SessionMode;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/**
 * Session transcript store: one JSON file per session under <data>/sessions/.
 * The host-core is the only writer (ADR 0004) — the UI never touches disk.
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private load(id: string): SessionRecord {
    try {
      return JSON.parse(readFileSync(this.file(id), "utf8")) as SessionRecord;
    } catch {
      throw new RpcError(ErrorCodes.SESSION_NOT_FOUND, `session not found: ${id}`);
    }
  }

  private save(rec: SessionRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(rec.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
    renameSync(tmp, target);
  }

  list(): SessionMeta[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const f of files) {
      try {
        metas.push(this.toMeta(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as SessionRecord));
      } catch {
        // skip unreadable files rather than failing the whole list
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  create(params: { title?: string; projectPath?: string | null; mode?: SessionMode } = {}): Session {
    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: (params.title ?? "").trim() || "New session",
      projectPath: params.projectPath ?? null,
      mode: params.mode === "plan" ? "plan" : "build",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.save(rec);
    return this.toSession(rec);
  }

  get(id: string): Session {
    return this.toSession(this.load(id));
  }

  rename(id: string, title: string): Session {
    const rec = this.load(id);
    rec.title = title.trim() || rec.title;
    rec.updatedAt = Date.now();
    this.save(rec);
    return this.toSession(rec);
  }

  setMode(id: string, mode: SessionMode): Session {
    if (mode !== "build" && mode !== "plan") {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid session mode: ${String(mode)}`);
    }
    const rec = this.load(id);
    rec.mode = mode;
    rec.updatedAt = Date.now();
    this.save(rec);
    return this.toSession(rec);
  }

  setProject(id: string, projectPath: string | null): Session {
    const rec = this.load(id);
    rec.projectPath = projectPath;
    rec.updatedAt = Date.now();
    this.save(rec);
    return this.toSession(rec);
  }

  appendMessages(id: string, messages: ChatMessage[]): Session {
    if (!Array.isArray(messages)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "messages must be an array");
    const rec = this.load(id);
    rec.messages.push(...messages);
    rec.updatedAt = Date.now();
    this.save(rec);
    return this.toSession(rec);
  }

  delete(id: string): void {
    try {
      unlinkSync(this.file(id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RpcError(ErrorCodes.SESSION_NOT_FOUND, `session not found: ${id}`);
      }
    }
  }

  private toMeta(rec: SessionRecord): SessionMeta {
    return {
      id: rec.id,
      title: rec.title,
      projectPath: rec.projectPath,
      mode: rec.mode === "plan" ? "plan" : "build",
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      messageCount: rec.messages.length,
    };
  }

  private toSession(rec: SessionRecord): Session {
    return { ...this.toMeta(rec), messages: rec.messages };
  }
}
