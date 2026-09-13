import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScheduleCadence, ScheduledRun, ScheduledTask, ScheduledTaskInput } from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import { EmptyState, Field, IconButton, Modal, Toggle } from "./SettingsPrimitives";

const CADENCES: Array<{ value: ScheduleCadence; label: string; hint: string }> = [
  { value: "manual", label: "Manual", hint: "Only runs when you trigger it" },
  { value: "hourly", label: "Hourly", hint: "At the top of every hour" },
  { value: "daily", label: "Daily", hint: "Once a day, same time as created" },
  { value: "weekly", label: "Weekly", hint: "Once a week, same weekday and time" },
  { value: "cron", label: "Cron", hint: "Custom 5-field expression" },
];

export function ScheduledSettings({ store }: { store: SenastrStore }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<ScheduledTask | "new" | null>(null);
  const [runsFor, setRunsFor] = useState<ScheduledTask | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await api.scheduled.list());
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setLoading(false);
    }
  }, [store.pushNotice]);

  useEffect(() => { void load(); }, [load]);

  // The scheduler ticker lives in main; refresh when it reports a run.
  useEffect(() => {
    const off = api.onEvent((ev) => {
      if ("kind" in ev && (ev.kind === "scheduled/started" || ev.kind === "scheduled/finished")) {
        void load();
      }
    });
    return off;
  }, [load]);

  const toggle = async (task: ScheduledTask) => {
    setBusy(task.id);
    setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, enabled: !task.enabled } : t)));
    try {
      await api.scheduled.setEnabled(task.id, !task.enabled);
    } catch (error) {
      setTasks((list) => list.map((t) => (t.id === task.id ? task : t)));
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (task: ScheduledTask) => {
    if (confirmDelete !== task.id) {
      setConfirmDelete(task.id);
      window.setTimeout(() => setConfirmDelete((v) => (v === task.id ? null : v)), 3000);
      return;
    }
    setBusy(task.id);
    try {
      await api.scheduled.delete(task.id);
      await load();
      store.pushNotice(`“${task.title}” removed`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  const trigger = async (task: ScheduledTask) => {
    setBusy(task.id);
    try {
      await api.scheduled.trigger(task.id);
      store.pushNotice(`“${task.title}” started`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-page-stack capability-page">
      <div className="capability-intro">
        <p>Scheduled tasks run agent turns headlessly on a cadence — nightly reviews, dependency checks, status digests.</p>
        <span>Runs reuse one session per task and appear in the session list.</span>
      </div>
      <div className="capability-toolbar">
        <div className="settings-segments">
          <button type="button" className="active">All <span>{tasks.length}</span></button>
        </div>
        <span className="capability-toolbar-spacer" />
        <button type="button" className="settings-primary-btn" onClick={() => setEditor("new")}><SettingsIcon name="plus" size={14} /> New task</button>
      </div>
      <div className={`settings-card capability-panel ${loading ? "loading" : ""}`}>
        {loading ? (
          <div className="capability-loading"><SettingsIcon name="refresh" size={16} className="spin" /> Loading scheduled tasks…</div>
        ) : !tasks.length ? (
          <div className="capability-group-empty">No scheduled tasks yet.</div>
        ) : (
          <div className="capability-group">
            {tasks.map((task) => (
              <div className={`capability-row ${task.enabled ? "" : "off"}`} key={task.id}>
                <span className={`capability-glyph status-${task.lastStatus ?? "idle"}`}><SettingsIcon name="terminal" size={16} /></span>
                <div className="capability-copy">
                  <div>
                    <strong>{task.title}</strong>
                    <span className="settings-badge">{task.cadence}{task.cadence === "cron" && task.cron ? ` · ${task.cron}` : ""}</span>
                    {task.lastStatus ? <span className={`settings-badge ${task.lastStatus === "done" ? "ok" : task.lastStatus === "error" ? "warning" : ""}`}>{task.lastStatus}</span> : null}
                  </div>
                  <p>
                    {shortPath(task.projectPath)} · {task.providerId}:{task.model}
                    {task.nextRunAt ? ` · next ${formatWhen(task.nextRunAt)}` : task.enabled ? " · next run pending" : " · paused"}
                    {task.lastRunAt ? ` · last ${formatWhen(task.lastRunAt)}` : ""}
                  </p>
                </div>
                <div className="capability-actions">
                  <IconButton icon="test" label="Run now" disabled={busy === task.id} onClick={() => void trigger(task)} />
                  <IconButton icon="info" label="View runs" disabled={busy === task.id} onClick={() => setRunsFor(task)} />
                  <IconButton icon="edit" label="Edit task" disabled={busy === task.id} onClick={() => setEditor(task)} />
                  {confirmDelete === task.id
                    ? <button type="button" className="settings-confirm-delete" onClick={() => void remove(task)}>Delete?</button>
                    : <IconButton icon="trash" label="Delete task" danger disabled={busy === task.id} onClick={() => void remove(task)} />}
                  <Toggle checked={task.enabled} disabled={busy === task.id} label={`${task.enabled ? "Disable" : "Enable"} ${task.title}`} onChange={() => void toggle(task)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {!loading && !tasks.length ? <EmptyState icon="terminal" title="Automate recurring agent work" description="Create a task with a prompt, project, and cadence — senastr runs it even while you do something else." /> : null}
      {editor ? <TaskEditor
        task={editor === "new" ? null : editor}
        providers={store.providers}
        defaultProject={store.activeSession?.projectPath ?? null}
        onClose={() => setEditor(null)}
        onSaved={async (title) => { setEditor(null); await load(); store.pushNotice(`“${title}” saved`, "info"); }}
        onError={(message) => store.pushNotice(message, "error")}
      /> : null}
      {runsFor ? <RunsModal task={runsFor} onClose={() => setRunsFor(null)} /> : null}
    </div>
  );
}

function TaskEditor({ task, providers, defaultProject, onClose, onSaved, onError }: {
  task: ScheduledTask | null;
  providers: SenastrStore["providers"];
  defaultProject: string | null;
  onClose: () => void;
  onSaved: (title: string) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [projectPath, setProjectPath] = useState(task?.projectPath ?? defaultProject ?? "");
  const [cadence, setCadence] = useState<ScheduleCadence>(task?.cadence ?? "daily");
  const [cron, setCron] = useState(task?.cron ?? "0 9 * * *");
  const [modelValue, setModelValue] = useState(task ? `${task.providerId}:${task.model}` : "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const modelOptions = useMemo(
    () =>
      providers
        .filter((p) => p.enabled && p.models.length > 0)
        .flatMap((p) => p.models.map((m) => ({ value: `${p.id}:${m}`, label: `${p.label} · ${m}` }))),
    [providers],
  );
  const canSave = title.trim() && prompt.trim() && projectPath.trim() && modelValue && (cadence !== "cron" || cron.trim());

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const [providerId, ...rest] = modelValue.split(":");
    const input: ScheduledTaskInput = {
      id: task?.id,
      title: title.trim(),
      prompt: prompt.trim(),
      projectPath: projectPath.trim(),
      providerId,
      model: rest.join(":"),
      cadence,
      cron: cadence === "cron" ? cron.trim() : undefined,
      enabled,
    };
    try {
      const saved = await api.scheduled.set(input);
      onSaved(saved.title);
    } catch (error) {
      onError(cleanError(error));
      setSaving(false);
    }
  };

  return (
    <Modal title={task ? "Edit scheduled task" : "New scheduled task"} subtitle="Runs headlessly on its cadence and notifies you when done." wide onClose={onClose} footer={<><span className="modal-scope-note"><SettingsIcon name="folder" size={14} /> {projectPath || "Pick the project this task runs in"}</span><div><button type="button" className="settings-ghost-btn" onClick={onClose}>Cancel</button><button type="button" className="settings-primary-btn" disabled={!canSave || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save task"}</button></div></>}>
      <div className="skill-editor-grid">
        <Field label="Title"><input autoFocus value={title} placeholder="e.g. Nightly test run" onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Cadence">
          <select value={cadence} onChange={(e) => setCadence(e.target.value as ScheduleCadence)}>
            {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label} — {c.hint}</option>)}
          </select>
        </Field>
        {cadence === "cron" ? (
          <Field label="Cron expression" hint="5 fields: minute hour day-of-month month day-of-week." wide>
            <input value={cron} spellCheck={false} placeholder="0 9 * * *" onChange={(e) => setCron(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Project folder" hint="Absolute path the task runs in." wide>
          <input value={projectPath} spellCheck={false} placeholder="/path/to/project" onChange={(e) => setProjectPath(e.target.value)} />
        </Field>
        <Field label="Model" wide>
          <select value={modelValue} onChange={(e) => setModelValue(e.target.value)}>
            <option value="">Select a model…</option>
            {modelOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Prompt" hint="The full instruction the agent runs each time." wide>
          <textarea className="skill-content-editor" spellCheck={false} value={prompt} placeholder="Run the test suite and summarize failures…" onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <label className="editor-toggle-row"><Toggle checked={enabled} label="Enable task" onChange={() => setEnabled((v) => !v)} /><span><strong>Enabled</strong><small>Disabled tasks never fire automatically.</small></span></label>
      </div>
    </Modal>
  );
}

function RunsModal({ task, onClose }: { task: ScheduledTask; onClose: () => void }) {
  const [runs, setRuns] = useState<ScheduledRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.scheduled
      .runs({ taskId: task.id })
      .then((rows) => { if (!cancelled) setRuns(rows); })
      .catch((err) => { if (!cancelled) setError(cleanError(err)); });
    return () => { cancelled = true; };
  }, [task.id]);
  return (
    <Modal title={`Runs — ${task.title}`} subtitle="Newest first. Each run reuses this task's session." onClose={onClose} footer={<div><button type="button" className="settings-ghost-btn" onClick={onClose}>Close</button></div>}>
      {error ? <p className="settings-error">{error}</p>
        : runs === null ? <div className="capability-loading"><SettingsIcon name="refresh" size={16} className="spin" /> Loading runs…</div>
        : !runs.length ? <div className="capability-group-empty">No runs recorded yet.</div>
        : (
          <div className="runs-list">
            {runs.map((r) => (
              <div className="run-row" key={r.id}>
                <span className={`settings-badge ${r.status === "done" ? "ok" : r.status === "error" ? "warning" : ""}`}>{r.status}</span>
                <div>
                  <strong>{new Date(r.startedAt).toLocaleString()}</strong>
                  <p>{r.error ?? r.summary ?? (r.endedAt ? `Took ${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s` : "In progress")}</p>
                </div>
              </div>
            ))}
          </div>
        )}
    </Modal>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function formatWhen(at: number): string {
  const d = new Date(at);
  const now = Date.now();
  if (at > now - 60_000 && at < now + 3_600_000) {
    const mins = Math.round((at - now) / 60_000);
    if (mins <= 0) return "now";
    return `in ${mins}m`;
  }
  return d.toLocaleString();
}
