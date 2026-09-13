import { useCallback, useEffect, useState } from "react";
import type { SenastrStore } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { SettingsIcon } from "./SettingsIcons";
import { Field } from "./SettingsPrimitives";

/**
 * Standing instructions + memory. Two layers, both injected into every turn:
 * global (applies everywhere) and per-project (applies only to that project).
 */
export function InstructionsSettings({ store }: { store: SenastrStore }) {
  const projectPath = store.activeSession?.projectPath ?? null;
  const [scope, setScope] = useState<"global" | "project">("project");
  const [instructions, setInstructions] = useState("");
  const [memory, setMemory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const effectiveScope = scope === "project" && !projectPath ? "global" : scope;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ctx = await api.projectCtx.getContext(effectiveScope === "project" ? projectPath : null);
      setInstructions(ctx.instructions ?? "");
      setMemory(ctx.memory ?? "");
      setDirty(false);
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setLoading(false);
    }
  }, [effectiveScope, projectPath, store.pushNotice]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await api.projectCtx.setContext({
        projectPath: effectiveScope === "project" ? projectPath : null,
        instructions,
        memory,
      });
      setDirty(false);
      store.pushNotice(`${effectiveScope === "project" ? "Project" : "Global"} instructions saved`, "info");
    } catch (error) {
      store.pushNotice(cleanError(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const edit = (which: "instructions" | "memory", value: string) => {
    if (which === "instructions") setInstructions(value);
    else setMemory(value);
    setDirty(true);
  };

  return (
    <div className="settings-page-stack capability-page">
      <div className="capability-intro">
        <p>Standing instructions are injected into every agent turn — conventions, constraints, and long-lived memory.</p>
        <span>Global applies everywhere; project applies only to the active project.</span>
      </div>
      <div className="capability-toolbar">
        <div className="settings-segments">
          <button type="button" className={effectiveScope === "global" ? "active" : ""} onClick={() => setScope("global")}>
            <SettingsIcon name="globe" size={13} /> Global
          </button>
          <button
            type="button"
            className={effectiveScope === "project" ? "active" : ""}
            disabled={!projectPath}
            title={projectPath ?? "Open a project to edit project instructions"}
            onClick={() => setScope("project")}
          >
            <SettingsIcon name="folder" size={13} /> {projectPath ? shortName(projectPath) : "Project"}
          </button>
        </div>
        <span className="capability-toolbar-spacer" />
        <button type="button" className="settings-primary-btn" disabled={!dirty || saving || loading} onClick={() => void save()}>
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
      </div>
      <div className={`settings-card capability-panel ${loading ? "loading" : ""}`}>
        {loading ? (
          <div className="capability-loading"><SettingsIcon name="refresh" size={16} className="spin" /> Loading…</div>
        ) : (
          <div className="skill-editor-grid">
            <Field
              label={effectiveScope === "project" ? "Project instructions" : "Global instructions"}
              hint="How the agent should work: stack, style, commands, things to never do."
              wide
            >
              <textarea
                className="skill-content-editor"
                spellCheck={false}
                value={instructions}
                placeholder={effectiveScope === "project" ? "e.g. This repo uses pnpm. Run `pnpm test` before finishing. Never commit without asking." : "e.g. Prefer TypeScript. Explain non-trivial changes briefly."}
                onChange={(e) => edit("instructions", e.target.value)}
              />
            </Field>
            <Field
              label={effectiveScope === "project" ? "Project memory" : "Global memory"}
              hint="Facts the agent should remember across sessions."
              wide
            >
              <textarea
                className="skill-content-editor short"
                spellCheck={false}
                value={memory}
                placeholder="e.g. API docs live in docs/api.md. Staging deploys on merge to main."
                onChange={(e) => edit("memory", e.target.value)}
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

function shortName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
