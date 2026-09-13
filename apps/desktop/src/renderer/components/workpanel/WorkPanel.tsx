import { useMemo, useState } from "react";
import type { ChatMessage, ToolCall } from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { toolMessageToResult } from "../../hooks/useSenastr";
import { IconDiff, IconFile, IconInfo, IconX } from "../icons";
import { TooltipButton, cx } from "../ui";

interface EditEntry {
  call: ToolCall;
  ok: boolean | null;
  at: number;
  messageId: string;
}

function collectEdits(messages: ChatMessage[]): EditEntry[] {
  const toolByCall = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) toolByCall.set(m.toolCallId, m);
  }
  const edits: EditEntry[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      if (call.name !== "write_file") continue;
      const result = toolMessageToResult(toolByCall.get(call.id));
      edits.push({ call, ok: result ? result.ok : null, at: m.createdAt, messageId: m.id });
    }
  }
  return edits.reverse();
}

function collectFiles(messages: ChatMessage[]): Array<{ path: string; reads: number; writes: number }> {
  const map = new Map<string, { reads: number; writes: number }>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      const a = (call.arguments ?? {}) as Record<string, unknown>;
      const p = a.path ?? a.file;
      if (typeof p !== "string" || !p) continue;
      if (call.name !== "read_file" && call.name !== "write_file") continue;
      const entry = map.get(p) ?? { reads: 0, writes: 0 };
      if (call.name === "read_file") entry.reads += 1;
      else entry.writes += 1;
      map.set(p, entry);
    }
  }
  return [...map.entries()]
    .map(([path, counts]) => ({ path, ...counts }))
    .sort((a, b) => b.writes - a.writes || b.reads - a.reads);
}

const TABS = [
  { id: "review", label: "Review", icon: IconDiff },
  { id: "files", label: "Files", icon: IconFile },
  { id: "details", label: "Details", icon: IconInfo },
];

export function WorkPanel({ store }: { store: SenastrStore }) {
  const session = store.activeSession;
  const tab = store.workPanelTab;
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]); // eslint-disable-line react-hooks/exhaustive-deps
  const edits = useMemo(() => collectEdits(messages), [messages]);
  const files = useMemo(() => collectFiles(messages), [messages]);

  return (
    <aside className="work-panel" aria-label="Work panel">
      <div className="wp-head">
        <div className="wp-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={cx("wp-tab", tab === t.id && "active")}
              onClick={() => store.setWorkPanelTab(t.id)}
            >
              <t.icon size={13} />
              {t.label}
              {t.id === "review" && edits.length > 0 ? <span className="wp-badge">{edits.length}</span> : null}
            </button>
          ))}
        </div>
        <TooltipButton className="wp-close" tooltip="Close panel (Ctrl+J)" onClick={() => store.setWorkPanelOpen(false)}>
          <IconX size={14} />
        </TooltipButton>
      </div>
      <div className="wp-body">
        {!session ? (
          <div className="wp-empty">No active session</div>
        ) : tab === "review" ? (
          <ReviewTab edits={edits} />
        ) : tab === "files" ? (
          <FilesTab files={files} />
        ) : (
          <DetailsTab store={store} />
        )}
      </div>
    </aside>
  );
}

function ReviewTab({ edits }: { edits: EditEntry[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!edits.length) {
    return (
      <div className="wp-empty">
        <IconDiff size={22} />
        <p>No file writes in this session yet.</p>
        <small>Files the agent modifies will appear here for review.</small>
      </div>
    );
  }
  return (
    <div className="wp-list">
      {edits.map((e) => {
        const a = (e.call.arguments ?? {}) as Record<string, unknown>;
        const path = typeof a.path === "string" ? a.path : typeof a.file === "string" ? a.file : "(unknown path)";
        const content = typeof a.content === "string" ? a.content : "";
        const open = openId === e.call.id;
        return (
          <div key={e.call.id} className={cx("wp-card", e.ok === false && "fail")}>
            <button type="button" className="wp-card-head" onClick={() => setOpenId(open ? null : e.call.id)}>
              <span className={cx("wp-status", e.ok == null ? "running" : e.ok ? "ok" : "fail")} />
              <span className="wp-card-title" title={path}>
                {path.split(/[\\/]/).pop() || path}
              </span>
              <span className="wp-card-sub" title={path}>
                {path}
              </span>
            </button>
            {open && (
              <div className="wp-card-body">
                <pre>{content ? content.slice(0, 4000) + (content.length > 4000 ? "\n…(truncated)" : "") : "(no content captured)"}</pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FilesTab({ files }: { files: Array<{ path: string; reads: number; writes: number }> }) {
  if (!files.length) {
    return (
      <div className="wp-empty">
        <IconFile size={22} />
        <p>No files touched yet.</p>
        <small>Files the agent reads or writes will be listed here.</small>
      </div>
    );
  }
  return (
    <div className="wp-list">
      {files.map((f) => (
        <div key={f.path} className="wp-file" title={f.path}>
          <IconFile size={13} />
          <span className="wp-file-path">{f.path}</span>
          <span className="wp-file-counts">
            {f.writes > 0 ? <span className="w">{f.writes}w</span> : null}
            {f.reads > 0 ? <span className="r">{f.reads}r</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function DetailsTab({ store }: { store: SenastrStore }) {
  const s = store.activeSession;
  if (!s) return <div className="wp-empty">No active session</div>;
  const stats = store.contextStats;
  const sessionGrants = store.grants.filter((g) => g.sessionId === s.id || g.scope === "always");
  const mode = store.agentModeFor(s.id);
  const perm = store.permissionModeFor(s.id);
  const model = store.modelRef ? `${store.modelRef.providerId} · ${store.modelRef.model}` : "—";
  return (
    <div className="wp-details">
      <div className="wp-drow">
        <span>Project</span>
        <strong title={s.projectPath ?? ""}>{s.projectPath ?? "No project"}</strong>
      </div>
      <div className="wp-drow">
        <span>Model</span>
        <strong>{model}</strong>
      </div>
      <div className="wp-drow">
        <span>Agent mode</span>
        <strong className="cap">{mode}</strong>
      </div>
      <div className="wp-drow">
        <span>Permissions</span>
        <strong className="cap">{perm}</strong>
      </div>
      <div className="wp-drow">
        <span>Messages</span>
        <strong>{stats.messages}</strong>
      </div>
      <div className="wp-drow">
        <span>Est. tokens</span>
        <strong>~{stats.tokens.toLocaleString()}</strong>
      </div>
      <div className="wp-drow">
        <span>Tool calls</span>
        <strong>{stats.tools}</strong>
      </div>
      <div className="wp-drow">
        <span>Grants</span>
        <strong>{sessionGrants.length}</strong>
      </div>
      <div className="wp-drow">
        <span>Created</span>
        <strong>{new Date(s.createdAt).toLocaleString()}</strong>
      </div>
      <div className="wp-actions">
        <button type="button" className="btn" onClick={() => void store.forkSession(s.id)}>
          Fork session
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => store.updateSessionPrefs(s.id, { archived: !store.sessionPrefs[s.id]?.archived })}
        >
          {store.sessionPrefs[s.id]?.archived ? "Restore" : "Archive"}
        </button>
      </div>
    </div>
  );
}
