import { useMemo, useState } from "react";
import type { PluginInfo } from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import { EmptyState, IconButton, Toggle } from "./SettingsPrimitives";

export function PluginsSettings({ store }: { store: SenastrStore }) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return store.plugins.filter((plugin) => !query || `${plugin.name} ${plugin.description ?? ""} ${plugin.author ?? ""} ${plugin.tools.join(" ")}`.toLowerCase().includes(query));
  }, [search, store.plugins]);

  const install = async () => {
    setBusy("install");
    try {
      const dir = await api.plugin.pickDirectory();
      if (!dir) return;
      const plugin = await api.plugin.install(dir);
      await store.refresh();
      store.pushNotice(`${plugin.name} installed`, "info");
    } catch (error) { store.pushNotice(cleanError(error), "error"); }
    finally { setBusy(null); }
  };

  const toggle = async (plugin: PluginInfo) => {
    setBusy(plugin.name);
    try {
      await api.plugin.setEnabled(plugin.name, !plugin.enabled);
      await store.refresh();
      store.pushNotice(`${plugin.name} ${plugin.enabled ? "disabled" : "enabled"}`, "info");
    } catch (error) { store.pushNotice(cleanError(error), "error"); }
    finally { setBusy(null); }
  };

  const uninstall = async (plugin: PluginInfo) => {
    if (confirmDelete !== plugin.name) {
      setConfirmDelete(plugin.name);
      window.setTimeout(() => setConfirmDelete((name) => name === plugin.name ? null : name), 3000);
      return;
    }
    setBusy(plugin.name);
    try {
      await api.plugin.uninstall(plugin.name);
      await store.refresh();
      store.pushNotice(`${plugin.name} uninstalled`, "info");
    } catch (error) { store.pushNotice(cleanError(error), "error"); }
    finally { setBusy(null); setConfirmDelete(null); }
  };

  return (
    <div className="settings-page-stack extensions-page">
      <div className="capability-intro"><p>Extensions add tools to the agent through a reviewed declarative manifest.</p><span>Every extension command stays project-confined and goes through senastr's permission gate.</span></div>
      <div className="extensions-toolbar">
        <div className="settings-segments"><button type="button" className="active">Installed <span>{store.plugins.length}</span></button></div>
        <div className="capability-search"><SettingsIcon name="search" size={14} /><input value={search} placeholder="Search installed extensions" onChange={(event) => setSearch(event.target.value)} />{search ? <button type="button" onClick={() => setSearch("")}><SettingsIcon name="x" size={13} /></button> : null}</div>
        <button type="button" className="settings-primary-btn" disabled={busy === "install"} onClick={() => void install()}><SettingsIcon name={busy === "install" ? "refresh" : "folder"} size={14} className={busy === "install" ? "spin" : ""} /> {busy === "install" ? "Installing…" : "Install local"}</button>
      </div>
      <div className="extension-security-note"><SettingsIcon name="shield" size={16} /><div><strong>Local and permission-gated</strong><span>senastr copies the selected plugin into its local data directory. No extension code runs inside the renderer.</span></div></div>
      <div className="extension-groups">
        {!visible.length ? (
          <div className="settings-card"><EmptyState icon="plug" title={search ? "No extensions match" : "No extensions installed"} description={search ? "Try a different search." : "Choose a folder containing senastr.plugin.json to add declarative tools."} action={!search ? <button type="button" className="settings-primary-btn" onClick={() => void install()}><SettingsIcon name="folder" size={14} /> Choose plugin folder</button> : undefined} /></div>
        ) : visible.map((plugin) => {
          const open = expanded === plugin.name;
          return (
            <div className={`settings-card extension-row ${plugin.enabled ? "" : "off"}`} key={plugin.name}>
              <div className="extension-main-row">
                <span className="capability-glyph"><SettingsIcon name="plug" size={16} /></span>
                <div className="extension-copy">
                  <div><strong>{displayPluginName(plugin.name)}</strong><span className="settings-badge">v{plugin.version}</span>{plugin.author ? <span className="extension-author">by {plugin.author}</span> : null}</div>
                  <p>{plugin.description || "No description provided."}</p>
                  <button type="button" className="extension-details-toggle" onClick={() => setExpanded(open ? null : plugin.name)}><SettingsIcon name="chevron" size={13} className={open ? "open" : ""} /> Details</button>
                </div>
                <span className="extension-scope"><SettingsIcon name="globe" size={13} /> Everywhere</span>
                <div className="capability-actions">
                  {confirmDelete === plugin.name ? <button type="button" className="settings-confirm-delete" onClick={() => void uninstall(plugin)}>Uninstall?</button> : <IconButton icon="trash" danger label="Uninstall extension" disabled={busy === plugin.name} onClick={() => void uninstall(plugin)} />}
                  <Toggle checked={plugin.enabled} disabled={busy === plugin.name} label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`} onChange={() => void toggle(plugin)} />
                </div>
              </div>
              {open ? <div className="extension-details">
                <div><span>Package</span><code>{plugin.name}</code></div>
                <div><span>Installed</span><strong>{new Date(plugin.installedAt).toLocaleDateString()}</strong></div>
                <div className="extension-tools"><span>Agent tools</span><div>{plugin.tools.length ? plugin.tools.map((tool) => <code key={tool}>{tool}</code>) : <em>No tools</em>}</div></div>
                <div className="extension-tools"><span>Declared access</span><div>{permissionLabels(plugin).map((permission) => <code className="permission" key={permission}>{permission}</code>)}{!permissionLabels(plugin).length ? <em>Project command execution only</em> : null}</div></div>
              </div> : null}
            </div>
          );
        })}
      </div>
      <div className="extension-dev-note"><div><strong>Develop an extension</strong><span>Start with <code>examples/plugins/hello-senastr</code>. Manifests declare shell-command tools and their JSON schemas.</span></div><span className="settings-badge">senastr.plugin.json</span></div>
    </div>
  );
}

function displayPluginName(name: string): string {
  return name.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}
function permissionLabels(plugin: PluginInfo): string[] {
  return [
    ...(plugin.permissions?.fs ?? []).map((value) => `files: ${value}`),
    ...(plugin.permissions?.net ?? []).map((value) => `network: ${value}`),
  ];
}
