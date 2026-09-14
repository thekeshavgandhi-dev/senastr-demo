import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionMeta } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { isDefaultTitle } from "../lib/prefs";
import {
  IconBook,
  IconChevronRight,
  IconFolderOpen,
  IconMessage,
  IconMoon,
  IconNewSession,
  IconPanel,
  IconPlug,
  IconSearch,
  IconServer,
  IconSettings,
  IconShield,
  IconSidebar,
  IconSliders,
  IconSparkles,
  IconSun,
} from "./icons";
import { Modal, cx } from "./ui";

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** Subsequence fuzzy match; returns score or null. */
function fuzzyScore(needle: string, hay: string): number | null {
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let score = 0;
  let hi = 0;
  for (let ni = 0; ni < n.length; ni += 1) {
    const idx = h.indexOf(n[ni], hi);
    if (idx === -1) return null;
    if (idx === hi) score += 2;
    else score += 1;
    hi = idx + 1;
  }
  if (h.startsWith(n)) score += 4;
  return score;
}

export function SearchDialog({ store }: { store: SenastrStore }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery("");
    setIndex(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [store.searchOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions: Action[] = useMemo(
    () => [
      { id: "new", label: "New task", icon: <IconNewSession size={14} />, run: () => void store.newSession(store.activeSession?.projectPath ?? undefined) },
      { id: "open", label: "Open project…", icon: <IconFolderOpen size={14} />, run: () => void store.openProject() },
      {
        id: "toggle-sidebar",
        label: store.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
        icon: <IconSidebar size={14} />,
        run: () => store.setSidebarCollapsed(!store.sidebarCollapsed),
      },
      {
        id: "toggle-panel",
        label: store.workPanelOpen ? "Close work panel" : "Open work panel",
        icon: <IconPanel size={14} />,
        run: () => store.setWorkPanelOpen(!store.workPanelOpen),
      },
      {
        id: "theme",
        label: "Toggle theme",
        hint: store.theme,
        icon: store.theme === "light" ? <IconMoon size={14} /> : <IconSun size={14} />,
        run: () => store.setTheme(store.theme === "light" ? "dark" : "light"),
      },
      { id: "settings-models", label: "Settings: Models", icon: <IconSparkles size={14} />, run: () => store.openSettings("models") },
      { id: "settings-skills", label: "Settings: Skills", icon: <IconBook size={14} />, run: () => store.openSettings("skills") },
      { id: "settings-mcp", label: "Settings: MCP", icon: <IconServer size={14} />, run: () => store.openSettings("mcp") },
      { id: "settings-ext", label: "Settings: Extensions", icon: <IconPlug size={14} />, run: () => store.openSettings("plugins") },
      { id: "settings-perm", label: "Settings: Permissions", icon: <IconShield size={14} />, run: () => store.openSettings("permissions") },
      { id: "settings-general", label: "Settings: General", icon: <IconSliders size={14} />, run: () => store.openSettings("general") },
    ],
    [store],
  );

  const q = query.trim();

  const matchedActions = useMemo(() => {
    if (!q) return actions.slice(0, 5);
    return actions
      .map((a) => ({ a, s: fuzzyScore(q, a.label) }))
      .filter((x) => x.s != null)
      .sort((x, y) => (y.s ?? 0) - (x.s ?? 0))
      .map((x) => x.a);
  }, [actions, q]);

  const matchedSessions = useMemo(() => {
    const pool = store.sessions.filter((s) => !store.sessionPrefs[s.id]?.archived);
    if (!q) return pool.slice(0, 6);
    return pool
      .map((s) => {
        const title = fuzzyScore(q, s.title);
        const path = s.projectPath ? fuzzyScore(q, s.projectPath) : null;
        const best = Math.max(title ?? -1, (path ?? -1) - 1);
        return { s, score: best };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.s);
  }, [store.sessions, store.sessionPrefs, q]);

  type Row = { kind: "action"; action: Action } | { kind: "session"; session: SessionMeta };
  const rows: Row[] = useMemo(
    () => [
      ...matchedActions.map((action) => ({ kind: "action" as const, action })),
      ...matchedSessions.map((session) => ({ kind: "session" as const, session })),
    ],
    [matchedActions, matchedSessions],
  );

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (index > rows.length) setIndex(0);
  }, [rows.length, index]);

  const runRow = (row: Row | undefined) => {
    if (!row) return;
    store.setSearchOpen(false);
    if (row.kind === "action") row.action.run();
    else store.selectSession(row.session.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The trailing "Open settings" row sits at index rows.length — one past
    // the action/session rows — so navigation cycles over rows.length + 1.
    const total = rows.length + 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (i + 1) % total);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (i - 1 + total) % total);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (index === rows.length) {
        store.setSearchOpen(false);
        store.setView("settings");
      } else {
        runRow(rows[index]);
      }
    }
  };

  if (!store.searchOpen) return null;

  const actionCount = matchedActions.length;

  return (
    <Modal label="Search" onClose={() => store.setSearchOpen(false)} className="search-modal">
      <div className="search-box">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search sessions, jump to settings, run actions…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className="kbd">esc</kbd>
      </div>
      <div className="search-results" ref={listRef}>
        {rows.length === 0 && <div className="search-empty">No matches</div>}
        {matchedActions.length > 0 && <div className="search-group">Actions</div>}
        {matchedActions.map((a, i) => (
          <button
            key={a.id}
            type="button"
            className={cx("search-row", i === index && "active")}
            onMouseEnter={() => setIndex(i)}
            onClick={() => runRow({ kind: "action", action: a })}
          >
            <span className="search-row-icon">{a.icon}</span>
            <span>{a.label}</span>
            {a.hint ? <span className="search-row-hint">{a.hint}</span> : <IconChevronRight size={12} />}
          </button>
        ))}
        {matchedSessions.length > 0 && <div className="search-group">Sessions</div>}
        {matchedSessions.map((s, j) => {
          const i = actionCount + j;
          return (
            <button
              key={s.id}
              type="button"
              className={cx("search-row", i === index && "active")}
              onMouseEnter={() => setIndex(i)}
              onClick={() => runRow({ kind: "session", session: s })}
            >
              <span className="search-row-icon">
                <IconMessage size={14} />
              </span>
              <span className="search-row-main">
                <span className={cx(!s.title || isDefaultTitle(s.title) ? "dim" : "")}>
                  {isDefaultTitle(s.title) ? "Untitled task" : s.title}
                </span>
                <small title={s.projectPath ?? ""}>{s.projectPath ?? "no project"}</small>
              </span>
              <span className="search-row-hint">{s.messageCount} msgs</span>
            </button>
          );
        })}
        <div className="search-group">Settings</div>
        <button
          type="button"
          className={cx("search-row", rows.length === index && "active")}
          onMouseEnter={() => setIndex(rows.length)}
          onClick={() => {
            store.setSearchOpen(false);
            store.setView("settings");
          }}
        >
          <span className="search-row-icon">
            <IconSettings size={14} />
          </span>
          <span>Open settings</span>
          <IconChevronRight size={12} />
        </button>
      </div>
    </Modal>
  );
}
