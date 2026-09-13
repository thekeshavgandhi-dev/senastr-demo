import { useMemo, useState } from "react";
import {
  SECRET_MASK,
  type ProviderApiStyle,
  type ProviderConfig,
  type ProviderKind,
  type ProviderSummary,
} from "@senastr/shared";
import { PROVIDER_PRESETS, matchProviderPreset } from "@senastr/provider-presets";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import {
  EmptyState,
  Field,
  IconButton,
  KeyValueEditor,
  Modal,
  Toggle,
  pairsToRecord,
  recordToPairs,
  type KeyValuePair,
} from "./SettingsPrimitives";

const CUSTOM_SERVICE = "custom";

/** One row of the API key pool. Stored keys are masked; new keys keep their
 * real value locally until the provider is saved (host-core never sees the
 * mask resolved — it does that itself). */
interface KeyRow {
  value: string;
  stored: boolean;
}

export function ModelsSettings({ store }: { store: SenastrStore }) {
  const [setup, setSetup] = useState<ProviderSummary | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const enabledProviders = store.providers.filter((provider) => provider.enabled);
  const modelOptions = enabledProviders.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const current = modelOptions.find(
    ({ provider, model }) => provider.id === store.modelRef?.providerId && model === store.modelRef.model,
  );

  const test = async (provider: ProviderSummary) => {
    setBusy(`test:${provider.id}`);
    try {
      const result = await api.provider.test(provider.id);
      store.pushNotice(result.detail, result.ok ? "info" : "error");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (provider: ProviderSummary) => {
    setBusy(provider.id);
    try {
      await api.provider.set(summaryToConfig(provider, { enabled: !provider.enabled }));
      if (provider.enabled && store.modelRef?.providerId === provider.id) store.setModelRef(null);
      await store.refresh();
      store.pushNotice(`${provider.label} ${provider.enabled ? "disabled" : "enabled"}`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (provider: ProviderSummary) => {
    if (confirmDelete !== provider.id) {
      setConfirmDelete(provider.id);
      window.setTimeout(() => setConfirmDelete((id) => (id === provider.id ? null : id)), 3200);
      return;
    }
    setBusy(provider.id);
    try {
      await api.provider.delete(provider.id);
      if (store.modelRef?.providerId === provider.id) store.setModelRef(null);
      await store.refresh();
      store.pushNotice(`${provider.label} removed`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  return (
    <div className="settings-page-stack model-settings-page">
      <section className="settings-block">
        <div className="settings-block-heading"><h2>Defaults</h2></div>
        <div className="settings-card settings-default-card">
          <div>
            <strong>Default model</strong>
            <span>{current ? `${current.provider.label} · ${current.model}` : "No default selected"}</span>
          </div>
          <select
            aria-label="Default model"
            value={current ? JSON.stringify([current.provider.id, current.model]) : ""}
            disabled={!modelOptions.length}
            onChange={(event) => {
              const [providerId, model] = JSON.parse(event.target.value || "[null,null]") as [string | null, string | null];
              store.setModelRef(providerId && model ? { providerId, model } : null);
              store.pushNotice("Default model updated", "info");
            }}
          >
            <option value="">Choose model…</option>
            {enabledProviders.map((provider) => (
              <optgroup key={provider.id} label={provider.label}>
                {provider.models.map((model) => (
                  <option key={model} value={JSON.stringify([provider.id, model])}>{model}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </section>

      <section className="settings-block">
        <div className="settings-block-heading">
          <div className="heading-with-count"><h2>AI providers</h2><span>{store.providers.length}</span></div>
          <button className="settings-primary-btn" type="button" onClick={() => setSetup("new")}>
            <SettingsIcon name="plus" size={14} /> Add provider
          </button>
        </div>
        <div className="settings-card provider-list-card">
          {!store.providers.length ? (
            <EmptyState
              icon="sparkles"
              title="Bring your own model"
              description="Connect a hosted AI service, local Ollama, LM Studio, or any compatible endpoint."
              action={<button type="button" className="settings-primary-btn" onClick={() => setSetup("new")}><SettingsIcon name="plus" size={14} /> Add provider</button>}
            />
          ) : (
            store.providers.map((provider) => {
              const isDefault = current?.provider.id === provider.id;
              const rowBusy = busy === provider.id || busy === `test:${provider.id}`;
              return (
                <div className={`provider-settings-row ${provider.enabled ? "" : "off"}`} key={provider.id}>
                  <div className="provider-avatar">{provider.label.slice(0, 1).toUpperCase()}</div>
                  <div className="provider-row-copy">
                    <div className="provider-row-title">
                      <strong>{provider.label}</strong>
                      {isDefault ? <span className="settings-badge success">Default</span> : null}
                      {!provider.hasApiKey && !isLocalProvider(provider) ? <span className="settings-badge warning">No key</span> : null}
                      {!provider.enabled ? <span className="settings-badge">Off</span> : null}
                    </div>
                    <div className="provider-row-meta">
                      <span>{hostLabel(provider.baseUrl)}</span><b>·</b>
                      <span>{provider.models.length} model{provider.models.length === 1 ? "" : "s"}</span><b>·</b>
                      <span>{apiStyleLabel(provider.apiStyle)}</span>
                      {(provider.apiKeyCount ?? 0) > 1 ? <><b>·</b><span>{provider.apiKeyCount} keys</span></> : null}
                      {provider.rateLimitPerMin ? <><b>·</b><span>≤ {provider.rateLimitPerMin} req/min</span></> : null}
                    </div>
                  </div>
                  <div className="provider-row-actions">
                    {!isDefault && provider.enabled ? (
                      <button type="button" className="settings-ghost-btn compact" onClick={() => {
                        const model = provider.defaultModel ?? provider.models[0];
                        if (model) store.setModelRef({ providerId: provider.id, model });
                      }}>Make default</button>
                    ) : null}
                    <IconButton icon="edit" label="Edit provider" disabled={rowBusy} onClick={() => setSetup(provider)} />
                    <IconButton icon={busy === `test:${provider.id}` ? "refresh" : "test"} label="Test connection" disabled={rowBusy} onClick={() => void test(provider)} />
                    {confirmDelete === provider.id ? (
                      <button type="button" className="settings-confirm-delete" disabled={rowBusy} onClick={() => void remove(provider)}>Delete?</button>
                    ) : (
                      <IconButton icon="trash" label="Delete provider" danger disabled={rowBusy} onClick={() => void remove(provider)} />
                    )}
                    <Toggle checked={provider.enabled} disabled={rowBusy} label={`${provider.enabled ? "Disable" : "Enable"} ${provider.label}`} onChange={() => void toggle(provider)} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <div className="model-catalog-note">
        <span><SettingsIcon name="refresh" size={14} /> Model lists come directly from each provider</span>
        <span>Live discovery · custom model IDs supported</span>
      </div>

      {setup ? (
        <ProviderSetupModal
          provider={setup === "new" ? null : setup}
          providers={store.providers}
          onClose={() => setSetup(null)}
          onSaved={async (saved, wasNew) => {
            await store.refresh();
            if (wasNew && saved.models[0]) store.setModelRef({ providerId: saved.id, model: saved.models[0] });
            store.pushNotice(`${saved.label} ${wasNew ? "added" : "updated"}`, "info");
            setSetup(null);
          }}
          onError={(message) => store.pushNotice(message, "error")}
        />
      ) : null}
    </div>
  );
}

function ProviderSetupModal({ provider, providers, onClose, onSaved, onError }: {
  provider: ProviderSummary | null;
  providers: ProviderSummary[];
  onClose: () => void;
  onSaved: (provider: ProviderSummary, wasNew: boolean) => void;
  onError: (message: string) => void;
}) {
  const matched = provider ? matchProviderPreset(provider) : undefined;
  const [service, setService] = useState(matched?.id ?? (provider ? CUSTOM_SERVICE : ""));
  const [serviceSearch, setServiceSearch] = useState("");
  const [name, setName] = useState(provider?.label ?? matched?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? matched?.baseUrl ?? "");
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? "openai");
  const [apiStyle, setApiStyle] = useState<ProviderApiStyle>(provider?.apiStyle ?? "chat_completions");
  const [keyRows, setKeyRows] = useState<KeyRow[]>(() =>
    Array.from({ length: provider?.apiKeyCount ?? (provider?.hasApiKey ? 1 : 0) }, () => ({
      value: SECRET_MASK,
      stored: true,
    })),
  );
  const [keyInput, setKeyInput] = useState("");
  const [rateLimit, setRateLimit] = useState<string>(
    provider?.rateLimitPerMin ? String(provider.rateLimitPerMin) : "",
  );
  const [chosen, setChosen] = useState<string[]>(provider?.models ?? []);
  const [available, setAvailable] = useState<string[]>(provider?.models ?? []);
  const [modelSearch, setModelSearch] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [headers, setHeaders] = useState<KeyValuePair[]>(recordToPairs(provider?.headers));
  const [advanced, setAdvanced] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const selectedPreset = PROVIDER_PRESETS.find((preset) => preset.id === service);
  const filteredServices = PROVIDER_PRESETS.filter((preset) => {
    const query = serviceSearch.trim().toLowerCase();
    return !query || `${preset.name} ${preset.id} ${(preset.aliases ?? []).join(" ")}`.toLowerCase().includes(query);
  });
  const visibleModels = available.filter((model) => model.toLowerCase().includes(modelSearch.trim().toLowerCase()));

  const chooseService = (id: string) => {
    setService(id);
    setStatus(null);
    if (id === CUSTOM_SERVICE) {
      if (!provider) {
        setName("");
        setBaseUrl("");
        setKind("openai");
        setApiStyle("chat_completions");
      }
      return;
    }
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setKind(preset.kind);
    setApiStyle(preset.apiStyle);
    if (!provider) {
      setAvailable([]);
      setChosen([]);
    }
  };

  const fetchModels = async () => {
    if (!baseUrl.trim()) {
      setStatus({ ok: false, text: "Enter a base URL first" });
      return;
    }
    setFetching(true);
    setStatus(null);
    try {
      const result = await api.provider.discoverModels({
        id: provider?.id,
        kind,
        baseUrl: normalizeBaseUrl(baseUrl, apiStyle),
        apiKeys: keyPoolPayload(),
        apiStyle,
        headers: pairsToRecord(headers),
      });
      setStatus({ ok: result.ok, text: result.detail });
      if (result.models?.length) {
        setAvailable(result.models);
        if (!chosen.length) setChosen([result.models[0]]);
      }
    } catch (error) {
      setStatus({ ok: false, text: cleanError(error) });
    } finally {
      setFetching(false);
    }
  };

  const addCustomModel = () => {
    const value = customModel.trim();
    if (!value) return;
    setAvailable((models) => (models.includes(value) ? models : [...models, value]));
    setChosen((models) => (models.includes(value) ? models : [...models, value]));
    setCustomModel("");
  };

  const addKey = () => {
    const value = keyInput.trim();
    if (!value) return;
    setKeyRows((rows) => [...rows, { value, stored: false }]);
    setKeyInput("");
  };

  const removeKeyRow = (index: number) => {
    setKeyRows((rows) => rows.filter((_, i) => i !== index));
  };

  /** Stored rows keep the mask sentinel so host-core resolves them against
   * the keys it already has; new rows are sent as-is. */
  const keyPoolPayload = () => keyRows.map((row) => row.value);

  const save = async () => {
    if (!service) return onError("Choose an AI service");
    if (!name.trim() || !baseUrl.trim()) return onError("Name and base URL are required");
    if (!chosen.length) return onError("Choose or add at least one model");
    setSaving(true);
    try {
      const id = provider?.id ?? uniqueProviderId(slug(name) || "provider", providers);
      const saved = await api.provider.set({
        id,
        kind,
        vendorKey: selectedPreset?.vendorKey ?? "custom",
        label: name.trim(),
        baseUrl: normalizeBaseUrl(baseUrl, apiStyle),
        apiKeys: keyPoolPayload(),
        apiStyle,
        headers: pairsToRecord(headers),
        rateLimitPerMin: parseRateLimit(rateLimit),
        models: chosen,
        defaultModel: chosen[0],
        enabled: provider?.enabled ?? true,
      });
      onSaved(saved, !provider);
    } catch (error) {
      onError(cleanError(error));
      setSaving(false);
    }
  };

  return (
    <Modal
      wide
      title={provider ? "Edit AI provider" : "Add AI provider"}
      subtitle="Connect a service, then choose exactly which models senastr may use."
      onClose={onClose}
      footer={<>
        {status ? <span className={`provider-modal-status ${status.ok ? "ok" : "fail"}`}>{status.text}</span> : <span />}
        <div><button type="button" className="settings-ghost-btn" onClick={onClose}>Cancel</button><button type="button" className="settings-primary-btn" disabled={saving || !service || !chosen.length} onClick={() => void save()}>{saving ? "Saving…" : "Save provider"}</button></div>
      </>}
    >
      <div className="provider-setup-grid">
        <section className="provider-service-column">
          <div className="provider-modal-section-title"><span>1</span> Choose service</div>
          <div className="provider-service-search"><SettingsIcon name="search" size={14} /><input value={serviceSearch} placeholder="Search services" onChange={(event) => setServiceSearch(event.target.value)} /></div>
          <div className="provider-service-options">
            {filteredServices.map((preset) => (
              <button type="button" key={preset.id} disabled={Boolean(provider)} className={service === preset.id ? "selected" : ""} onClick={() => chooseService(preset.id)}>
                <span className="service-monogram">{preset.name.slice(0, 1)}</span><span>{preset.name}</span>{service === preset.id ? <SettingsIcon name="check" size={13} /> : null}
              </button>
            ))}
            <button type="button" disabled={Boolean(provider)} className={service === CUSTOM_SERVICE ? "selected" : ""} onClick={() => chooseService(CUSTOM_SERVICE)}>
              <span className="service-monogram"><SettingsIcon name="globe" size={14} /></span><span>Custom endpoint</span>{service === CUSTOM_SERVICE ? <SettingsIcon name="check" size={13} /> : null}
            </button>
          </div>
          {provider ? <p className="provider-service-locked">Service type is fixed after setup. Connection details remain editable.</p> : null}
        </section>

        <section className="provider-config-column">
          <div className="provider-modal-section-title"><span>2</span> Connection</div>
          {!service ? <div className="provider-step-placeholder"><SettingsIcon name="arrow-left" size={17} /> Pick a service to continue</div> : <>
            <div className="provider-fields-grid">
              <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} /></Field>
              <Field label="Rate limit / min" hint="Client-side throttle across all keys; blank = off"><input type="number" min={1} max={100000} value={rateLimit} placeholder="e.g. 60" onChange={(event) => setRateLimit(event.target.value)} /></Field>
              <Field
                label="API keys"
                wide
                hint={
                  keyRows.length > 1
                    ? "When a key hits its rate limit, senastr switches to the next one automatically"
                    : selectedPreset?.requiresApiKey
                      ? "required by service — add spare keys to ride through rate limits"
                      : "optional — local endpoints need no key"
                }
              >
                <div className="key-pool">
                  {keyRows.map((row, index) => (
                    <div className="key-row" key={index}>
                      <span className="key-index">{index + 1}</span>
                      <code className="key-value">{row.value}</code>
                      {row.stored ? <span className="settings-badge">stored</span> : null}
                      <button type="button" className="key-remove" title={row.stored ? "Delete stored key" : "Remove key"} onClick={() => removeKeyRow(index)}><SettingsIcon name="x" size={13} /></button>
                    </div>
                  ))}
                  <div className="key-add-row">
                    <input
                      type="password"
                      className="mono"
                      value={keyInput}
                      placeholder="Paste an API key (sk-…)"
                      onChange={(event) => setKeyInput(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addKey(); } }}
                    />
                    <button type="button" disabled={!keyInput.trim()} onClick={addKey}>Add key</button>
                  </div>
                </div>
              </Field>
              <Field label="Base URL" wide><input className="mono" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setBaseUrl(event.target.value)} /></Field>
              {service === CUSTOM_SERVICE ? <Field label="API format" wide><select value={apiStyle} onChange={(event) => { const style = event.target.value as ProviderApiStyle; setApiStyle(style); setKind(kindForStyle(style)); }}><option value="chat_completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic_messages">Anthropic Messages</option><option value="google_generative_ai">Google Generative AI</option></select></Field> : null}
            </div>
            <button type="button" className="advanced-disclosure" onClick={() => setAdvanced((open) => !open)}><SettingsIcon name="chevron" className={advanced ? "open" : ""} size={14} /> Advanced headers</button>
            {advanced ? <div className="provider-advanced"><p>Optional routing headers. Authentication headers are managed by senastr.</p><KeyValueEditor pairs={headers} onChange={setHeaders} addLabel="Add header" keyPlaceholder="X-Organization" secret /></div> : null}
          </>}
        </section>
      </div>

      {service ? <section className="provider-model-section">
        <div className="provider-model-heading">
          <div><div className="provider-modal-section-title"><span>3</span> Choose models</div><p>Fetch the provider's live catalog, or add a model ID manually.</p></div>
          <button type="button" className="settings-secondary-btn" disabled={fetching || !baseUrl.trim()} onClick={() => void fetchModels()}><SettingsIcon name="refresh" size={14} className={fetching ? "spin" : ""} /> {fetching ? "Fetching…" : "Fetch models"}</button>
        </div>
        <div className="model-selection-panes">
          <div className="model-pane">
            <div className="model-pane-head"><strong>Service models</strong><span>{available.length}</span></div>
            <div className="model-pane-search"><SettingsIcon name="search" size={13} /><input value={modelSearch} placeholder="Filter models" onChange={(event) => setModelSearch(event.target.value)} /></div>
            <div className="model-pane-list">
              {!available.length ? <div className="model-pane-empty">Fetch the live list or add a custom ID.</div> : visibleModels.map((model) => {
                const active = chosen.includes(model);
                return <button type="button" className={active ? "chosen" : ""} key={model} onClick={() => setChosen((items) => active ? items.filter((item) => item !== model) : [...items, model])}><span className="model-check">{active ? <SettingsIcon name="check" size={12} /> : null}</span><code>{model}</code></button>;
              })}
            </div>
            <div className="custom-model-row"><input className="mono" value={customModel} placeholder="Custom model ID" onChange={(event) => setCustomModel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomModel(); } }} /><button type="button" onClick={addCustomModel}>Add</button></div>
          </div>
          <div className="model-pane chosen-pane">
            <div className="model-pane-head"><strong>Chosen models</strong><span>{chosen.length}</span></div>
            <div className="model-pane-list">
              {!chosen.length ? <div className="model-pane-empty">Select at least one model.</div> : chosen.map((model, index) => <div className="chosen-model-row" key={model}><span className="chosen-order">{index + 1}</span><code>{model}</code>{index === 0 ? <span className="settings-badge success">Provider default</span> : null}<button type="button" title="Remove model" onClick={() => setChosen((items) => items.filter((item) => item !== model))}><SettingsIcon name="x" size={13} /></button></div>)}
            </div>
          </div>
        </div>
      </section> : null}
    </Modal>
  );
}

function summaryToConfig(provider: ProviderSummary, patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: provider.id,
    kind: provider.kind,
    vendorKey: provider.vendorKey,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle,
    headers: provider.headers,
    models: provider.models,
    defaultModel: provider.defaultModel,
    enabled: provider.enabled,
    ...patch,
  };
}

function kindForStyle(style: ProviderApiStyle): ProviderKind {
  if (style === "anthropic_messages") return "anthropic";
  if (style === "google_generative_ai") return "google";
  return "openai";
}

function normalizeBaseUrl(value: string, style: ProviderApiStyle): string {
  let normalized = value.trim().replace(/\/+$/, "");
  const suffixes = style === "anthropic_messages"
    ? ["/v1/messages", "/messages", "/v1/models", "/models"]
    : style === "responses"
      ? ["/responses", "/models"]
      : style === "google_generative_ai"
        ? ["/models"]
        : ["/chat/completions", "/models"];
  for (const suffix of suffixes) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).replace(/\/+$/, "");
      if (style === "anthropic_messages" && suffix.startsWith("/v1/")) normalized = `${normalized}/v1`.replace(/\/v1\/v1$/, "/v1");
      break;
    }
  }
  return normalized;
}

function parseRateLimit(value: string): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function uniqueProviderId(base: string, providers: ProviderSummary[]): string {
  const ids = new Set(providers.map((provider) => provider.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

function hostLabel(baseUrl?: string): string {
  if (!baseUrl) return "default endpoint";
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

function apiStyleLabel(style: ProviderApiStyle): string {
  if (style === "anthropic_messages") return "Anthropic";
  if (style === "google_generative_ai") return "Gemini";
  if (style === "responses") return "Responses";
  return "Chat Completions";
}

function isLocalProvider(provider: ProviderSummary): boolean {
  return provider.vendorKey === "ollama" || provider.vendorKey === "lm-studio" || /localhost|127\.0\.0\.1/.test(provider.baseUrl ?? "");
}
