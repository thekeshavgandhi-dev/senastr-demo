import { join } from "node:path";
import {
  ErrorCodes,
  RpcError,
  type ProviderConfig,
  type ProviderSummary,
  type ProviderTestResult,
} from "@senastr/shared";
import { JsonFileStore } from "./store";

const TEST_TIMEOUT_MS = 10_000;

/**
 * Model provider registry. Credentials live only in the host-core data dir
 * and never cross to the renderer except as `hasApiKey` flags (ADR 0004).
 */
export class ProviderStore {
  private store: JsonFileStore<ProviderConfig[]>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore<ProviderConfig[]>(join(dataDir, "providers.json"), []);
  }

  list(): ProviderSummary[] {
    return this.store.get().map(maskProvider);
  }

  get(id: string): ProviderConfig {
    const found = this.store.get().find((p) => p.id === id);
    if (!found) throw new RpcError(ErrorCodes.PROVIDER_NOT_FOUND, `provider not found: ${id}`);
    return found;
  }

  set(config: ProviderConfig): ProviderSummary {
    const cfg = validateProvider(config);
    this.store.update((all) => {
      const idx = all.findIndex((p) => p.id === cfg.id);
      if (idx >= 0) {
        const next = [...all];
        next[idx] = cfg;
        return next;
      }
      return [...all, cfg];
    });
    return maskProvider(cfg);
  }

  delete(id: string): void {
    const exists = this.store.get().some((p) => p.id === id);
    if (!exists) throw new RpcError(ErrorCodes.PROVIDER_NOT_FOUND, `provider not found: ${id}`);
    this.store.update((all) => all.filter((p) => p.id !== id));
  }

  /** Best-effort connectivity probe against the endpoint's model list. */
  async test(id: string): Promise<ProviderTestResult> {
    const cfg = this.get(id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      if (cfg.kind === "openai") {
        const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const res = await fetch(`${base}/models`, {
          headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
          signal: controller.signal,
        });
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}`.trim() };
        const data: any = await res.json();
        const models = Array.isArray(data?.data)
          ? data.data.map((m: any) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)
          : [];
        return { ok: true, detail: `connected — ${models.length} models reported`, models: models.slice(0, 500) };
      }
      const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/models`, {
        headers: {
          "x-api-key": cfg.apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}`.trim() };
      const data: any = await res.json();
      const models = Array.isArray(data?.data)
        ? data.data.map((m: any) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)
        : [];
      return { ok: true, detail: `connected — ${models.length} models reported`, models: models.slice(0, 500) };
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${TEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      return { ok: false, detail: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function maskProvider(cfg: ProviderConfig): ProviderSummary {
  return {
    id: cfg.id,
    kind: cfg.kind,
    label: cfg.label,
    baseUrl: cfg.baseUrl,
    hasApiKey: Boolean(cfg.apiKey),
    models: cfg.models,
    defaultModel: cfg.defaultModel,
  };
}

export function validateProvider(cfg: unknown): ProviderConfig {
  const c = cfg as ProviderConfig;
  if (!c || typeof c.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(c.id)) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider.id must be a slug (a-z, 0-9, -, _)");
  }
  if (c.kind !== "openai" && c.kind !== "anthropic") {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `provider.kind must be "openai" or "anthropic", got: ${String(c.kind)}`);
  }
  if (typeof c.label !== "string" || !c.label.trim()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider.label is required");
  }
  if (!Array.isArray(c.models) || c.models.some((m) => typeof m !== "string")) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider.models must be an array of model ids");
  }
  return {
    id: c.id,
    kind: c.kind,
    label: c.label.trim(),
    baseUrl: typeof c.baseUrl === "string" && c.baseUrl.trim() ? c.baseUrl.trim() : undefined,
    apiKey: typeof c.apiKey === "string" && c.apiKey.trim() ? c.apiKey.trim() : undefined,
    models: c.models,
    defaultModel: typeof c.defaultModel === "string" ? c.defaultModel : c.models[0],
  };
}
