import { useMemo, useState } from "react";
import type { SessionMeta } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { isDefaultTitle, projectDisplayName, type SessionSort } from "../lib/prefs";
import {
  IconArchive,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFolderOpen,
  IconFork,
  IconMore,
  IconNewSession,
  IconPencil,
  IconPin,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTrash,
  IconX,
} from "./icons";
import { Menu, MenuHeading, MenuItem, MenuSeparator, TooltipButton, cx } from "./ui";
import { ProjectRenameDialog, SessionRenameDialog } from "./SessionRenameDialog";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString();
}

const SORT_LABEL: Record<SessionSort, string> = {
  recent: "Recent",
  name: "Name",
  created: "Created",
};

interface ProjectGroup {
  key: string;
  path: string | null;
  name: string;
  sessions: SessionMeta[];
  pinned: boolean;
}

export function Sidebar({ store }: { store: SenastrStore }) {
  const [filter, setFilter] = useState("");
  const [renameSession, setRenameSession] = useState<SessionMeta | null>(null);
  const [renameProject, setRenameProject] = useState<{ path: string; name: string } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const needle = filter.trim().toLowerCase();

  const { pinned, groups, archived } = useMemo(() => {
    const sp = store.sessionPrefs;
    const match = (s: SessionMeta) =>
      !needle ||
      s.title.toLowerCase().includes(needle) ||
      (s.projectPath ?? "").toLowerCase().includes(needle);

    const sortFn = (a: SessionMeta, b: SessionMeta) => {
      if (store.sessionSort === "name") return a.title.localeCompare(b.title);
      if (store.sessionSort === "created") return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    };

    const pinnedList = store.sessions.filter((s) => sp[s.id]?.pinned && !sp[s.id]?.archived && match(s)).sort(sortFn);
    const archivedList = store.sessions.filter((s) => sp[s.id]?.archived && match(s)).sort(sortFn);

    const byProject = new Map<string, SessionMeta[]>();
    for (const s of store.sessions) {
      if (sp[s.id]?.pinned || sp[s.id]?.archived) continue;
      if (!match(s)) continue;
      const key = s.projectPath ?? "";
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(s);
    }
    const list: ProjectGroup[] = [...byProject.entries()].map(([path, sessions]) => {
      const meta = path ? store.projectMeta[path] : undefined;
      return {
        key: path || "__none__",
        path: path || null,
        name: path ? projectDisplayName(path, meta) : "No project",
        sessions: sessions.sort(sortFn),
        pinned: Boolean(meta?.pinned),
      };
    });
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (!a.path) return 1;
      if (!b.path) return -1;
      return a.name.localeCompare(b.name);
    });
    return { pinned: pinnedList, groups: list, archived: archivedList };
  }, [store.sessions, store.sessionPrefs, store.projectMeta, store.sessionSort, needle]);

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sb-head">
        <div className="brand">
          <div className="brand-mark">s</div>
          <div className="brand-text">
            <div className="brand-name">senastr</div>
            <div className="brand-sub">local-first agent</div>
          </div>
        </div>
        <TooltipButton
          className="sb-icon-btn"
          tooltip="Collapse sidebar (Ctrl+B)"
          onClick={() => store.setSidebarCollapsed(true)}
        >
          <IconSidebar size={15} />
        </TooltipButton>
      </div>

      <div className="sb-actions">
        <button
          type="button"
          className="btn primary sb-new"
          disabled={store.busy}
          onClick={() => void store.newSession(store.activeSession?.projectPath ?? undefined)}
        >
          <IconNewSession size={14} />
          New task
        </button>
        <TooltipButton
          className="btn sb-icon-btn-lg"
          tooltip="Open project folder…"
          onClick={() => void store.openProject()}
        >
          <IconFolderOpen size={15} />
        </TooltipButton>
      </div>

      <div className="sb-filter">
        <IconSearch size={13} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          spellCheck={false}
        />
        {filter ? (
          <button type="button" className="sb-filter-clear" onClick={() => setFilter("")} aria-label="Clear filter">
            <IconX size={12} />
          </button>
        ) : null}
        <SortMenu store={store} />
      </div>

      <div className="sb-scroll">
        {pinned.length > 0 && (
          <div className="sb-section">
            <div className="sb-section-title">Pinned</div>
            {pinned.map((s) => (
              <SessionRow key={s.id} store={store} session={s} onRename={() => setRenameSession(s)} />
            ))}
          </div>
        )}

        {groups.map((g) => (
          <ProjectGroupView
            key={g.key}
            store={store}
            group={g}
            defaultOpen={Boolean(needle) || groups.length <= 4}
            onRenameSession={setRenameSession}
            onRenameProject={(path) =>
              path && setRenameProject({ path, name: projectDisplayName(path, store.projectMeta[path]) })
            }
          />
        ))}

        {pinned.length === 0 && groups.length === 0 && archived.length === 0 && (
          <div className="sb-empty">
            {needle ? "No sessions match" : "No sessions yet — start a new task above."}
          </div>
        )}

        {archived.length > 0 && (
          <div className="sb-section">
            <button type="button" className="sb-archived-toggle" onClick={() => setArchivedOpen((v) => !v)}>
              {archivedOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
              <IconArchive size={13} />
              Archived
              <span className="sb-count">{archived.length}</span>
            </button>
            {archivedOpen &&
              archived.map((s) => (
                <SessionRow key={s.id} store={store} session={s} onRename={() => setRenameSession(s)} archived />
              ))}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <button type="button" className="sb-foot-btn" onClick={() => store.setView("settings")}>
          <IconSettings size={14} />
          Settings
        </button>
        {store.version ? <span className="sb-version">v{store.version}</span> : null}
      </div>

      {renameSession && (
        <SessionRenameDialog
          initial={renameSession.title}
          onClose={() => setRenameSession(null)}
          onSave={(title) => {
            void store.renameSession(renameSession.id, title);
            setRenameSession(null);
          }}
        />
      )}
      {renameProject && (
        <ProjectRenameDialog
          initial={renameProject.name}
          path={renameProject.path}
          onClose={() => setRenameProject(null)}
          onSave={(name) => {
            store.updateProjectMeta(renameProject.path, { name });
            setRenameProject(null);
          }}
        />
      )}
    </aside>
  );
}

function SortMenu({ store }: { store: SenastrStore }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label="Sort sessions"
      align="end"
      open={open}
      onClose={() => setOpen(false)}
      trigger={(ref) => (
        <TooltipButton
          ref={ref as React.RefObject<HTMLButtonElement>}
          className="sb-sort-btn"
          tooltip={`Sort: ${SORT_LABEL[store.sessionSort]}`}
          onClick={() => setOpen((v) => !v)}
        >
          {SORT_LABEL[store.sessionSort][0]}
        </TooltipButton>
      )}
    >
      <MenuHeading>Sort sessions</MenuHeading>
      {(Object.keys(SORT_LABEL) as SessionSort[]).map((key) => (
        <MenuItem
          key={key}
          checked={store.sessionSort === key}
          icon={store.sessionSort === key ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
          onClick={() => {
            store.setSessionSort(key);
            setOpen(false);
          }}
        >
          {SORT_LABEL[key]}
        </MenuItem>
      ))}
    </Menu>
  );
}

function ProjectGroupView({
  store,
  group,
  defaultOpen,
  onRenameSession,
  onRenameProject,
}: {
  store: SenastrStore;
  group: ProjectGroup;
  defaultOpen: boolean;
  onRenameSession: (s: SessionMeta) => void;
  onRenameProject: (path: string | null) => void;
}) {
  const meta = group.path ? store.projectMeta[group.path] : undefined;
  const collapsed = group.path ? Boolean(meta?.collapsed) : false;
  const [menuOpen, setMenuOpen] = useState(false);
  const activeInGroup = group.sessions.some((s) => s.id === store.activeSession?.id);

  return (
    <div className={cx("sb-section", activeInGroup && "has-active")}>
      <div className="sb-group-head">
        <button
          type="button"
          className="sb-group-title"
          onClick={() => group.path && store.updateProjectMeta(group.path, { collapsed: !meta?.collapsed })}
          title={group.path ?? "Sessions without a project"}
        >
          {group.path ? (
            collapsed ? (
              <IconChevronRight size={13} />
            ) : (
              <IconChevronDown size={13} />
            )
          ) : (
            <span style={{ width: 13 }} />
          )}
          <span className="sb-group-name">{group.name}</span>
          <span className="sb-count">{group.sessions.length}</span>
        </button>
        {group.path ? (
          <Menu
            label="Project actions"
            align="end"
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            trigger={(ref) => (
              <TooltipButton
                ref={ref as React.RefObject<HTMLButtonElement>}
                className="sb-row-menu-btn"
                tooltip="Project actions"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
              >
                <IconMore size={14} />
              </TooltipButton>
            )}
          >
            <MenuItem
              icon={<IconNewSession size={13} />}
              onClick={() => {
                setMenuOpen(false);
                void store.newSession(group.path);
              }}
            >
              New task in project
            </MenuItem>
            <MenuItem
              icon={<IconPencil size={13} />}
              onClick={() => {
                setMenuOpen(false);
                onRenameProject(group.path);
              }}
            >
              Rename project…
            </MenuItem>
            <MenuItem
              icon={<IconPin size={13} />}
              checked={group.pinned}
              onClick={() => {
                setMenuOpen(false);
                if (group.path) store.updateProjectMeta(group.path, { pinned: !group.pinned });
              }}
            >
              {group.pinned ? "Unpin project" : "Pin project"}
            </MenuItem>
          </Menu>
        ) : null}
      </div>
      {(!collapsed || group.sessions.some((s) => s.id === store.activeSession?.id)) &&
        group.sessions.map((s) => (
          <SessionRow key={s.id} store={store} session={s} onRename={() => onRenameSession(s)} />
        ))}
    </div>
  );
}

function SessionRow({
  store,
  session,
  onRename,
  archived,
}: {
  store: SenastrStore;
  session: SessionMeta;
  onRename: () => void;
  archived?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const active = session.id === store.activeSession?.id;
  const running = active && store.busy;
  const sp = store.sessionPrefs[session.id];
  const title = isDefaultTitle(session.title) ? "Untitled task" : session.title;

  return (
    <div
      className={cx("sb-row", active && "active")}
      onClick={() => store.selectSession(session.id)}
      title={`${session.title}\n${session.projectPath ?? "no project"}\n${new Date(session.updatedAt).toLocaleString()}`}
    >
      <span className={cx("sb-dot", running && "running", active && !running && "active")} />
      <span className="sb-row-main">
        <span className={cx("sb-row-title", isDefaultTitle(session.title) && "dim")}>{title}</span>
        <span className="sb-row-meta">
          {sp?.pinned ? <IconPin size={10} /> : null}
          <span>{relTime(session.updatedAt)}</span>
          <span>·</span>
          <span>{session.messageCount} msgs</span>
        </span>
      </span>
      <Menu
        label="Session actions"
        align="end"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        trigger={(ref) => (
          <TooltipButton
            ref={ref as React.RefObject<HTMLButtonElement>}
            className="sb-row-menu-btn"
            tooltip="Session actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <IconMore size={14} />
          </TooltipButton>
        )}
      >
        <MenuItem
          icon={<IconPencil size={13} />}
          onClick={() => {
            setMenuOpen(false);
            onRename();
          }}
        >
          Rename…
        </MenuItem>
        <MenuItem
          icon={<IconPin size={13} />}
          checked={Boolean(sp?.pinned)}
          onClick={() => {
            setMenuOpen(false);
            store.updateSessionPrefs(session.id, { pinned: !sp?.pinned });
          }}
        >
          {sp?.pinned ? "Unpin" : "Pin"}
        </MenuItem>
        <MenuItem
          icon={<IconFork size={13} />}
          onClick={() => {
            setMenuOpen(false);
            void store.forkSession(session.id);
          }}
        >
          Fork session
        </MenuItem>
        <MenuItem
          icon={<IconArchive size={13} />}
          onClick={() => {
            setMenuOpen(false);
            store.updateSessionPrefs(session.id, { archived: !archived, pinned: false });
          }}
        >
          {archived ? "Restore" : "Archive"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<IconTrash size={13} />}
          onClick={() => {
            setMenuOpen(false);
            void store.deleteSession(session.id);
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </div>
  );
}
