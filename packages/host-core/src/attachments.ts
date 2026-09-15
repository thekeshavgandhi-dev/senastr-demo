import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCodes, RpcError, type MessageAttachment } from "@senastr/shared";

interface AttachmentMeta {
  id: string;
  sessionId: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  bytes: number;
  createdAt: number;
  /** Inline text (large pastes) kept in the metadata file itself. */
  text?: string;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Attachment store (parity: pi-desktop prompt attachments).
 *
 * Images and files the user attaches to a prompt are copied under
 * `<data>/attachments/<sessionId>/` so the transcript only ever carries a
 * `storeId`. The provider adapters hydrate the bytes on demand, which keeps
 * session files small and keeps base64 out of every renderer payload.
 */
export class AttachmentService {
  private readonly base: string;

  constructor(dataDir: string) {
    this.base = join(dataDir, "attachments");
  }

  private sessionDir(sessionId: string): string {
    if (!isSafeId(sessionId)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "invalid session id");
    return join(this.base, sessionId);
  }

  private binPath(sessionId: string, id: string): string {
    return join(this.sessionDir(sessionId), `${id}.bin`);
  }

  private metaPath(sessionId: string, id: string): string {
    return join(this.sessionDir(sessionId), `${id}.json`);
  }

  add(input: {
    sessionId: string;
    kind: "image" | "file";
    name: string;
    mimeType: string;
    dataBase64?: string;
    path?: string;
    text?: string;
  }): MessageAttachment {
    const sessionId = requireId(input?.sessionId, "sessionId");
    const kind = input.kind === "image" ? "image" : "file";
    const id = randomUUID();
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });

    let bytes = 0;
    let mimeType = input.mimeType || "application/octet-stream";
    if (typeof input.dataBase64 === "string" && input.dataBase64.length > 0) {
      const data = Buffer.from(stripDataUrl(input.dataBase64), "base64");
      if (kind === "image" && data.byteLength > MAX_IMAGE_BYTES) {
        throw new RpcError(
          ErrorCodes.INVALID_PARAMS,
          `image is too large (${(data.byteLength / 1024 / 1024).toFixed(1)} MB, max 12 MB)`,
        );
      }
      bytes = data.byteLength;
      writeFileSync(this.binPath(sessionId, id), data);
    } else if (typeof input.path === "string" && input.path) {
      // A file reference from inside the project: keep the path, do not copy.
      const meta: AttachmentMeta = {
        id,
        sessionId,
        kind,
        name: input.name || input.path.split(/[\\/]/).pop() || "file",
        mimeType,
        bytes: 0,
        createdAt: Date.now(),
      };
      writeFileSync(this.metaPath(sessionId, id), JSON.stringify(meta, null, 2), "utf8");
      return { id, kind, name: meta.name, mimeType, storeId: `${sessionId}/${id}`, path: input.path };
    } else if (typeof input.text === "string") {
      bytes = Buffer.byteLength(input.text, "utf8");
      mimeType = mimeType || "text/plain";
    } else {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "attachment needs data, a path or text");
    }

    const meta: AttachmentMeta = {
      id,
      sessionId,
      kind,
      name: input.name || (kind === "image" ? "image" : "attachment"),
      mimeType,
      bytes,
      createdAt: Date.now(),
      ...(typeof input.text === "string" ? { text: input.text } : {}),
    };
    writeFileSync(this.metaPath(sessionId, id), JSON.stringify(meta, null, 2), "utf8");
    return {
      id,
      kind,
      name: meta.name,
      mimeType,
      bytes,
      storeId: `${sessionId}/${id}`,
      ...(typeof input.text === "string" ? { text: input.text } : {}),
    };
  }

  /** Raw bytes for the model request path (images). */
  read(storeId: string): { mimeType: string; base64: string; name: string } {
    const { sessionId, id } = splitStoreId(storeId);
    const meta = this.readMeta(sessionId, id);
    const bin = this.binPath(sessionId, id);
    if (!existsSync(bin)) {
      throw new RpcError(ErrorCodes.HOST_ERROR, `attachment data is missing: ${storeId}`);
    }
    return { mimeType: meta.mimeType, base64: readFileSync(bin).toString("base64"), name: meta.name };
  }

  meta(storeId: string): AttachmentMeta {
    const { sessionId, id } = splitStoreId(storeId);
    return this.readMeta(sessionId, id);
  }

  /** Text payload of a large paste (no binary file involved). */
  text(storeId: string): string {
    const meta = this.meta(storeId);
    return meta.text ?? "";
  }

  delete(storeId: string): void {
    let parsed: { sessionId: string; id: string };
    try {
      parsed = splitStoreId(storeId);
    } catch {
      return;
    }
    for (const path of [this.binPath(parsed.sessionId, parsed.id), this.metaPath(parsed.sessionId, parsed.id)]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  purgeSession(sessionId: string): void {
    if (!isSafeId(sessionId)) return;
    try {
      rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  private readMeta(sessionId: string, id: string): AttachmentMeta {
    try {
      return JSON.parse(readFileSync(this.metaPath(sessionId, id), "utf8")) as AttachmentMeta;
    } catch {
      throw new RpcError(ErrorCodes.HOST_ERROR, `attachment not found: ${sessionId}/${id}`);
    }
  }
}

function splitStoreId(storeId: unknown): { sessionId: string; id: string } {
  const value = typeof storeId === "string" ? storeId.trim() : "";
  const [sessionId, id] = value.split("/");
  if (!isSafeId(sessionId) || !isSafeId(id)) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "invalid attachment id");
  }
  return { sessionId, id };
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

function requireId(value: unknown, field: string): string {
  if (!isSafeId(value)) throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} is required`);
  return value as string;
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
}
