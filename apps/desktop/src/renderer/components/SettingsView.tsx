import { useState } from "react";
import type { ProviderConfig, ProviderKind, ProviderTestResult } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { api, cleanError } from "../lib/api";

export function SettingsView({ store }: { store: SenastrStore }) {
  return (
    <div className="settings">
      <div className="settings-inner">
        <h1>Settings</h1>
        <ProvidersSection store={store} />
        <PluginsSection store={store} />
        <GrantsSection store={store} />
        <div className="about">
          <h2>About</h2>
          <p>
            senastr v{store.version || "0.1.0"} — a local-first AI coding agent workspace. Your sessions,
            credentials and files live in <code>~/.senastr</code> (or <code>$SENASTR_DATA_DIR</code>). Model
            requests go directly to the endpoint you configure — no relay, no account.
          </p>
        </div>
      </div>
    </div>
  );
}

function ProvidersSection({ store }: { store: SenastrStore }) {
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const save = async () => {
    const modelList = models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (!label.trim() || modelList.length === 0) {
      store.pushNotice("Label and at least one model are required", "error");
      return;
    }
    const config: ProviderConfig = {
      id: label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider",
      kind,
      label: label.trim(),
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
      models: modelList,
      defaultModel: modelList[0],
    };
    try {
      await api.provider.set(config);
      await store.refresh();
      setLabel("");
      setBaseUrl("");
      setApiKey("");
      setModels("");
      store.pushNotice(`Provider “${config.label}” saved`, "info");
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    try {
      const result = await api.provider.test(id);
      setTestResults((r) => ({ ...r, [id]: result }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [id]: { ok: false, detail: cleanError(err) } }));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.provider.delete(id);
      await store.refresh();
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    }
  };

  return (
    <section className="settings-section">
      <h2>Model providers</h2>
      {store.providers.length === 0 && (
        <p className="muted">
          No providers yet. Add OpenAI, Anthropic, or any OpenAI-compatible endpoint (Ollama, vLLM, gateways).
        </p>
      )}
      <div className="provider-cards">
        {store.providers.map((p) => (
          <div key={p.id} className="provider-card">
            <div className="provider-head">
              <strong>{p.label}</strong>
              <span className="tag">{p.kind}</span>
              {p.hasApiKey && <span className="tag">key</span>}
            </div>
            <div className="provider-base">{p.baseUrl ?? "default endpoint"}</div>
            <div className="provider-models">{p.models.join(", ")}</div>
            {testResults[p.id] && (
              <div className={`provider-test ${testResults[p.id].ok ? "ok" : "fail"}`}>
                {testResults[p.id].detail}
              </div>
            )}
            <div className="provider-actions">
              <button className="btn small" disabled={testing === p.id} onClick={() => void test(p.id)}>
                {testing === p.id ? "Testing…" : "Test connection"}
              </button>
              <button className="btn small danger" onClick={() => void remove(p.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="provider-form">
        <h3>Add / update provider</h3>
        <div className="form-grid">
          <label>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            Label
            <input
              value={label}
              placeholder="e.g. Local Ollama"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="wide">
            Base URL
            <input
              value={baseUrl}
              placeholder={
                kind === "openai" ? "https://api.openai.com/v1 (or http://127.0.0.1:11434/v1)" : "https://api.anthropic.com"
              }
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className="wide">
            API key
            <input
              type="password"
              value={apiKey}
              placeholder="sk-… (leave blank to keep existing)"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <label className="wide">
            Models <span className="muted">(comma separated)</span>
            <input
              value={models}
              placeholder={kind === "openai" ? "gpt-4o, gpt-4o-mini" : "claude-sonnet-4-5, claude-haiku-4-5"}
              onChange={(e) => setModels(e.target.value)}
            />
          </label>
        </div>
        <div className="form-actions">
          <button className="btn primary" onClick={() => void save()}>
            Save provider
          </button>
          <span className="muted">
            Tip: empty API key + Ollama base URL works for local models. A provider with an existing id is
            updated in place.
          </span>
        </div>
      </div>
    </section>
  );
}

function PluginsSection({ store }: { store: SenastrStore }) {
  const [dir, setDir] = useState("");
  const install = async () => {
    if (!dir.trim()) return;
    try {
      const info = await api.plugin.install(dir.trim());
      await store.refresh();
      setDir("");
      store.pushNotice(`Plugin “${info.name}” installed`, "info");
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    }
  };
  const uninstall = async (name: string) => {
    try {
      await api.plugin.uninstall(name);
      await store.refresh();
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    }
  };

  return (
    <section className="settings-section">
      <h2>Plugins</h2>
      <p className="muted">
        Plugins add tools to the agent. v0 plugins are declarative: a <code>senastr.plugin.json</code> manifest
        with optional shell-command tools. Example: <code>examples/plugins/hello-senastr</code> in the repo.
      </p>
      {store.plugins.length > 0 && (
        <div className="plugin-list">
          {store.plugins.map((p) => (
            <div key={p.name} className="plugin-row">
              <div>
                <strong>{p.name}</strong> <span className="muted">v{p.version}</span>
                {p.description && <div className="muted">{p.description}</div>}
                {p.tools.length > 0 && <div className="plugin-tools">tools: {p.tools.join(", ")}</div>}
              </div>
              <button className="btn small danger" onClick={() => void uninstall(p.name)}>
                Uninstall
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="plugin-install">
        <input
          value={dir}
          placeholder="/path/to/plugin-folder (contains senastr.plugin.json)"
          onChange={(e) => setDir(e.target.value)}
        />
        <button className="btn primary" onClick={() => void install()} disabled={!dir.trim()}>
          Install
        </button>
      </div>
    </section>
  );
}

function GrantsSection({ store }: { store: SenastrStore }) {
  const clear = async (p: { sessionId?: string; tool?: string }) => {
    await api.permission.clear(p);
    await store.refresh();
  };
  return (
    <section className="settings-section">
      <h2>Permission grants</h2>
      {store.grants.length === 0 ? (
        <p className="muted">No standing grants. write/exec tools ask each time until you allow them.</p>
      ) : (
        <table className="grants-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Scope</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {store.grants.map((g, i) => (
              <tr key={`${g.tool}-${g.sessionId ?? "always"}-${i}`}>
                <td>{g.tool}</td>
                <td>{g.scope === "always" ? "always" : "this session"}</td>
                <td>
                  <button className="btn small" onClick={() => void clear({ tool: g.tool })}>
                    Revoke {g.tool}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {store.grants.length > 0 && (
        <button className="btn small" onClick={() => void clear({})}>
          Clear all grants
        </button>
      )}
    </section>
  );
}
