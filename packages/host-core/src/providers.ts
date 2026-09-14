import { join } from "node:path";
import {
  ErrorCodes,
  SECRET_MASK,
  RpcError,
  type ProviderApiStyle,
  type ProviderConfig,
  type ProviderDiscoveryInput,
  type ProviderKind,
  type ProviderSummary,
  type ProviderTestResult,
} from "@senastr/shared";
import { SecretBox, isEncryptedValue } from "./secrets";
import { JsonFileStore } from "./store";

const TEST_TIMEOUT_MS = 10_000;
const MAX_MODELS = 500;
/** Back-compat alias; the canonical constant lives in @senastr/shared. */
export const MASKED_PROVIDER_SECRET = SECRET_MASK;
const MAX_KEYS = 16;
const MAX_RATE_LIMIT_PER_MIN = 100_000;
const RESERVED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "host",
  "content-length",
  "cookie",
  "set-cookie",
  "connection",
]);

/**
 * Model provider registry. Credentials live only in the host-core data dir
 * and never cross to the renderer except as `hasApiKey` flags (ADR 0004).
 */
export class ProviderStore {
  private store: JsonFileStore<ProviderConfig[]>;
  private readonly secrets: SecretBox;

  constructor(dataDir: string, secrets?: SecretBox) {
    this.secrets = secrets ?? new SecretBox(dataDir);
    this.store = new JsonFileStore<ProviderConfig[]>(join(dataDir, "providers.json"), []);
    this.migratePlaintextSecrets();
  }

  /** Re-encrypt credentials written by older builds (or pasted keys). */
  private migratePlaintextSecrets(): void {
    const stored = this.store.get();
    let changed = false;
    const migrated = stored.map((provider) => {
      const needsKeys = [provider.apiKey, ...(provider.apiKeys ?? [])].some(
        (key) => typeof key === "string" && key.length > 0 && !isEncryptedValue(key),
      );
      const needsHeaders = this.secrets.mapNeedsEncryption(provider.headers);
      if (!needsKeys && !needsHeaders) return provider;
      changed = true;
      return this.protect(provider, { keys: needsKeys, headers: needsHeaders });
    });
    if (changed) this.store.update(() => migrated);
  }

  /** Encrypt the credential fields of a provider record before persisting. */
  private protect(cfg: ProviderConfig, only?: { keys?: boolean; headers?: boolean }): ProviderConfig {
    const encryptKeys = only?.keys ?? true;
    const encryptHeaders = only?.headers ?? true;
    const keys = encryptKeys
      ? {
          apiKey: typeof cfg.apiKey === "string" && cfg.apiKey ? this.secrets.encrypt(cfg.apiKey) : cfg.apiKey,
          apiKeys: cfg.apiKeys?.map((key) => (key ? this.secrets.encrypt(key) : key)),
        }
      : { apiKey: cfg.apiKey, apiKeys: cfg.apiKeys };
    return {
      ...cfg,
      ...keys,
      headers: encryptHeaders ? this.secrets.encryptMap(cfg.headers) : cfg.headers,
    };
  }

  /** Decrypt the credential fields of a stored record for internal use. */
  private reveal(cfg: ProviderConfig): ProviderConfig {
    return {
      ...cfg,
      apiKey: typeof cfg.apiKey === "string" ? this.secrets.decrypt(cfg.apiKey) : cfg.apiKey,
      apiKeys: cfg.apiKeys?.map((key) => (isEncryptedValue(key) ? this.secrets.decrypt(key) : key)),
      headers: this.secrets.decryptMap(cfg.headers),
    };
  }

  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  list(): ProviderSummary[] {
    return this.store.get().map((provider) => maskProvider(this.reveal(provider)));
  }

  get(id: string): ProviderConfig {
    const found = this.store.get().find((p) => p.id === id);
    if (!found) throw new RpcError(ErrorCodes.PROVIDER_NOT_FOUND, `provider not found: ${id}`);
    return normalizeStoredProvider(this.reveal(found));
  }

  set(config: ProviderConfig): ProviderSummary {
    const stored = this.store.get().find((provider) => provider.id === config?.id);
    const existing = stored ? this.reveal(stored) : undefined;
    // Omitted or masked values in an edit mean "keep the stored secret". Do
    // the merge in host-core so credentials never need to return to a client.
    const merged = existing
      ? {
          ...config,
          apiKeys: mergeKeyPool(config.apiKeys, config.apiKey, existing),
          headers: mergeMaskedHeaders(config.headers, existing.headers),
        }
      : { ...config, apiKeys: mergeKeyPool(config.apiKeys, config.apiKey, undefined) };
    const cfg = validateProvider(merged);
    const persisted = this.protect(cfg);
    this.store.update((all) => {
      const idx = all.findIndex((p) => p.id === cfg.id);
      if (idx >= 0) {
        const next = [...all];
        next[idx] = persisted;
        return next;
      }
      return [...all, persisted];
    });
    return maskProvider(cfg);
  }

  delete(id: string): void {
    const exists = this.store.get().some((p) => p.id === id);
    if (!exists) throw new RpcError(ErrorCodes.PROVIDER_NOT_FOUND, `provider not found: ${id}`);
    this.store.update((all) => all.filter((p) => p.id !== id));
  }

  /** Discover models from an unsaved setup-dialog connection. */
  async discover(input: ProviderDiscoveryInput): Promise<ProviderTestResult> {
    const stored = input?.id ? this.store.get().find((provider) => provider.id === input.id) : undefined;
    const existing = stored ? this.reveal(stored) : undefined;
    const draft = existing
      ? {
          ...input,
          apiKeys: mergeKeyPool(input.apiKeys, input.apiKey, existing),
          headers: mergeMaskedHeaders(input.headers, existing.headers),
        }
      : { ...input, apiKeys: mergeKeyPool(input.apiKeys, input.apiKey, undefined) };
    const normalized = normalizeDiscoveryInput(draft);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const request = modelListRequest(normalized);
      const res = await fetch(request.url, { headers: request.headers, signal: controller.signal });
      if (!res.ok) {
        return { ok: false, detail: friendlyHttpError(res.status, res.statusText) };
      }
      const body = await res.json();
      const models = normalizeModelList(normalized.apiStyle, body);
      return {
        ok: true,
        detail: models.length
          ? `connected — ${models.length} model${models.length === 1 ? "" : "s"} reported`
          : "connected — the endpoint returned no models",
        models,
      };
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${TEST_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
      return { ok: false, detail: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best-effort connectivity probe against the endpoint's model list. */
  async test(id: string): Promise<ProviderTestResult> {
    const cfg = this.get(id);
    return this.discover(cfg);
  }
}

export function defaultApiStyle(kind: ProviderKind): ProviderApiStyle {
  if (kind === "anthropic") return "anthropic_messages";
  if (kind === "google") return "google_generative_ai";
  return "chat_completions";
}

export function defaultBaseUrl(kind: ProviderKind): string {
  if (kind === "anthropic") return "https://api.anthropic.com";
  if (kind === "google") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com/v1";
}

export function effectiveApiKeys(cfg: Pick<ProviderConfig, "apiKey" | "apiKeys">): string[] {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length) return cfg.apiKeys;
  return cfg.apiKey ? [cfg.apiKey] : [];
}

export function maskProvider(cfg: ProviderConfig): ProviderSummary {
  const normalized = normalizeStoredProvider(cfg);
  const keys = effectiveApiKeys(normalized);
  return {
    id: normalized.id,
    kind: normalized.kind,
    vendorKey: normalized.vendorKey,
    label: normalized.label,
    baseUrl: normalized.baseUrl,
    hasApiKey: keys.length > 0,
    apiKeyCount: keys.length,
    apiStyle: normalized.apiStyle ?? defaultApiStyle(normalized.kind),
    headers: normalized.headers
      ? Object.fromEntries(Object.keys(normalized.headers).map((name) => [name, MASKED_PROVIDER_SECRET]))
      : undefined,
    rateLimitPerMin: normalized.rateLimitPerMin,
    models: normalized.models,
    defaultModel: normalized.defaultModel,
    enabled: normalized.enabled !== false,
  };
}

function normalizeStoredProvider(cfg: ProviderConfig): ProviderConfig {
  return {
    ...cfg,
    enabled: cfg.enabled !== false,
    apiStyle: cfg.apiStyle ?? defaultApiStyle(cfg.kind),
    rateLimitPerMin: normalizeRateLimit(cfg.rateLimitPerMin),
  };
}

/**
 * Merge an edited key pool against the stored one. Entries equal to the
 * secret mask consume the next still-unused stored key (in stored order);
 * anything else is taken literally. When the edit carries no key material at
 * all, the stored pool is kept unchanged. Credentials never leave host-core.
 */
function mergeKeyPool(
  next: string[] | undefined,
  legacyApiKey: string | undefined,
  existing: ProviderConfig | undefined,
): string[] {
  const pool = existing ? [...effectiveApiKeys(existing)] : [];
  let cursor = 0;
  let resolved: string[];
  if (Array.isArray(next)) {
    resolved = next.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const value = entry.trim();
      if (!value) return [];
      if (value === SECRET_MASK) {
        const stored = pool[cursor];
        if (stored === undefined) return []; // mask with nothing left to keep
        cursor += 1;
        return [stored];
      }
      return [value];
    });
  } else if (legacyApiKey && legacyApiKey.trim() && legacyApiKey !== SECRET_MASK) {
    resolved = [legacyApiKey.trim()];
  } else {
    resolved = [...pool];
  }
  return [...new Set(resolved)].slice(0, MAX_KEYS);
}

function normalizeRateLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 1 ? Math.min(n, MAX_RATE_LIMIT_PER_MIN) : undefined;
}

export function validateProvider(cfg: unknown): ProviderConfig {
  const c = cfg as ProviderConfig;
  if (!c || typeof c.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(c.id)) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider.id must be a slug (a-z, 0-9, -, _)");
  }
  if (c.kind !== "openai" && c.kind !== "anthropic" && c.kind !== "google") {
    throw new RpcError(
      ErrorCodes.INVALID_PARAMS,
      `provider.kind must be "openai", "anthropic", or "google", got: ${String(c.kind)}`,
    );
  }
  if (typeof c.label !== "string" || !c.label.trim()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider.label is required");
  }
  if (!Array.isArray(c.models) || c.models.some((m) => typeof m !== "string")) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider.models must be an array of model ids");
  }
  const models = [...new Set(c.models.map((model) => model.trim()).filter(Boolean))];
  if (models.length === 0) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "select or add at least one model");
  }
  const apiStyle = normalizeApiStyle(c.apiStyle, c.kind);
  const baseUrl = typeof c.baseUrl === "string" && c.baseUrl.trim() ? c.baseUrl.trim().replace(/\/+$/, "") : undefined;
  if (baseUrl) validateUrl(baseUrl, "provider.baseUrl");
  const headers = sanitizeHeaders(c.headers);
  const rawKeys = Array.isArray(c.apiKeys) ? c.apiKeys : typeof c.apiKey === "string" ? [c.apiKey] : [];
  const apiKeys = [
    ...new Set(
      rawKeys
        .map((key) => (typeof key === "string" ? key.trim() : ""))
        .filter((key) => key.length > 0 && key !== SECRET_MASK),
    ),
  ].slice(0, MAX_KEYS);
  return {
    id: c.id,
    kind: c.kind,
    vendorKey: typeof c.vendorKey === "string" && c.vendorKey.trim() ? c.vendorKey.trim() : undefined,
    label: c.label.trim(),
    baseUrl,
    apiKey: apiKeys[0],
    apiKeys,
    apiStyle,
    headers: Object.keys(headers).length ? headers : undefined,
    rateLimitPerMin: normalizeRateLimit(c.rateLimitPerMin),
    models,
    defaultModel:
      typeof c.defaultModel === "string" && models.includes(c.defaultModel.trim())
        ? c.defaultModel.trim()
        : models[0],
    enabled: c.enabled !== false,
  };
}

function normalizeDiscoveryInput(input: ProviderDiscoveryInput & { apiKeys?: string[] }): Required<Pick<ProviderDiscoveryInput, "kind" | "apiStyle">> & ProviderDiscoveryInput {
  const kind = input?.kind;
  if (kind !== "openai" && kind !== "anthropic" && kind !== "google") {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "a valid provider kind is required");
  }
  const baseUrl = (input.baseUrl?.trim() || defaultBaseUrl(kind)).replace(/\/+$/, "");
  validateUrl(baseUrl, "base URL");
  const pool = Array.isArray(input.apiKeys) && input.apiKeys.length ? input.apiKeys : input.apiKey ? [input.apiKey] : [];
  return {
    kind,
    baseUrl,
    apiKey: pool[0]?.trim() || undefined,
    apiStyle: normalizeApiStyle(input.apiStyle, kind),
    headers: sanitizeHeaders(input.headers),
  };
}

function normalizeApiStyle(value: ProviderApiStyle | undefined, kind: ProviderKind): ProviderApiStyle {
  const style = value ?? defaultApiStyle(kind);
  const valid: ProviderApiStyle[] = [
    "chat_completions",
    "responses",
    "anthropic_messages",
    "google_generative_ai",
  ];
  if (!valid.includes(style)) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `unsupported API format: ${String(style)}`);
  }
  return style;
}

function validateUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${label} must be a valid URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${label} must be an HTTP(S) URL without embedded credentials`);
  }
}

function mergeMaskedHeaders(
  next: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!next) return next;
  const merged = Object.fromEntries(
    Object.entries(next).flatMap(([name, value]) => {
      if (value !== MASKED_PROVIDER_SECRET) return [[name, value]];
      return previous?.[name] === undefined ? [] : [[name, previous[name]]];
    }),
  );
  return merged;
}

export function sanitizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    const headerValue = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!name || !headerValue) continue;
    if (name.includes("\r") || name.includes("\n") || headerValue.includes("\r") || headerValue.includes("\n")) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider headers cannot contain line breaks");
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `provider header is managed by senastr: ${name}`);
    }
    out[name] = headerValue;
  }
  return out;
}

function authHeaders(input: ProviderDiscoveryInput & { kind: ProviderKind; apiStyle: ProviderApiStyle }): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input.apiStyle === "anthropic_messages") {
    if (input.apiKey) headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (input.apiStyle !== "google_generative_ai" && input.apiKey) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }
  return { ...headers, ...sanitizeHeaders(input.headers) };
}

export function modelListRequest(input: ProviderDiscoveryInput & { kind: ProviderKind; apiStyle: ProviderApiStyle }): {
  url: string;
  headers: Record<string, string>;
} {
  const base = (input.baseUrl || defaultBaseUrl(input.kind)).replace(/\/+$/, "");
  if (input.apiStyle === "google_generative_ai") {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (input.apiKey) params.set("key", input.apiKey);
    return { url: `${base}/models?${params.toString()}`, headers: authHeaders(input) };
  }
  if (input.apiStyle === "anthropic_messages") {
    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    return { url: `${root}/models?limit=1000`, headers: authHeaders(input) };
  }
  return { url: `${base}/models`, headers: authHeaders(input) };
}

export function normalizeModelList(style: ProviderApiStyle, value: unknown): string[] {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const rows = style === "google_generative_ai"
    ? (Array.isArray(record.models) ? record.models : [])
    : (Array.isArray(record.data) ? record.data : Array.isArray(value) ? value : []);
  const ids = rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const item = row as Record<string, unknown>;
    const raw = style === "google_generative_ai" ? item.name : item.id;
    if (typeof raw !== "string" || !raw.trim()) return [];
    return [style === "google_generative_ai" ? raw.replace(/^models\//, "") : raw.trim()];
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).slice(0, MAX_MODELS);
}

function friendlyHttpError(status: number, statusText: string): string {
  if (status === 401 || status === 403) return `authentication failed (HTTP ${status})`;
  if (status === 404) return "model-list endpoint not found (HTTP 404)";
  if (status === 429) return "provider rate limit reached (HTTP 429)";
  return `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
}
