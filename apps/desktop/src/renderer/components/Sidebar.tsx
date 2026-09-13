import type { SessionMeta } from "@senastr/shared";

interface Props {
  sessions: SessionMeta[];
  activeId: string | null;
  busy: boolean;
  version: string;
  view: "chat" | "settings";
  onNewSession: () => void;
  onOpenProject: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
  onChat: () => void;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">s</div>
        <div>
          <div className="brand-name">senastr</div>
          <div className="brand-sub">local-first coding agent</div>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="btn primary" onClick={p.onNewSession} disabled={p.busy}>
          + New session
        </button>
        <button className="btn" onClick={p.onOpenProject} disabled={p.busy}>
          Open project…
        </button>
      </div>

      <div className="session-list">
        {p.sessions.length === 0 && <div className="empty">No sessions yet</div>}
        {p.sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === p.activeId ? "active" : ""}`}
            onClick={() => p.onSelect(s.id)}
          >
            <div className="session-title">{s.title}</div>
            <div className="session-meta">
              {s.projectPath ? (
                <span className="session-project" title={s.projectPath}>
                  {s.projectPath.split("/").filter(Boolean).pop()}
                </span>
              ) : (
                <span className="session-noproj">no project</span>
              )}
              <span>{relTime(s.updatedAt)}</span>
            </div>
            <button
              className="session-delete"
              title="Delete session"
              onClick={(e) => {
                e.stopPropagation();
                p.onDelete(s.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <button className={`btn ghost ${p.view === "settings" ? "primary" : ""}`} onClick={p.onSettings}>
          Settings
        </button>
        {p.view === "settings" && (
          <button className="btn ghost" onClick={p.onChat}>
            Back to chat
          </button>
        )}
        {p.version && <div className="version">v{p.version}</div>}
      </div>
    </aside>
  );
}
