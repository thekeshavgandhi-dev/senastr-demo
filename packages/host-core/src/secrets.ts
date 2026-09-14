import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Secret-at-rest protection for credentials the host owns (provider API keys,
 * custom headers, MCP env/header values).
 *
 * Key source, in order:
 *   1. `SENASTR_SECRET_KEY` — injected by the desktop from the OS keychain via
 *      Electron `safeStorage`, so the file on disk is useless without the OS
 *      user context. Accepts base64 (any length; hashed to 32 bytes).
 *   2. `<dataDir>/secret.key` — a 32-byte key generated on first use and
 *      written with mode 0600. Used by the standalone sidecar and by desktop
 *      builds where the OS keychain is unavailable.
 *
 * Payload format: `enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>` (AES-256-GCM).
 * Values without the prefix are legacy plaintext: they are read as-is and
 * re-encrypted the next time the record is written.
 */
export const SECRET_PREFIX = "enc:v1:";
export const KEY_FILE = "secret.key";

export function isEncryptedValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(SECRET_PREFIX);
}

function deriveKey(material: Buffer): Buffer {
  // Exactly 32 bytes for AES-256; any provided material is strengthened by a
  // domain-separated hash rather than truncated.
  return createHash("sha256").update(material).digest();
}

export function loadOrCreateKey(dataDir: string): Buffer {
  const injected = process.env.SENASTR_SECRET_KEY;
  if (injected && injected.trim()) {
    return deriveKey(Buffer.from(injected.trim(), "utf8"));
  }
  const keyPath = join(dataDir, KEY_FILE);
  if (existsSync(keyPath)) {
    try {
      const raw = readFileSync(keyPath, "utf8").trim();
      if (raw) return deriveKey(Buffer.from(raw, "base64"));
    } catch {
      // Unreadable key file — fall through and mint a new one.
    }
  }
  // The file holds the raw random material; the AES key is its hash so both
  // the create and the read path derive the same 32 bytes.
  const raw = randomBytes(32);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(keyPath, `${raw.toString("base64")}\n`, { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // best effort on platforms without POSIX modes
    }
  } catch {
    // A read-only data dir still works for this process; the key just is not
    // persisted, which means credentials cannot be stored either.
  }
  return deriveKey(raw);
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(dataDir: string) {
    this.key = loadOrCreateKey(dataDir);
  }

  /** Encrypt a secret. Idempotent: already-encrypted values pass through. */
  encrypt(value: string): string {
    if (isEncryptedValue(value)) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${SECRET_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
  }

  /** Decrypt a secret. Plaintext (legacy) values pass through unchanged. */
  decrypt(value: string): string {
    if (!isEncryptedValue(value)) return value;
    const body = value.slice(SECRET_PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split(":");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("corrupt encrypted secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  }

  /** Encrypt every string value of a map (env vars, headers). */
  encryptMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!map) return undefined;
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, this.encrypt(String(v))]));
  }

  decryptMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!map) return undefined;
    return Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, isEncryptedValue(v) ? this.decrypt(String(v)) : String(v)]),
    );
  }

  /** True when any value in the map still needs encryption. */
  mapNeedsEncryption(map: Record<string, string> | undefined): boolean {
    if (!map) return false;
    return Object.values(map).some((v) => !isEncryptedValue(v));
  }
}
