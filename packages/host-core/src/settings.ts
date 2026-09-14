import { normalizeNetworkProxy, type AppSettings, type NetworkProxySettings } from "@senastr/shared";
import { JsonFileStore } from "./store";

/**
 * Host-owned application settings (parity: pi-desktop `settings/get` +
 * `settings/set`, `network/testProxy`).
 *
 * Renderer-local preferences (theme, layout, drafts) stay in localStorage;
 * everything a headless client must also honour lives here.
 */
export class SettingsService {
  private readonly store: JsonFileStore<AppSettings>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore<AppSettings>(`${dataDir}/settings.json`, {});
    this.store.update((state) => normalizeSettings(state));
  }

  get(): AppSettings {
    return normalizeSettings(this.store.get());
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const next: AppSettings = {
      ...current,
      ...patch,
      proxy: patch.proxy !== undefined ? normalizeNetworkProxy(patch.proxy) : current.proxy,
      updates:
        patch.updates !== undefined ? { ...current.updates, ...patch.updates } : current.updates,
    };
    this.store.set(normalizeSettings(next));
    return this.get();
  }

  /** The effective proxy configuration for outbound model + MCP requests. */
  proxy(): NetworkProxySettings {
    return normalizeNetworkProxy(this.get().proxy);
  }

  language(): string {
    return this.get().language ?? "en";
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}

function normalizeSettings(value: unknown): AppSettings {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as AppSettings) : {};
  const out: AppSettings = {};
  if (typeof record.language === "string" && record.language.trim()) out.language = record.language.trim();
  if (record.proxy !== undefined) out.proxy = normalizeNetworkProxy(record.proxy);
  if (record.updates && typeof record.updates === "object") {
    out.updates = {
      autoCheck: record.updates.autoCheck !== false,
      channel: typeof record.updates.channel === "string" ? record.updates.channel : undefined,
    };
  }
  if (typeof record.commandShell === "string") out.commandShell = record.commandShell;
  if (typeof record.maxSteps === "number" && Number.isFinite(record.maxSteps)) {
    out.maxSteps = Math.max(1, Math.min(Math.floor(record.maxSteps), 200));
  }
  return out;
}
