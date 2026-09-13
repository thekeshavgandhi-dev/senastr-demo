import { useMemo, useState, type ReactNode } from "react";
import type { PermissionGrant } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { api, cleanError } from "../lib/api";
import { prefs, type AgentMode, type PermissionMode, type ThemePref } from "../lib/prefs";
import { McpSettings } from "./settings/McpSettings";
import { ModelsSettings } from "./settings/ModelsSettings";
import { PluginsSettings } from "./settings/PluginsSettings";
import { SettingsIcon, type SettingsIconName } from "./settings/SettingsIcons";
import { SkillsSettings } from "./settings/SkillsSettings";
import { EmptyState, Field, Toggle } from "./settings/SettingsPrimitives";
import { Kbd, cx } from "./ui";

type Group = "Preferences" | "Agent" | "Security" | "System";

const NAV: Array<{
  id: string;
  label: string;
  title: string;
  description: string;
  icon: SettingsIconName;
  group: Group;
  keywords: string;
}> = [
  { id: "general", label: "General", title: "General", description: "Appearance and behavior", icon: "sliders", group: "Preferences", keywords: "theme appearance font size enter send paste light dark" },
  { id: "ai", label: "AI", title: "AI defaults", description: "Default agent and permission modes", icon: "sparkles", group: "Preferences", keywords: "mode build plan permission ask auto accept edits default" },
  { id: "shortcuts", label: "Shortcuts", title: "Keyboard shortcuts", description: "Work faster from the keyboard", icon: "keyboard", group: "Preferences", keywords: "keyboard hotkeys bindings search sidebar panel" },
  { id: "models", label: "Models", title: "Model configuration", description: "Providers, model catalogs, and your default model", icon: "sparkles", group: "Agent", keywords: "ai api key provider openai anthropic gemini ollama default" },
  { id: "skills", label: "Skills", title: "Skills", description: "Reusable instructions for global and project workflows", icon: "book", group: "Agent", keywords: "prompt instructions markdown capability" },
  { id: "mcp", label: "MCP", title: "MCP servers", description: "Connect local commands and Streamable HTTP tool servers", icon: "server", group: "Agent", keywords: "model context protocol tools stdio http server" },
  { id: "plugins", label: "Extensions", title: "Extensions", description: "Install and manage local agent plugins", icon: "plug", group: "Agent", keywords: "plugins marketplace tools install local" },
  { id: "permissions", label: "Permissions", title: "Permission grants", description: "Review standing approvals for privileged tools", icon: "shield", group: "Security", keywords: "grants security allow write execute revoke" },
  { id: "about", label: "About", title: "About senastr", description: "Version, storage, privacy, and architecture", icon: "info", group: "System", keywords: "version data privacy local host core" },
];

export function SettingsView({ store }: { store: SenastrStore }) {
  const [query, setQuery] = useState("");
  const tab = NAV.some((n) => n.id === store.settingsTab) ? store.settingsTab : "models";
  const setTab = store.setSettingsTab;
  const active = NAV.find((item) => item.id === tab) ?? NAV[3];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? NAV.filter((item) => `${item.label} ${item.title} ${item.keywords}`.toLowerCase().includes(needle)) : NAV;
  }, [query]);

  const content: Record<string, ReactNode> = {
    general: <GeneralSettings store={store} />,
    ai: <AiSettings store={store} />,
    shortcuts: <ShortcutsSettings />,
    models: <ModelsSettings store={store} />,
    skills: <SkillsSettings store={store} />,
    mcp: <McpSettings store={store} />,
    plugins: <PluginsSettings store={store} />,
    permissions: <PermissionsSettings store={store} />,
    about: <AboutSettings version={store.version} dataDir={store.dataDir} />,
  };

  return (
    <div className="settings-shell">
      <aside className="settings-nav">
        <div className="settings-nav-top">
          <button type="button" className="settings-back" onClick={() => store.setView("chat")}><SettingsIcon name="arrow-left" size={15} /> Back to app</button>
          <div className="settings-nav-search"><SettingsIcon name="search" size={14} /><input value={query} autoFocus={false} placeholder="Search settings…" aria-label="Search settings" onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><SettingsIcon name="x" size={12} /></button> : null}</div>
        </div>
        <nav className="settings-nav-scroll" aria-label="Settings pages">
          {filtered.length ? (["Preferences", "Agent", "Security", "System"] as Group[]).map((group) => {
            const rows = filtered.filter((item) => item.group === group);
            if (!rows.length) return null;
            return <div className="settings-nav-group" key={group}><span>{group}</span>{rows.map((item) => <button type="button" key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><SettingsIcon name={item.icon} size={15} /><span>{item.label}</span></button>)}</div>;
          }) : <div className="settings-nav-no-results">No settings found</div>}
        </nav>
        <div className="settings-nav-footer"><div className="settings-mini-brand"><span>s</span><div><strong>senastr</strong><small>local-first agent</small></div></div>{store.version ? <code>v{store.version}</code> : null}</div>
      </aside>
      <main className="settings-content">
        <div className="settings-content-inner">
          <header className="settings-page-header"><div><h1>{active.title}</h1><p>{active.description}</p></div></header>
          {content[tab]}
        </div>
      </main>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="settings-segments" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ title, desc, control }: { title: string; desc: string; control: ReactNode }) {
  return (
    <div className="pref-row">
      <div className="pref-row-text">
        <strong>{title}</strong>
        <span>{desc}</span>
      </div>
      <div className="pref-row-control">{control}</div>
    </div>
  );
}

function GeneralSettings({ store }: { store: SenastrStore }) {
  const [pasteThreshold, setPasteThreshold] = useState(() => String(prefs.largePasteThreshold));
  return (
    <div className="settings-page-stack">
      <section className="settings-block">
        <div className="settings-block-heading"><h2>Appearance</h2></div>
        <div className="settings-card pref-list">
          <Row
            title="Theme"
            desc="Follow the OS or pick a fixed theme"
            control={
              <Segmented<ThemePref>
                ariaLabel="Theme"
                value={store.theme}
                onChange={store.setTheme}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            }
          />
          <Row
            title="Font size"
            desc="Scale the whole interface"
            control={
              <Segmented<string>
                ariaLabel="Font size"
                value={store.fontScale < 0.95 ? "s" : store.fontScale > 1.05 ? "l" : "m"}
                onChange={(v) => store.setFontScale(v === "s" ? 0.9 : v === "l" ? 1.1 : 1)}
                options={[
                  { value: "s", label: "Small" },
                  { value: "m", label: "Default" },
                  { value: "l", label: "Large" },
                ]}
              />
            }
          />
        </div>
      </section>
      <section className="settings-block">
        <div className="settings-block-heading"><h2>Composer</h2></div>
        <div className="settings-card pref-list">
          <Row
            title="Enter to send"
            desc="On: Enter sends, Shift+Enter adds a line. Off: Ctrl+Enter sends."
            control={<Toggle label="Enter to send" checked={store.enterToSend} onChange={() => store.setEnterToSend(!store.enterToSend)} />}
          />
          <Row
            title="Large paste threshold"
            desc="Pastes bigger than this become attachments instead of raw text"
            control={
              <span className="pref-inline-input">
                <input
                  className="settings-input compact"
                  value={pasteThreshold}
                  inputMode="numeric"
                  aria-label="Large paste threshold in characters"
                  onChange={(e) => setPasteThreshold(e.target.value)}
                  onBlur={() => {
                    const v = Math.max(200, Math.min(100000, Number.parseInt(pasteThreshold, 10) || 2000));
                    prefs.largePasteThreshold = v;
                    setPasteThreshold(String(v));
                  }}
                />
                <span>chars</span>
              </span>
            }
          />
        </div>
      </section>
      <section className="settings-block">
        <div className="settings-block-heading"><h2>Sidebar</h2></div>
        <div className="settings-card pref-list">
          <Row
            title="Collapse sidebar"
            desc="Hide the session list to focus on the conversation"
            control={
              <Toggle
                label="Collapse sidebar"
                checked={store.sidebarCollapsed}
                onChange={() => store.setSidebarCollapsed(!store.sidebarCollapsed)}
              />
            }
          />
        </div>
      </section>
    </div>
  );
}

function AiSettings({ store }: { store: SenastrStore }) {
  return (
    <div className="settings-page-stack">
      <section className="settings-block">
        <div className="settings-block-heading"><h2>Defaults for new sessions</h2></div>
        <div className="settings-card pref-list">
          <Row
            title="Agent mode"
            desc="Build: full access. Plan: propose first, change nothing."
            control={
              <Segmented<AgentMode>
                ariaLabel="Default agent mode"
                value={store.defaultAgentMode}
                onChange={store.setDefaultAgentMode}
                options={[
                  { value: "build", label: "Build" },
                  { value: "plan", label: "Plan" },
                ]}
              />
            }
          />
          <Row
            title="Permission mode"
            desc="How privileged tools are approved in new sessions"
            control={
              <Segmented<PermissionMode>
                ariaLabel="Default permission mode"
                value={store.defaultPermissionMode}
                onChange={store.setDefaultPermissionMode}
                options={[
                  { value: "ask", label: "Ask" },
                  { value: "accept-edits", label: "Accept edits" },
                  { value: "auto", label: "Auto" },
                ]}
              />
            }
          />
        </div>
      </section>
      <section className="settings-block">
        <div className="settings-block-heading"><h2>What each mode means</h2></div>
        <div className="settings-card about-rows mode-explainer">
          <div><span>Ask</span><strong>Every file write, command and plugin/MCP tool needs approval</strong></div>
          <div><span>Accept edits</span><strong>File writes auto-approve; commands still ask</strong></div>
          <div><span>Auto</span><strong>All tools auto-approve — fastest, least supervision</strong></div>
          <div><span>Plan</span><strong>Agent investigates and proposes; no changes until you say so</strong></div>
        </div>
      </section>
      <section className="settings-block">
        <div className="settings-block-heading"><h2>Per-session overrides</h2></div>
        <div className="settings-card pref-list">
          <Field label="Composer toolbar" hint="Each session remembers its own mode and permission level. Switch them any time from the chips above the message box.">
            <span />
          </Field>
        </div>
      </section>
    </div>
  );
}

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["Ctrl", "K"], label: "Search sessions, settings and actions" },
  { keys: ["Ctrl", "B"], label: "Toggle sidebar" },
  { keys: ["Ctrl", "J"], label: "Toggle work panel" },
  { keys: ["Ctrl", "Shift", "O"], label: "New task in current project" },
  { keys: ["Ctrl", ","], label: "Open settings" },
  { keys: ["Enter"], label: "Send message (or Ctrl+Enter when disabled)" },
  { keys: ["Shift", "Enter"], label: "New line in composer" },
  { keys: ["@"], label: "Reference a file touched in this session" },
  { keys: ["Esc"], label: "Close dialog / menu" },
];

function ShortcutsSettings() {
  return (
    <div className="settings-page-stack">
      <section className="settings-block">
        <div className="settings-block-heading"><h2>Keyboard</h2></div>
        <div className="settings-card shortcut-list">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="shortcut-row">
              <span>{s.label}</span>
              <span className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <span key={i} className="shortcut-chord">
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>
      <p className={cx("about-reference")}>On macOS, Ctrl can be replaced with ⌘ in most shortcuts.</p>
    </div>
  );
}

function PermissionsSettings({ store }: { store: SenastrStore }) {
  const [busy, setBusy] = useState(false);
  const clear = async (params: { sessionId?: string; tool?: string }) => {
    setBusy(true);
    try { await api.permission.clear(params); await store.refresh(); store.pushNotice("Permission grant revoked", "info"); }
    catch (error) { store.pushNotice(cleanError(error), "error"); }
    finally { setBusy(false); }
  };
  const grouped = store.grants.reduce((map, grant) => {
    const key = `${grant.tool}:${grant.scope}:${grant.sessionId ?? ""}`;
    map.set(key, grant);
    return map;
  }, new Map<string, PermissionGrant>());

  return (
    <div className="settings-page-stack permissions-page">
      <div className="permission-explainer"><span><SettingsIcon name="shield" size={19} /></span><div><strong>Privileged actions always start locked</strong><p>Read-only project tools run directly. File writes, commands, plugin tools, and MCP tools require your approval unless you create a standing grant.</p></div></div>
      <section className="settings-block">
        <div className="settings-block-heading"><div className="heading-with-count"><h2>Standing grants</h2><span>{grouped.size}</span></div>{grouped.size ? <button type="button" className="settings-ghost-btn danger" disabled={busy} onClick={() => void clear({})}>Revoke all</button> : null}</div>
        <div className="settings-card permission-list">
          {!grouped.size ? <EmptyState icon="shield" title="No standing grants" description="senastr will ask before every privileged tool call." /> : [...grouped.values()].map((grant) => <div className="permission-row" key={`${grant.tool}:${grant.scope}:${grant.sessionId ?? ""}`}><span className="permission-tool-icon"><SettingsIcon name={grant.tool.startsWith("mcp_") ? "server" : "terminal"} size={15} /></span><div><code>{grant.tool}</code><span>{grant.scope === "always" ? "Every session" : "Current session only"}</span></div><span className={`settings-badge ${grant.scope === "always" ? "warning" : ""}`}>{grant.scope}</span><button type="button" className="settings-ghost-btn compact" disabled={busy} onClick={() => void clear({ tool: grant.tool, sessionId: grant.sessionId ?? undefined })}>Revoke</button></div>)}
        </div>
      </section>
      <div className="permission-footnote"><SettingsIcon name="info" size={14} /> Unanswered requests are denied automatically after 120 seconds. Grants can never bypass project-path confinement.</div>
    </div>
  );
}

function AboutSettings({ version, dataDir }: { version: string; dataDir: string }) {
  return (
    <div className="settings-page-stack about-settings-page">
      <div className="about-hero"><div className="about-logo">s</div><div><h2>senastr</h2><p>The local-first workspace for AI coding agents.</p><span>Version {version || "0.1.0"}</span></div></div>
      <section className="settings-block"><div className="settings-block-heading"><h2>Local data</h2></div><div className="settings-card about-rows"><div><span>Storage</span><code title={dataDir}>{dataDir || "Host-core data directory"}</code></div><div><span>Model traffic</span><strong>Direct to your configured provider</strong></div><div><span>Project access</span><strong>Confined to the opened project</strong></div><div><span>Credentials</span><strong>Owned by host-core, never exposed to chat</strong></div></div></section>
      <section className="settings-block"><div className="settings-block-heading"><h2>Agent capabilities</h2></div><div className="about-capability-grid"><div><SettingsIcon name="sparkles" size={18} /><strong>Model agnostic</strong><span>OpenAI, Anthropic, Gemini, compatible and local endpoints</span></div><div><SettingsIcon name="book" size={18} /><strong>Skills</strong><span>Reusable global or project instructions</span></div><div><SettingsIcon name="server" size={18} /><strong>MCP</strong><span>Lazy local and HTTP tool connections</span></div><div><SettingsIcon name="shield" size={18} /><strong>Permission gated</strong><span>You approve every privileged capability</span></div></div></section>
      <p className="about-reference">From-scratch implementation inspired by the open architecture of PI-Desktop.</p>
    </div>
  );
}
