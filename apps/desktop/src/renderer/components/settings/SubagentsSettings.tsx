import { useCallback, useEffect, useMemo, useState } from "react";
import type { CapabilityLevel, SubagentInput, SubagentRecord } from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import { EmptyState, Field, IconButton, Modal, Toggle } from "./SettingsPrimitives";

type Filter = "all" | CapabilityLevel;

export function SubagentsSettings({ store }: { store: SenastrStore }) {
  const projectPath = store.activeSession?.projectPath ?? null;
  const [rows, setRows] = useState<SubagentRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<SubagentRecord | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.subagent.list(projectPath ? { projectPath } : {}));
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setLoading(false);
    }
  }, [projectPath, store.pushNotice]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((r) =>
      (filter === "all" || r.level === filter) &&
      (!query || `${r.name} ${r.id} ${r.description ?? ""}`.toLowerCase().includes(query)),
    );
  }, [filter, search, rows]);
  const global = visible.filter((r) => r.level === "global");
  const project = visible.filter((r) => r.level === "project");

  const toggle = async (row: SubagentRecord) => {
    const key = rowKey(row);
    setBusy(key);
    setRows((list) => list.map((r) => (rowKey(r) === key ? { ...r, enabled: !row.enabled } : r)));
    try {
      await api.subagent.setEnabled({ id: row.id, enabled: !row.enabled, level: row.level, projectPath: row.projectPath });
      store.pushNotice(`${row.name} ${row.enabled ? "disabled" : "enabled"}`, "info");
    } catch (error) {
      setRows((list) => list.map((r) => (rowKey(r) === key ? row : r)));
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: SubagentRecord) => {
    const key = rowKey(row);
    if (confirmDelete !== key) {
      setConfirmDelete(key);
      window.setTimeout(() => setConfirmDelete((value) => (value === key ? null : value)), 3000);
      return;
    }
    setBusy(key);
    try {
      await api.subagent.delete({ id: row.id, level: row.level, projectPath: row.projectPath });
      await load();
      store.pushNotice(`${row.name} removed`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  const renderGroup = (label: string, path: string, items: SubagentRecord[], level: CapabilityLevel) => (
    <div className="capability-group" key={level}>
      <div className="capability-group-head">
        <div><span>{label}</span><code>{path}</code></div><b>{items.length}</b>
      </div>
      {!items.length ? (
        <div className="capability-group-empty">
          {search ? "No subagents match this search." : level === "project" && !projectPath ? "Open a project to manage project subagents." : "No subagents at this level."}
        </div>
      ) : items.map((row) => {
        const key = rowKey(row);
        return (
          <div className={`capability-row ${row.enabled ? "" : "off"}`} key={key}>
            <span className="capability-glyph"><SettingsIcon name="sparkles" size={16} /></span>
            <div className="capability-copy">
              <div>
                <strong>{row.name}</strong>
                <span className="settings-badge">{row.level}</span>
                {row.model ? <span className="settings-badge">{row.model.providerId}:{row.model.model}</span> : null}
              </div>
              <p>{row.description || "No description"}</p>
            </div>
            <div className="capability-actions">
              <IconButton icon="edit" label="Edit subagent" disabled={busy === key} onClick={() => setEditor(row)} />
              {confirmDelete === key ? <button type="button" className="settings-confirm-delete" onClick={() => void remove(row)}>Delete?</button> : <IconButton icon="trash" label="Delete subagent" danger disabled={busy === key} onClick={() => void remove(row)} />}
              <Toggle checked={row.enabled} disabled={busy === key} label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`} onChange={() => void toggle(row)} />
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="settings-page-stack capability-page">
      <div className="capability-intro">
        <p>Subagents are named delegate personalities the main agent can spawn with the Task tool for self-contained work.</p>
        <span>Disabled subagents stay saved but cannot be delegated to.</span>
      </div>
      <div className="capability-toolbar">
        <div className="settings-segments">
          {(["all", "global", "project"] as Filter[]).map((item) => <button type="button" key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{capitalize(item)} <span>{item === "all" ? rows.length : rows.filter((r) => r.level === item).length}</span></button>)}
        </div>
        <div className="capability-search"><SettingsIcon name="search" size={14} /><input value={search} placeholder="Search subagents" onChange={(event) => setSearch(event.target.value)} />{search ? <button type="button" onClick={() => setSearch("")}><SettingsIcon name="x" size={13} /></button> : null}</div>
        <button type="button" className="settings-primary-btn" onClick={() => setEditor("new")}><SettingsIcon name="plus" size={14} /> New subagent</button>
      </div>
      <div className={`settings-card capability-panel ${loading ? "loading" : ""}`}>
        {loading ? <div className="capability-loading"><SettingsIcon name="refresh" size={16} className="spin" /> Loading subagents…</div> : <>
          {filter !== "project" ? renderGroup("Global", store.dataDir ? `${store.dataDir}/subagents.json` : "host data / subagents.json", global, "global") : null}
          {filter !== "global" ? renderGroup("Project", projectPath ? `scope: ${projectPath}` : "scope: <open project>", project, "project") : null}
        </>}
      </div>
      {!loading && !rows.length ? <EmptyState icon="sparkles" title="Delegate work to specialists" description="Create a subagent with its own instructions and optional model, then the main agent can call it via the Task tool." /> : null}
      {editor ? <SubagentEditor
        row={editor === "new" ? null : editor}
        projectPath={projectPath}
        initialLevel={filter === "project" ? "project" : "global"}
        providers={store.providers}
        onClose={() => setEditor(null)}
        onSaved={async (name) => { setEditor(null); await load(); store.pushNotice(`${name} saved`, "info"); }}
        onError={(message) => store.pushNotice(message, "error")}
      /> : null}
    </div>
  );
}

function SubagentEditor({ row, projectPath, initialLevel, providers, onClose, onSaved, onError }: {
  row: SubagentRecord | null;
  projectPath: string | null;
  initialLevel: CapabilityLevel;
  providers: SenastrStore["providers"];
  onClose: () => void;
  onSaved: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(row?.systemPrompt ?? "You are a focused specialist. Complete the task, then report back concisely with what changed and what to verify.");
  const [level, setLevel] = useState<CapabilityLevel>(row?.level ?? initialLevel);
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [modelValue, setModelValue] = useState(
    row?.model ? `${row.model.providerId}:${row.model.model}` : "",
  );
  const [saving, setSaving] = useState(false);
  const canSave = name.trim() && systemPrompt.trim() && (level === "global" || projectPath);

  const modelOptions = providers
    .filter((p) => p.enabled && p.models.length > 0)
    .flatMap((p) => p.models.map((m) => ({ value: `${p.id}:${m}`, label: `${p.label} · ${m}` })));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const [providerId, ...rest] = modelValue.split(":");
    const input: SubagentInput = {
      id: row?.id,
      name: name.trim(),
      description: description.trim() || undefined,
      systemPrompt,
      model: modelValue ? { providerId, model: rest.join(":") } : null,
      enabled,
      level,
      projectPath: level === "project" ? projectPath! : undefined,
    };
    try {
      const saved = await api.subagent.set(input);
      onSaved(saved.name);
    } catch (error) {
      onError(cleanError(error));
      setSaving(false);
    }
  };

  return (
    <Modal title={row ? "Edit subagent" : "Create subagent"} subtitle="The main agent picks a subagent by name when it calls the Task tool." wide onClose={onClose} footer={<><span className="modal-scope-note"><SettingsIcon name={level === "global" ? "globe" : "folder"} size={14} /> {level === "global" ? "Available in every project" : projectPath ? `Only ${projectName(projectPath)}` : "Open a project first"}</span><div><button type="button" className="settings-ghost-btn" onClick={onClose}>Cancel</button><button type="button" className="settings-primary-btn" disabled={!canSave || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save subagent"}</button></div></>}>
      <div className="skill-editor-grid">
        <Field label="Name"><input autoFocus value={name} placeholder="e.g. explorer, reviewer, test-runner" onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Level"><select value={level} disabled={Boolean(row)} onChange={(event) => setLevel(event.target.value as CapabilityLevel)}><option value="global">Global</option><option value="project" disabled={!projectPath}>Current project</option></select></Field>
        <Field label="Description" hint="Shown to the main agent so it knows when to delegate." wide><input value={description} placeholder="Fast read-only exploration of unfamiliar code" onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="Model override" hint="Empty = inherit the main agent's model." wide>
          <select value={modelValue} onChange={(event) => setModelValue(event.target.value)}>
            <option value="">Inherit main model</option>
            {modelOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="System prompt" wide><textarea className="skill-content-editor" spellCheck={false} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} /></Field>
        <label className="editor-toggle-row"><Toggle checked={enabled} label="Enable subagent" onChange={() => setEnabled((value) => !value)} /><span><strong>Enabled</strong><small>Include this subagent in matching agent sessions.</small></span></label>
      </div>
    </Modal>
  );
}

function rowKey(row: SubagentRecord): string { return `${row.level}:${row.projectPath ?? ""}:${row.id}`; }
function capitalize(value: string): string { return value.slice(0, 1).toUpperCase() + value.slice(1); }
function projectName(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() ?? path; }
