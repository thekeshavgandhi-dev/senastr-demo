import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryEntry, MemoryIndex, MemoryScope } from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import { EmptyState, Field, IconButton, Modal } from "./SettingsPrimitives";

/**
 * Durable memory browser.
 *
 * Memory is plain Markdown under the host data directory, and the agent reads
 * and writes it with the `memory` tool. This panel exists so the user can see
 * exactly what the agent decided to remember — and delete what it should not
 * have. No hidden state: everything here is a file they can open.
 */
export function MemorySettings({ store }: { store: SenastrStore }) {
  const projectPath = store.activeSession?.projectPath ?? null;
  const [indexes, setIndexes] = useState<MemoryIndex[]>([]);
  const [scope, setScope] = useState<MemoryScope | "all">(projectPath ? "all" : "global");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<{ scope: MemoryScope; entry: MemoryEntry } | null>(null);
  const [composer, setComposer] = useState(false);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setIndexes(await api.memory.list({ projectPath }));
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setLoading(false);
    }
  }, [projectPath, store.pushNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const out: Array<{ scope: MemoryScope; entry: MemoryEntry }> = [];
    for (const index of indexes) {
      if (scope !== "all" && index.scope !== scope) continue;
      for (const entry of index.entries) {
        if (needle && !`${entry.key} ${entry.summary ?? ""} ${entry.content}`.toLowerCase().includes(needle)) continue;
        out.push({ scope: index.scope, entry });
      }
    }
    return out.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);
  }, [indexes, scope, search]);

  const forget = async (row: { scope: MemoryScope; entry: MemoryEntry }) => {
    const key = `${row.scope}:${row.entry.key}`;
    if (confirmForget !== key) {
      setConfirmForget(key);
      window.setTimeout(() => setConfirmForget((value) => (value === key ? null : value)), 3000);
      return;
    }
    setBusy(key);
    try {
      await api.memory.forget({ key: row.entry.key, projectPath, scope: row.scope });
      await load();
      store.pushNotice(`Forgot "${row.entry.key}"`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
      setConfirmForget(null);
    }
  };

  const totalChars = indexes.reduce((sum, index) => sum + index.size, 0);

  return (
    <div className="settings-page-stack capability-page">
      <div className="capability-intro">
        <p>Durable memory persists across sessions: decisions, conventions, gotchas and root causes the agent judged worth keeping.</p>
        <span>
          Stored as Markdown under the host data directory and injected into every turn. The agent writes it with the
          {" "}<code>memory</code> tool; you can read, edit or delete any of it here. Secrets are scrubbed before anything is saved.
        </span>
      </div>
      <div className="capability-toolbar">
        <div className="settings-segments">
          {(["all", "project", "global"] as Array<MemoryScope | "all">).map((item) => (
            <button
              type="button"
              key={item}
              className={scope === item ? "active" : ""}
              onClick={() => setScope(item)}
            >
              {item === "all" ? "All" : item === "project" ? "Project" : "Global"}{" "}
              <span>{item === "all" ? rows.length : rows.filter((row) => row.scope === item).length}</span>
            </button>
          ))}
        </div>
        <div className="capability-search">
          <SettingsIcon name="search" size={14} />
          <input value={search} placeholder="Search memory" onChange={(event) => setSearch(event.target.value)} />
          {search ? (
            <button type="button" onClick={() => setSearch("")}>
              <SettingsIcon name="x" size={13} />
            </button>
          ) : null}
        </div>
        <button type="button" className="settings-primary-btn" onClick={() => setComposer(true)}>
          <SettingsIcon name="plus" size={14} /> New note
        </button>
      </div>

      <div className={`settings-card capability-panel ${loading ? "loading" : ""}`}>
        {loading ? (
          <div className="capability-loading">
            <SettingsIcon name="refresh" size={16} className="spin" /> Loading memory…
          </div>
        ) : rows.length ? (
          <div className="capability-group">
            <div className="capability-group-head">
              <div>
                <span>Entries</span>
                <code>
                  {indexes[0]?.dir ? `${indexes[0].dir.replace(/\/memory$/, "/memory")}` : "host data / memory"}
                </code>
              </div>
              <b>{rows.length}</b>
            </div>
            {rows.map((row) => {
              const key = `${row.scope}:${row.entry.key}`;
              return (
                <div className="capability-row" key={key}>
                  <span className="capability-glyph">
                    <SettingsIcon name="book" size={16} />
                  </span>
                  <div className="capability-copy">
                    <div>
                      <strong>{row.entry.key}</strong>
                      <span className="settings-badge">{row.scope}</span>
                      <span className="settings-badge subtle">{row.entry.target}</span>
                    </div>
                    <p>{row.entry.summary || row.entry.content.slice(0, 160) || "No summary"}</p>
                    <p className="capability-path">
                      {new Date(row.entry.updatedAt).toLocaleString()} · {row.entry.size} chars
                    </p>
                  </div>
                  <div className="capability-actions">
                    <IconButton icon="edit" label="Open note" disabled={busy === key} onClick={() => setOpen(row)} />
                    {confirmForget === key ? (
                      <button type="button" className="settings-confirm-delete" onClick={() => void forget(row)}>
                        Forget?
                      </button>
                    ) : (
                      <IconButton
                        icon="trash"
                        label="Forget note"
                        danger
                        disabled={busy === key}
                        onClick={() => void forget(row)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="capability-group-empty">
            {search ? "No memory matches this search." : "Nothing remembered yet — the agent writes notes here as it learns."}
          </div>
        )}
      </div>

      {!loading && !rows.length ? (
        <EmptyState
          icon="book"
          title="Memory starts empty on purpose"
          description="Only what the agent (or you) explicitly records is kept. Add a note for anything the next session should not have to rediscover."
        />
      ) : null}

      {totalChars > 0 ? (
        <div className="capability-footnote">
          {rows.length} entr{rows.length === 1 ? "y" : "ies"} · {totalChars.toLocaleString()} characters stored
        </div>
      ) : null}

      {open ? (
        <NoteViewer
          title={open.entry.key}
          scope={open.scope}
          content={open.entry.content}
          onClose={() => setOpen(null)}
          onSaved={async () => {
            setOpen(null);
            await load();
          }}
          projectPath={projectPath}
          onError={(message) => store.pushNotice(message, "error")}
        />
      ) : null}

      {composer ? (
        <NoteComposer
          projectPath={projectPath}
          onClose={() => setComposer(false)}
          onSaved={async () => {
            setComposer(false);
            await load();
            store.pushNotice("Memory note saved", "info");
          }}
          onError={(message) => store.pushNotice(message, "error")}
        />
      ) : null}
    </div>
  );
}

function NoteViewer({
  title,
  scope,
  content,
  projectPath,
  onClose,
  onSaved,
  onError,
}: {
  title: string;
  scope: MemoryScope;
  content: string;
  projectPath: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.memory.write({ key: title, content: draft, scope, projectPath, mode: "replace" });
      await onSaved();
    } catch (error) {
      onError(cleanError(error));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={title}
      subtitle={`${scope} memory · Markdown`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="modal-scope-note">
            <SettingsIcon name={scope === "global" ? "globe" : "folder"} size={14} /> {scope} scope
          </span>
          <div>
            <button type="button" className="settings-ghost-btn" onClick={onClose}>
              Close
            </button>
            <button type="button" className="settings-primary-btn" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </>
      }
    >
      <div className="skill-editor-grid">
        <Field label="Note (Markdown)" wide>
          <textarea
            className="skill-content-editor"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function NoteComposer({
  projectPath,
  onClose,
  onSaved,
  onError,
}: {
  projectPath: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<MemoryScope>(projectPath ? "project" : "global");
  const [saving, setSaving] = useState(false);
  const canSave = key.trim() && content.trim() && (scope === "global" || projectPath);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await api.memory.write({ key: key.trim(), content, scope, projectPath, mode: "replace" });
      await onSaved();
    } catch (error) {
      onError(cleanError(error));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="New memory note"
      subtitle="One topic per note, keyed by a slug. Lead with the conclusion."
      onClose={onClose}
      footer={
        <>
          <span className="modal-scope-note">
            <SettingsIcon name={scope === "global" ? "globe" : "folder"} size={14} />{" "}
            {scope === "global" ? "Available in every project" : "Only this project"}
          </span>
          <div>
            <button type="button" className="settings-ghost-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="settings-primary-btn" disabled={!canSave || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </>
      }
    >
      <div className="skill-editor-grid">
        <Field label="Topic key">
          <input
            autoFocus
            value={key}
            placeholder="e.g. auth-flow"
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <Field label="Scope">
          <select value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)}>
            <option value="project" disabled={!projectPath}>
              Current project
            </option>
            <option value="global">Global</option>
          </select>
        </Field>
        <Field label="Note (Markdown)" wide>
          <textarea
            className="skill-content-editor"
            spellCheck={false}
            value={content}
            placeholder="Conclusion first, then the reasoning and the evidence (paths, commands, versions)."
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
