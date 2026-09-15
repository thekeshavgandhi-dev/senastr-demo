import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ErrorCodes,
  RpcError,
  isSessionMode,
  isThinkingLevel,
  type ChatMessage,
  type Session,
  type SessionMeta,
  type SessionMode,
  type ThinkingLevel,
} from "@senastr/shared";

interface SessionRecord {
  id: string;
  title: string;
  projectPath: string | null;
  /** Durable operating mode. Missing on records predating modes → "build". */
  mode?: SessionMode;
  /** Reasoning level for this session (absent = model default). */
  thinkingLevel?: ThinkingLevel;
  /** Session this one was forked from. */
  forkedFrom?: string;
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

  create(
    params: {
      title?: string;
      projectPath?: string | null;
      mode?: SessionMode;
      thinkingLevel?: ThinkingLevel;
      forkedFrom?: string;
      /** Explicit id (session import uses a deterministic one so a repeated
       *  import of the same external session is a no-op). */
      id?: string;
      createdAt?: number;
      updatedAt?: number;
      messages?: ChatMessage[];
    } = {},
  ): Session {
    const now = Date.now();
    const id = typeof params.id === "string" && /^[A-Za-z0-9_.-]+$/.test(params.id) ? params.id : randomUUID();
    const rec: SessionRecord = {
      id,
      title: (params.title ?? "").trim() || "New session",
      projectPath: params.projectPath ?? null,
      mode: normalizeMode(params.mode),
      createdAt: typeof params.createdAt === "number" ? params.createdAt : now,
      updatedAt: typeof params.updatedAt === "number" ? params.updatedAt : now,
      messages: Array.isArray(params.messages) ? params.messages : [],
    };
    if (isThinkingLevel(params.thinkingLevel)) rec.thinkingLevel = params.thinkingLevel;
    if (typeof params.forkedFrom === "string" && params.forkedFrom) rec.forkedFrom = params.forkedFrom;
    this.save(rec);
    return this.toSession(rec);
  }

  /** True when a deterministic id (an import) already exists on disk. */
  exists(id: string): boolean {
    return existsSync(this.file(id));
  }

  /**
   * Fork a session: a new session with the copied transcript and the same
   * project, mode and thinking level. Server-side (parity: pi-desktop
   * `session/fork`) so every client sees identical semantics.
   */
  fork(id: string, params: { title?: string; messageCount?: number } = {}): Session {
    const source = this.load(id);
    const slice =
      typeof params.messageCount === "number" && params.messageCount >= 0
        ? source.messages.slice(0, Math.min(params.messageCount, source.messages.length))
        : source.messages;
    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: (params.title ?? "").trim() || `${source.title} (fork)`,
      projectPath: source.projectPath,
      mode: normalizeMode(source.mode),
      thinkingLevel: source.thinkingLevel,
      forkedFrom: source.id,
      createdAt: now,
      updatedAt: now,
      messages: slice.map((message) => ({ ...message, id: randomUUID() })),
    };
    this.save(rec);
    return this.toSession(rec);
  }

  setThinkingLevel(id: string, level: ThinkingLevel | null): Session {
    if (level !== null && !isThinkingLevel(level)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid thinking level: ${String(level)}`);
    }
    const rec = this.load(id);
    if (level === null) delete rec.thinkingLevel;
    else rec.thinkingLevel = level;
    rec.updatedAt = Date.now();
    this.save(rec);
    return this.toSession(rec);
  }

  /** Replace the transcript wholesale (revision activation, compaction save). */
  replaceMessages(id: string, messages: ChatMessage[]): Session {
    if (!Array.isArray(messages)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "messages must be an array");
    const rec = this.load(id);
    rec.messages = messages;
    rec.updatedAt = Date.now();
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
    if (!isSessionMode(mode)) {
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
    const meta: SessionMeta = {
      id: rec.id,
      title: rec.title,
      projectPath: rec.projectPath,
      mode: normalizeMode(rec.mode),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      messageCount: rec.messages.length,
    };
    if (isThinkingLevel(rec.thinkingLevel)) meta.thinkingLevel = rec.thinkingLevel;
    if (rec.forkedFrom) meta.forkedFrom = rec.forkedFrom;
    return meta;
  }

  private toSession(rec: SessionRecord): Session {
    return { ...this.toMeta(rec), messages: rec.messages };
  }
}

/** Coerce a persisted mode to the current union (older records lack `mode`). */
function normalizeMode(value: unknown): SessionMode {
  return value === "plan" || value === "goal" ? value : "build";
}
