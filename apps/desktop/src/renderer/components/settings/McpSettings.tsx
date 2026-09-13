import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CapabilityLevel,
  McpServerInput,
  McpServerStatus,
  McpServerSummary,
  McpTransport,
} from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import {
  Field,
  IconButton,
  KeyValueEditor,
  Modal,
  Toggle,
  pairsToRecord,
  recordToPairs,
  type KeyValuePair,
} from "./SettingsPrimitives";

type Filter = "all" | CapabilityLevel;

export function McpSettings({ store }: { store: SenastrStore }) {
  const projectPath = store.activeSession?.projectPath ?? null;
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<McpServerSummary | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.mcp.list(projectPath ? { projectPath } : {});
      setServers(result.servers);
      setStatuses(result.statuses);
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setLoading(false);
    }
  }, [projectPath, store.pushNotice]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return servers.filter((server) =>
      (filter === "all" || server.level === filter) &&
      (!query || `${server.label} ${server.id} ${server.description ?? ""} ${server.command ?? ""} ${server.url ?? ""}`.toLowerCase().includes(query)),
    );
  }, [filter, search, servers]);

  const toggle = async (server: McpServerSummary) => {
    setBusy(server.id);
    setServers((rows) => rows.map((row) => row.id === server.id ? { ...row, enabled: !server.enabled } : row));
    try {
      await api.mcp.setEnabled({ id: server.id, enabled: !server.enabled, level: server.level, projectPath: server.projectPath });
      setStatuses((items) => items.map((status) => status.serverId === server.id ? { ...status, state: "idle", toolCount: 0 } : status));
      store.pushNotice(`${server.label} ${server.enabled ? "disabled" : "enabled"}`, "info");
    } catch (error) {
      setServers((rows) => rows.map((row) => row.id === server.id ? server : row));
      store.pushNotice(cleanError(error), "error");
    } finally { setBusy(null); }
  };

  const test = async (server: McpServerSummary) => {
    setBusy(`test:${server.id}`);
    setStatuses((items) => upsertStatus(items, { serverId: server.id, state: "connecting", toolCount: 0, updatedAt: Date.now() }));
    try {
      const status = await api.mcp.test({ id: server.id, level: server.level, projectPath: server.projectPath });
      setStatuses((items) => upsertStatus(items, status));
      store.pushNotice(status.state === "ready" ? `${server.label} connected · ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}` : status.message || "MCP connection failed", status.state === "ready" ? "info" : "error");
    } catch (error) {
      const message = cleanError(error);
      setStatuses((items) => upsertStatus(items, { serverId: server.id, state: "failed", toolCount: 0, message, updatedAt: Date.now() }));
      store.pushNotice(message, "error");
    } finally { setBusy(null); }
  };

  const remove = async (server: McpServerSummary) => {
    if (confirmDelete !== server.id) {
      setConfirmDelete(server.id);
      window.setTimeout(() => setConfirmDelete((id) => id === server.id ? null : id), 3000);
      return;
    }
    setBusy(server.id);
    try {
      await api.mcp.delete({ id: server.id, level: server.level, projectPath: server.projectPath });
      await load();
      store.pushNotice(`${server.label} removed`, "info");
    } catch (error) { store.pushNotice(cleanError(error), "error"); }
    finally { setBusy(null); setConfirmDelete(null); }
  };

  const renderGroup = (level: CapabilityLevel, rows: McpServerSummary[]) => (
    <div className="capability-group" key={level}>
      <div className="capability-group-head"><div><span>{level === "global" ? "Global" : "Project"}</span><code>{level === "global" ? (store.dataDir ? `${store.dataDir}/mcp-servers.json` : "host data / mcp-servers.json") : projectPath ? `scope: ${projectPath}` : "scope: <open project>"}</code></div><b>{rows.length}</b></div>
      {!rows.length ? <div className="capability-group-empty">{search ? "No servers match this search." : level === "project" && !projectPath ? "Open a project to manage project servers." : "No MCP servers at this level."}</div> : rows.map((server) => {
        const status: McpServerStatus = statuses.find((item) => item.serverId === server.id) ?? {
          serverId: server.id,
          state: "idle",
          toolCount: 0,
          updatedAt: 0,
        };
        const rowBusy = busy === server.id || busy === `test:${server.id}`;
        return (
          <div className={`capability-row mcp-row ${server.enabled ? "" : "off"}`} key={server.id}>
            <span className={`capability-glyph status-${status.state}`}><SettingsIcon name={server.transport === "stdio" ? "terminal" : "server"} size={16} /></span>
            <div className="capability-copy">
              <div><strong>{server.label}</strong><span className="settings-badge">{server.level}</span><span className="settings-badge">{server.transport}</span>{status.state !== "idle" ? <span className={`settings-badge status ${status.state}`}><i />{status.state === "ready" ? `${status.toolCount} tools` : status.state}</span> : null}</div>
              <code className="capability-command">{server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}</code>
              {server.description ? <p>{server.description}</p> : null}
              {status.message && status.state === "failed" ? <p className="capability-error">{status.message}</p> : null}
            </div>
            <div className="capability-actions">
              <IconButton icon={busy === `test:${server.id}` ? "refresh" : "test"} label="Test connection" disabled={rowBusy} onClick={() => void test(server)} />
              <IconButton icon="edit" label="Edit server" disabled={rowBusy} onClick={() => setEditor(server)} />
              {confirmDelete === server.id ? <button type="button" className="settings-confirm-delete" onClick={() => void remove(server)}>Delete?</button> : <IconButton icon="trash" label="Delete server" danger disabled={rowBusy} onClick={() => void remove(server)} />}
              <Toggle checked={server.enabled} disabled={rowBusy} label={`${server.enabled ? "Disable" : "Enable"} ${server.label}`} onChange={() => void toggle(server)} />
            </div>
          </div>
        );
      })}
    </div>
  );

  const global = visible.filter((server) => server.level === "global");
  const project = visible.filter((server) => server.level === "project");

  return (
    <div className="settings-page-stack capability-page">
      <div className="capability-intro"><p>Connect Model Context Protocol servers to give the agent additional tools and data sources.</p><span>Tool calls use the same permission gate as plugin commands. Connections stay local and start only when needed.</span></div>
      <div className="capability-toolbar">
        <div className="settings-segments">{(["all", "global", "project"] as Filter[]).map((item) => <button type="button" key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{capitalize(item)} <span>{item === "all" ? servers.length : servers.filter((server) => server.level === item).length}</span></button>)}</div>
        <div className="capability-search"><SettingsIcon name="search" size={14} /><input value={search} placeholder="Search MCP servers" onChange={(event) => setSearch(event.target.value)} />{search ? <button type="button" onClick={() => setSearch("")}><SettingsIcon name="x" size={13} /></button> : null}</div>
        <button type="button" className="settings-secondary-btn" onClick={() => setImporting(true)}>Import JSON</button>
        <button type="button" className="settings-primary-btn" onClick={() => setEditor("new")}><SettingsIcon name="plus" size={14} /> Add server</button>
      </div>
      <div className={`settings-card capability-panel ${loading ? "loading" : ""}`}>
        {loading ? <div className="capability-loading"><SettingsIcon name="refresh" size={16} className="spin" /> Loading servers…</div> : <>{filter !== "project" ? renderGroup("global", global) : null}{filter !== "global" ? renderGroup("project", project) : null}</>}
      </div>
      {editor ? <McpEditor server={editor === "new" ? null : editor} projectPath={projectPath} initialLevel={filter === "project" ? "project" : "global"} onClose={() => setEditor(null)} onSaved={async (name) => { setEditor(null); await load(); store.pushNotice(`${name} saved`, "info"); }} onError={(message) => store.pushNotice(message, "error")} /> : null}
      {importing ? <McpImport projectPath={projectPath} initialLevel={filter === "project" ? "project" : "global"} onClose={() => setImporting(false)} onImported={async (count) => { setImporting(false); await load(); store.pushNotice(`${count} MCP server${count === 1 ? "" : "s"} imported`, "info"); }} onError={(message) => store.pushNotice(message, "error")} /> : null}
    </div>
  );
}

function McpEditor({ server, projectPath, initialLevel, onClose, onSaved, onError }: {
  server: McpServerSummary | null;
  projectPath: string | null;
  initialLevel: CapabilityLevel;
  onClose: () => void;
  onSaved: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [id, setId] = useState(server?.id ?? "");
  const [label, setLabel] = useState(server?.label ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [url, setUrl] = useState(server?.url ?? "");
  const [env, setEnv] = useState<KeyValuePair[]>(recordToPairs(server?.env));
  const [headers, setHeaders] = useState<KeyValuePair[]>(recordToPairs(server?.headers));
  const [level, setLevel] = useState<CapabilityLevel>(server?.level ?? initialLevel);
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const effectiveId = id.trim() || slug(label);
  const canSave = effectiveId && label.trim() && (transport === "stdio" ? command.trim() : url.trim()) && (level === "global" || projectPath);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const input: McpServerInput = {
      id: effectiveId,
      label: label.trim(),
      description: description.trim() || undefined,
      transport,
      command: transport === "stdio" ? command.trim() : undefined,
      args: transport === "stdio" ? args.split("\n").map((item) => item.trim()).filter(Boolean) : undefined,
      env: transport === "stdio" ? pairsToRecord(env) : undefined,
      url: transport === "http" ? url.trim() : undefined,
      headers: transport === "http" ? pairsToRecord(headers) : undefined,
      enabled,
      level,
      projectPath: level === "project" ? projectPath! : undefined,
    };
    try { const saved = await api.mcp.set(input); onSaved(saved.label); }
    catch (error) { onError(cleanError(error)); setSaving(false); }
  };

  return (
    <Modal wide title={server ? "Edit MCP server" : "Add MCP server"} subtitle="Use stdio for a local command or Streamable HTTP for a remote endpoint." onClose={onClose} footer={<><span className="modal-scope-note"><SettingsIcon name={level === "global" ? "globe" : "folder"} size={14} /> {level === "global" ? "Available in every project" : projectPath ? `Only ${projectName(projectPath)}` : "Open a project first"}</span><div><button type="button" className="settings-ghost-btn" onClick={onClose}>Cancel</button><button type="button" className="settings-primary-btn" disabled={!canSave || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save server"}</button></div></>}>
      <div className="mcp-editor">
        <div className="transport-picker"><button type="button" className={transport === "stdio" ? "active" : ""} onClick={() => setTransport("stdio")}><SettingsIcon name="terminal" size={17} /><span><strong>Local command</strong><small>stdio transport</small></span></button><button type="button" className={transport === "http" ? "active" : ""} onClick={() => setTransport("http")}><SettingsIcon name="server" size={17} /><span><strong>HTTP endpoint</strong><small>Streamable HTTP</small></span></button></div>
        <div className="mcp-fields-grid">
          <Field label="Display name"><input autoFocus value={label} placeholder="e.g. GitHub" onChange={(event) => { setLabel(event.target.value); if (!server && (!id || id === slug(label))) setId(slug(event.target.value)); }} /></Field>
          <Field label="Server ID" hint="lowercase slug"><input className="mono" value={id} disabled={Boolean(server)} placeholder="github" onChange={(event) => setId(slug(event.target.value))} /></Field>
          <Field label="Description" wide><input value={description} placeholder="What data or tools does this server provide?" onChange={(event) => setDescription(event.target.value)} /></Field>
          {transport === "stdio" ? <><Field label="Command" wide><input className="mono" value={command} placeholder="npx" onChange={(event) => setCommand(event.target.value)} /></Field><Field label="Arguments" hint="one per line" wide><textarea className="mono mcp-args" value={args} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder"} onChange={(event) => setArgs(event.target.value)} /></Field><div className="mcp-kv-section"><strong>Environment variables</strong><p>Values are masked after saving. Leave a masked value unchanged to keep it.</p><KeyValueEditor pairs={env} onChange={setEnv} addLabel="Add variable" keyPlaceholder="API_KEY" secret /></div></> : <><Field label="Server URL" wide><input className="mono" value={url} placeholder="https://example.com/mcp" onChange={(event) => setUrl(event.target.value)} /></Field><div className="mcp-kv-section"><strong>Request headers</strong><p>Use headers for endpoint-specific authentication or routing. Values are masked after saving.</p><KeyValueEditor pairs={headers} onChange={setHeaders} addLabel="Add header" keyPlaceholder="Authorization" secret /></div></>}
          <Field label="Level"><select value={level} disabled={Boolean(server)} onChange={(event) => setLevel(event.target.value as CapabilityLevel)}><option value="global">Global</option><option value="project" disabled={!projectPath}>Current project</option></select></Field>
          <label className="editor-toggle-row inline"><Toggle checked={enabled} label="Enable server" onChange={() => setEnabled((value) => !value)} /><span><strong>Enabled</strong><small>Connect when a matching agent session needs tools.</small></span></label>
        </div>
      </div>
    </Modal>
  );
}

function McpImport({ projectPath, initialLevel, onClose, onImported, onError }: {
  projectPath: string | null;
  initialLevel: CapabilityLevel;
  onClose: () => void;
  onImported: (count: number) => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [level, setLevel] = useState<CapabilityLevel>(initialLevel);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const inputs = parseMcpImport(text, level, projectPath);
      for (const input of inputs) await api.mcp.set(input);
      onImported(inputs.length);
    } catch (error) { onError(cleanError(error)); setBusy(false); }
  };
  return (
    <Modal title="Import MCP configuration" subtitle="Paste the common mcpServers JSON format used by Claude, VS Code, and other MCP clients." wide onClose={onClose} footer={<><span /><div><button type="button" className="settings-ghost-btn" onClick={onClose}>Cancel</button><button type="button" className="settings-primary-btn" disabled={!text.trim() || busy || (level === "project" && !projectPath)} onClick={() => void run()}>{busy ? "Importing…" : "Import servers"}</button></div></>}>
      <div className="mcp-import"><Field label="Level"><select value={level} onChange={(event) => setLevel(event.target.value as CapabilityLevel)}><option value="global">Global</option><option value="project" disabled={!projectPath}>Current project</option></select></Field><Field label="Configuration JSON" wide><textarea className="mono" value={text} placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }\n  }\n}'} onChange={(event) => setText(event.target.value)} /></Field></div>
    </Modal>
  );
}

export function parseMcpImport(text: string, level: CapabilityLevel, projectPath: string | null): McpServerInput[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Configuration is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration must be a JSON object");
  const root = parsed as Record<string, unknown>;
  const source = root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers) ? root.mcpServers as Record<string, unknown> : root;
  const inputs: McpServerInput[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const command = typeof row.command === "string" ? row.command : undefined;
    const url = typeof row.url === "string" ? row.url : undefined;
    if (!command && !url) continue;
    inputs.push({
      id: slug(name) || `server-${inputs.length + 1}`,
      label: typeof row.label === "string" ? row.label : name,
      description: typeof row.description === "string" ? row.description : undefined,
      transport: url ? "http" : "stdio",
      command,
      args: Array.isArray(row.args) ? row.args.filter((item): item is string => typeof item === "string") : undefined,
      env: stringRecord(row.env),
      url,
      headers: stringRecord(row.headers),
      enabled: row.disabled !== true,
      level,
      projectPath: level === "project" ? projectPath ?? undefined : undefined,
    });
  }
  if (!inputs.length) throw new Error("No MCP servers found in this configuration");
  return inputs;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}
function upsertStatus(statuses: McpServerStatus[], next: McpServerStatus): McpServerStatus[] { return [...statuses.filter((status) => status.serverId !== next.serverId), next]; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48); }
function capitalize(value: string): string { return value.slice(0, 1).toUpperCase() + value.slice(1); }
function projectName(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() ?? path; }
