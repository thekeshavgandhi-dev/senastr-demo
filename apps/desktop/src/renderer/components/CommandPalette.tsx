import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandItem } from "@senastr/shared";
import { searchCommands } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { api, cleanError } from "../lib/api";
import { translator } from "../lib/i18n";
import { IconFile, IconSearch, IconTerminal, IconX } from "./icons";
import { Modal, cx } from "./ui";

/**
 * Command palette (parity: pi-desktop `commandPalette/search|execute`,
 * bound to Ctrl/Cmd+Shift+P).
 *
 * Two result families share one list: commands (builtin, plugin, skill) and
 * files from the project index. Selecting a file inserts an `@` reference into
 * the composer draft, which is how the reference app behaves.
 */
export function CommandPalette({ store }: { store: SenastrStore }) {
  const t = translator(store.language);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [remote, setRemote] = useState<CommandItem[] | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const projectPath = store.activeSession?.projectPath ?? null;

  // Refresh the catalogue from the host (plugins and skills can change).
  useEffect(() => {
    if (!store.paletteOpen) return;
    setQuery("");
    setIndex(0);
    setLoading(true);
    void store
      .refreshCommands()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [store.paletteOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Query the host catalogue (fuzzy ranking happens server-side too).
  useEffect(() => {
    if (!store.paletteOpen) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void store
        .searchCommandsRemote(query)
        .then((rows) => {
          if (!cancelled) setRemote(rows);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, store.paletteOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // File mode: the same query also searches project paths.
  useEffect(() => {
    if (!store.paletteOpen || !projectPath) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    void store
      .ensureFileIndex(projectPath)
      .then((paths) => {
        if (cancelled) return;
        const q = query.trim().toLowerCase();
        const matches = q
          ? paths.filter((p) => p.toLowerCase().includes(q)).slice(0, 5)
          : paths.slice(0, 5);
        setFiles(matches);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [store.paletteOpen, projectPath, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const commands = useMemo(() => {
    const base = remote ?? store.commands;
    return searchCommands(base, { query, limit: 40 });
  }, [remote, store.commands, query]);

  type Row = { kind: "command"; command: CommandItem } | { kind: "file"; path: string };
  const rows = useMemo<Row[]>(
    () => [
      ...commands.map((command) => ({ kind: "command" as const, command })),
      ...files.map((path) => ({ kind: "file" as const, path })),
    ],
    [commands, files],
  );

  useEffect(() => setIndex(0), [query]);

  const close = () => store.setPaletteOpen(false);

  const execute = async (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "file") {
      // Insert an @-reference into the composer draft for this session.
      const sessionId = store.activeSession?.id;
      if (sessionId) {
        try {
          const drafts = JSON.parse(localStorage.getItem("senastr.drafts") ?? "{}") as Record<string, string>;
          const current = drafts[sessionId] ?? "";
          drafts[sessionId] = `${current}${current && !current.endsWith(" ") ? " " : ""}@${row.path} `;
          localStorage.setItem("senastr.drafts", JSON.stringify(drafts));
          window.dispatchEvent(new CustomEvent("senastr:draft-insert", { detail: { sessionId, path: row.path } }));
        } catch {
          /* draft storage is best-effort */
        }
      }
      close();
      return;
    }
    const command = row.command;
    close();
    await executeCommand(store, command);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void execute(rows[index]);
    }
  };

  if (!store.paletteOpen) return null;

  return (
    <Modal onClose={close} label={t("palette.title")} className="palette-modal">
      <div className="palette" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <IconSearch size={15} />
          <input
            data-autofocus
            value={query}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading ? <span className="palette-hint">…</span> : null}
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={close}>
            <IconX size={13} />
          </button>
        </div>
        <div className="palette-results" ref={listRef} role="listbox" aria-label={t("palette.title")}>
          {rows.length === 0 && <div className="palette-empty">{t("palette.noResults")}</div>}
          {rows.map((row, i) => (
            <button
              key={row.kind === "file" ? `file:${row.path}` : `cmd:${row.command.id}`}
              type="button"
              role="option"
              aria-selected={i === index}
              className={cx("palette-row", i === index && "active")}
              onMouseEnter={() => setIndex(i)}
              onClick={() => void execute(row)}
            >
              {row.kind === "file" ? <IconFile size={14} /> : <IconTerminal size={14} />}
              <span className="palette-title">
                {row.kind === "file" ? row.path : row.command.title}
              </span>
              {row.kind === "command" && row.command.category ? (
                <span className="palette-cat">{row.command.category}</span>
              ) : null}
              {row.kind === "command" && row.command.source !== "builtin" ? (
                <span className="palette-src">{row.command.source}</span>
              ) : null}
              {row.kind === "command" && row.command.slash ? (
                <span className="palette-slash">/{row.command.slash}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </Modal>
  );
}

/** Execute a palette command. Exported so tests and the "/" menu share it. */
export async function executeCommand(store: SenastrStore, command: CommandItem): Promise<void> {
  const session = store.activeSession;
  switch (command.id) {
    case "builtin.session.new":
      await store.newSession(session?.projectPath ?? undefined);
      return;
    case "builtin.agent.compact":
      await store.compactContext();
      return;
    case "builtin.mode.agent":
    case "builtin.mode.plan":
    case "builtin.mode.goal": {
      if (!session) return;
      const mode = command.id === "builtin.mode.plan" ? "plan" : command.id === "builtin.mode.goal" ? "goal" : "build";
      store.updateSessionPrefs(session.id, { mode });
      try {
        await api.session.setMode(session.id, mode);
        await store.refresh();
      } catch (err) {
        store.pushNotice(cleanError(err), "error");
      }
      return;
    }
    case "builtin.session.fork":
      if (session) await store.forkSession(session.id);
      return;
    case "builtin.session.import":
      store.openSettings("import");
      return;
    case "builtin.project.open":
      await store.openProject();
      return;
    case "builtin.settings.open":
      store.openSettings();
      return;
    case "builtin.view.search":
      store.setSearchOpen(true);
      return;
    case "builtin.view.workpanel":
      store.setWorkPanelOpen(!store.workPanelOpen);
      return;
    case "builtin.view.sidebar":
      store.setSidebarCollapsed(!store.sidebarCollapsed);
      return;
    case "builtin.app.updates":
      store.openSettings("updates");
      await store.checkForUpdates();
      return;
    default:
      // Plugin / skill command: expand it into the composer draft so the user
      // can add arguments before sending.
      if (command.slash) {
        try {
          const drafts = JSON.parse(localStorage.getItem("senastr.drafts") ?? "{}") as Record<string, string>;
          const sessionId = session?.id;
          if (sessionId) {
            drafts[sessionId] = `/${command.slash} `;
            localStorage.setItem("senastr.drafts", JSON.stringify(drafts));
            window.dispatchEvent(
              new CustomEvent("senastr:draft-insert", { detail: { sessionId, text: `/${command.slash} ` } }),
            );
          }
        } catch {
          /* ignore */
        }
      }
  }
}
