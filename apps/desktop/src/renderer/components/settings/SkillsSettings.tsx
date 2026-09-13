import { useCallback, useEffect, useMemo, useState } from "react";
import type { CapabilityLevel, SkillInput, SkillRecord } from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import { EmptyState, Field, IconButton, Modal, Toggle } from "./SettingsPrimitives";

type Filter = "all" | CapabilityLevel;

export function SkillsSettings({ store }: { store: SenastrStore }) {
  const projectPath = store.activeSession?.projectPath ?? null;
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillRecord | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await api.skill.list(projectPath ? { projectPath } : {}));
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setLoading(false);
    }
  }, [projectPath, store.pushNotice]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return skills.filter((skill) =>
      (filter === "all" || skill.level === filter) &&
      (!query || `${skill.name} ${skill.id} ${skill.description ?? ""}`.toLowerCase().includes(query)),
    );
  }, [filter, search, skills]);
  const global = visible.filter((skill) => skill.level === "global");
  const project = visible.filter((skill) => skill.level === "project");

  const toggle = async (skill: SkillRecord) => {
    setBusy(skillKey(skill));
    setSkills((rows) => rows.map((row) => skillKey(row) === skillKey(skill) ? { ...row, enabled: !skill.enabled } : row));
    try {
      await api.skill.setEnabled({
        id: skill.id,
        enabled: !skill.enabled,
        level: skill.level,
        projectPath: skill.projectPath,
      });
      store.pushNotice(`${skill.name} ${skill.enabled ? "disabled" : "enabled"}`, "info");
    } catch (error) {
      setSkills((rows) => rows.map((row) => skillKey(row) === skillKey(skill) ? skill : row));
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (skill: SkillRecord) => {
    const key = skillKey(skill);
    if (confirmDelete !== key) {
      setConfirmDelete(key);
      window.setTimeout(() => setConfirmDelete((value) => value === key ? null : value), 3000);
      return;
    }
    setBusy(key);
    try {
      await api.skill.delete({ id: skill.id, level: skill.level, projectPath: skill.projectPath });
      await load();
      store.pushNotice(`${skill.name} removed`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  const renderGroup = (label: string, path: string, rows: SkillRecord[], level: CapabilityLevel) => (
    <div className="capability-group" key={level}>
      <div className="capability-group-head">
        <div><span>{label}</span><code>{path}</code></div><b>{rows.length}</b>
      </div>
      {!rows.length ? (
        <div className="capability-group-empty">
          {search ? "No skills match this search." : level === "project" && !projectPath ? "Open a project to manage project skills." : "No skills at this level."}
        </div>
      ) : rows.map((skill) => {
        const key = skillKey(skill);
        return (
          <div className={`capability-row ${skill.enabled ? "" : "off"}`} key={key}>
            <span className="capability-glyph"><SettingsIcon name="book" size={16} /></span>
            <div className="capability-copy">
              <div><strong>{skill.name}</strong><span className="settings-badge">{skill.level}</span></div>
              <p>{skill.description || "No description"}</p>
            </div>
            <div className="capability-actions">
              <IconButton icon="edit" label="Edit skill" disabled={busy === key} onClick={() => setEditor(skill)} />
              {confirmDelete === key ? <button type="button" className="settings-confirm-delete" onClick={() => void remove(skill)}>Delete?</button> : <IconButton icon="trash" label="Delete skill" danger disabled={busy === key} onClick={() => void remove(skill)} />}
              <Toggle checked={skill.enabled} disabled={busy === key} label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} onChange={() => void toggle(skill)} />
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="settings-page-stack capability-page">
      <div className="capability-intro">
        <p>Skills are reusable Markdown instruction packs that guide the agent for a workflow, framework, or project convention.</p>
        <span>Project skills are loaded after global skills and only for their matching project.</span>
      </div>
      <div className="capability-toolbar">
        <div className="settings-segments">
          {(["all", "global", "project"] as Filter[]).map((item) => <button type="button" key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{capitalize(item)} <span>{item === "all" ? skills.length : skills.filter((skill) => skill.level === item).length}</span></button>)}
        </div>
        <div className="capability-search"><SettingsIcon name="search" size={14} /><input value={search} placeholder="Search skills" onChange={(event) => setSearch(event.target.value)} />{search ? <button type="button" onClick={() => setSearch("")}><SettingsIcon name="x" size={13} /></button> : null}</div>
        <button type="button" className="settings-primary-btn" onClick={() => setEditor("new")}><SettingsIcon name="plus" size={14} /> New skill</button>
      </div>
      <div className={`settings-card capability-panel ${loading ? "loading" : ""}`}>
        {loading ? <div className="capability-loading"><SettingsIcon name="refresh" size={16} className="spin" /> Loading skills…</div> : <>
          {filter !== "project" ? renderGroup("Global", store.dataDir ? `${store.dataDir}/skills.json` : "host data / skills.json", global, "global") : null}
          {filter !== "global" ? renderGroup("Project", projectPath ? `scope: ${projectPath}` : "scope: <open project>", project, "project") : null}
        </>}
      </div>
      {!loading && !skills.length ? <EmptyState icon="book" title="Teach senastr a repeatable workflow" description="Add a skill with the instructions you want applied during agent turns." /> : null}
      {editor ? <SkillEditor
        skill={editor === "new" ? null : editor}
        projectPath={projectPath}
        initialLevel={filter === "project" ? "project" : "global"}
        onClose={() => setEditor(null)}
        onSaved={async (name) => { setEditor(null); await load(); store.pushNotice(`${name} saved`, "info"); }}
        onError={(message) => store.pushNotice(message, "error")}
      /> : null}
    </div>
  );
}

function SkillEditor({ skill, projectPath, initialLevel, onClose, onSaved, onError }: {
  skill: SkillRecord | null;
  projectPath: string | null;
  initialLevel: CapabilityLevel;
  onClose: () => void;
  onSaved: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "# Instructions\n\nDescribe when and how the agent should apply this skill.\n");
  const [level, setLevel] = useState<CapabilityLevel>(skill?.level ?? initialLevel);
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const canSave = name.trim() && content.trim() && (level === "global" || projectPath);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const input: SkillInput = {
      id: skill?.id,
      name: name.trim(),
      description: description.trim() || undefined,
      content,
      enabled,
      level,
      projectPath: level === "project" ? projectPath! : undefined,
    };
    try {
      const saved = await api.skill.set(input);
      onSaved(saved.name);
    } catch (error) {
      onError(cleanError(error));
      setSaving(false);
    }
  };

  return (
    <Modal title={skill ? "Edit skill" : "Create skill"} subtitle="Skills are inserted into the system prompt only while enabled and in scope." wide onClose={onClose} footer={<><span className="modal-scope-note"><SettingsIcon name={level === "global" ? "globe" : "folder"} size={14} /> {level === "global" ? "Available in every project" : projectPath ? `Only ${projectName(projectPath)}` : "Open a project first"}</span><div><button type="button" className="settings-ghost-btn" onClick={onClose}>Cancel</button><button type="button" className="settings-primary-btn" disabled={!canSave || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save skill"}</button></div></>}>
      <div className="skill-editor-grid">
        <Field label="Name"><input autoFocus value={name} placeholder="e.g. React review" onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Level"><select value={level} disabled={Boolean(skill)} onChange={(event) => setLevel(event.target.value as CapabilityLevel)}><option value="global">Global</option><option value="project" disabled={!projectPath}>Current project</option></select></Field>
        <Field label="Description" wide><input value={description} placeholder="When should the agent use this skill?" onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="Instructions (Markdown)" wide><textarea className="skill-content-editor" spellCheck={false} value={content} onChange={(event) => setContent(event.target.value)} /></Field>
        <label className="editor-toggle-row"><Toggle checked={enabled} label="Enable skill" onChange={() => setEnabled((value) => !value)} /><span><strong>Enabled</strong><small>Include this skill in matching agent sessions.</small></span></label>
      </div>
    </Modal>
  );
}

function skillKey(skill: SkillRecord): string { return `${skill.level}:${skill.projectPath ?? ""}:${skill.id}`; }
function capitalize(value: string): string { return value.slice(0, 1).toUpperCase() + value.slice(1); }
function projectName(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() ?? path; }
