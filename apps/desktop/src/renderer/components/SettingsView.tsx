import { useMemo, useState, type ReactNode } from "react";
import type { PermissionGrant } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { api, cleanError } from "../lib/api";
import { McpSettings } from "./settings/McpSettings";
import { ModelsSettings } from "./settings/ModelsSettings";
import { PluginsSettings } from "./settings/PluginsSettings";
import { SettingsIcon, type SettingsIconName } from "./settings/SettingsIcons";
import { SkillsSettings } from "./settings/SkillsSettings";
import { EmptyState } from "./settings/SettingsPrimitives";

type SettingsTab = "models" | "skills" | "mcp" | "plugins" | "permissions" | "about";
type Group = "Agent" | "Security" | "System";

const NAV: Array<{
  id: SettingsTab;
  label: string;
  title: string;
  description: string;
  icon: SettingsIconName;
  group: Group;
  keywords: string;
}> = [
  { id: "models", label: "Models", title: "Model configuration", description: "Providers, model catalogs, and your default model", icon: "sparkles", group: "Agent", keywords: "ai api key provider openai anthropic gemini ollama default" },
  { id: "skills", label: "Skills", title: "Skills", description: "Reusable instructions for global and project workflows", icon: "book", group: "Agent", keywords: "prompt instructions markdown capability" },
  { id: "mcp", label: "MCP", title: "MCP servers", description: "Connect local commands and Streamable HTTP tool servers", icon: "server", group: "Agent", keywords: "model context protocol tools stdio http server" },
  { id: "plugins", label: "Extensions", title: "Extensions", description: "Install and manage local agent plugins", icon: "plug", group: "Agent", keywords: "plugins marketplace tools install local" },
  { id: "permissions", label: "Permissions", title: "Permission grants", description: "Review standing approvals for privileged tools", icon: "shield", group: "Security", keywords: "grants security allow write execute revoke" },
  { id: "about", label: "About", title: "About senastr", description: "Version, storage, privacy, and architecture", icon: "info", group: "System", keywords: "version data privacy local host core" },
];

export function SettingsView({ store }: { store: SenastrStore }) {
  const [tab, setTab] = useState<SettingsTab>("models");
  const [query, setQuery] = useState("");
  const active = NAV.find((item) => item.id === tab) ?? NAV[0];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? NAV.filter((item) => `${item.label} ${item.title} ${item.keywords}`.toLowerCase().includes(needle)) : NAV;
  }, [query]);

  const content: Record<SettingsTab, ReactNode> = {
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
          {filtered.length ? (["Agent", "Security", "System"] as Group[]).map((group) => {
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
