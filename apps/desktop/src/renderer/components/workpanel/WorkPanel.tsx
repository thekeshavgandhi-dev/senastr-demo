import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, DelegationSummary, GitInfo, PullSummary, ReviewSnapshot, ToolCall } from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { toolMessageToResult } from "../../hooks/useSenastr";
import { api, cleanError } from "../../lib/api";
import { NotificationList } from "../NotificationCenter";
import { IconActivity, IconBell, IconBranch, IconClock, IconDiff, IconExternal, IconFile, IconHistory, IconInfo, IconRefresh, IconUsers, IconX } from "../icons";
import { TooltipButton, cx } from "../ui";

function collectEdits(messages: ChatMessage[]): Array<{ call: ToolCall; ok: boolean | null; messageId: string }> {
  const toolByCall = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) toolByCall.set(m.toolCallId, m);
  }
  const edits: Array<{ call: ToolCall; ok: boolean | null; messageId: string }> = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      if (call.name !== "write_file") continue;
      const result = toolMessageToResult(toolByCall.get(call.id));
      edits.push({ call, ok: result ? result.ok : null, messageId: m.id });
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
  { id: "activity", label: "Activity", icon: IconActivity },
  { id: "git", label: "Git", icon: IconBranch },
  { id: "files", label: "Files", icon: IconFile },
  { id: "details", label: "Details", icon: IconInfo },
];

export function WorkPanel({ store }: { store: SenastrStore }) {
  const session = store.activeSession;
  const tab = store.workPanelTab;
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]); // eslint-disable-line react-hooks/exhaustive-deps
  const edits = useMemo(() => collectEdits(messages), [messages]);
  const files = useMemo(() => collectFiles(messages), [messages]);
  const [snapshotCount, setSnapshotCount] = useState(0);
  const unread = store.notifications.filter((n) => !n.read).length;
  const runningDelegations = (store.delegations[session?.id ?? ""] ?? []).filter((d) => d.status === "running").length;

  useEffect(() => {
    if (!session) {
      setSnapshotCount(0);
      return;
    }
    let cancelled = false;
    void api.review
      .list(session.id)
      .then((rows) => { if (!cancelled) setSnapshotCount(rows.length); })
      .catch(() => { if (!cancelled) setSnapshotCount(edits.length); });
    return () => { cancelled = true; };
  }, [session?.id, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const badge = (id: string): number => {
    if (id === "review") return snapshotCount;
    if (id === "activity") return runningDelegations + unread;
    return 0;
  };

  return (
    <aside className="work-panel" aria-label="Work panel">
      <div className="wp-head">
        <div className="wp-tabs" role="tablist">
          {TABS.map((t) => {
            const count = badge(t.id);
            return (
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
                {count > 0 ? <span className="wp-badge">{count > 99 ? "99+" : count}</span> : null}
              </button>
            );
          })}
        </div>
        <TooltipButton className="wp-close" tooltip="Close panel (Ctrl+J)" onClick={() => store.setWorkPanelOpen(false)}>
          <IconX size={14} />
        </TooltipButton>
      </div>
      <div className="wp-body">
        {!session ? (
          <div className="wp-empty">No active session</div>
        ) : tab === "review" ? (
          <ReviewTab store={store} sessionId={session.id} turnCount={messages.length} />
        ) : tab === "activity" ? (
          <ActivityTab store={store} sessionId={session.id} />
        ) : tab === "git" ? (
          <GitTab store={store} projectPath={session.projectPath} />
        ) : tab === "files" ? (
          <FilesTab files={files} />
        ) : (
          <DetailsTab store={store} />
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Review — before/after snapshots with rollback                        */
/* ------------------------------------------------------------------ */

function ReviewTab({ store, sessionId, turnCount }: { store: SenastrStore; sessionId: string; turnCount: number }) {
  const [snapshots, setSnapshots] = useState<ReviewSnapshot[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const rows = await api.review.list(sessionId);
      setSnapshots([...rows].reverse());
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
      setSnapshots([]);
    }
  };

  useEffect(() => {
    setSnapshots(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, turnCount]);

  const rollback = async (snap: ReviewSnapshot) => {
    if (confirmId !== snap.id) {
      setConfirmId(snap.id);
      window.setTimeout(() => setConfirmId((v) => (v === snap.id ? null : v)), 4000);
      return;
    }
    setBusy(true);
    try {
      const out = await api.review.rollback({ sessionId, snapshotId: snap.id });
      store.pushNotice(out.output || `Rolled back ${snap.path}`, "info");
      setConfirmId(null);
      await load();
      await store.refresh();
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (snapshots === null) return <div className="wp-empty">Loading changes…</div>;
  if (!snapshots.length) {
    return (
      <div className="wp-empty">
        <IconDiff size={22} />
        <p>No file writes in this session yet.</p>
        <small>Files the agent modifies will appear here with before/after diffs.</small>
      </div>
    );
  }
  return (
    <div className="wp-list">
      {snapshots.map((snap) => {
        const open = openId === snap.id;
        const fileName = snap.path.split(/[\\/]/).pop() || snap.path;
        return (
          <div key={snap.id} className="wp-card">
            <button type="button" className="wp-card-head" onClick={() => setOpenId(open ? null : snap.id)}>
              <span className={cx("wp-status", snap.before === null ? "new" : "ok")} />
              <span className="wp-card-title" title={snap.path}>{fileName}</span>
              <span className="wp-card-sub" title={snap.path}>{snap.before === null ? "new file" : snap.path}</span>
            </button>
            {open && (
              <div className="wp-card-body">
                {snap.truncated ? <p className="wp-warn">Snapshot truncated — rollback disabled for safety.</p> : null}
                <DiffView before={snap.before ?? ""} after={snap.after} isNew={snap.before === null} />
                <div className="wp-card-actions">
                  <button
                    type="button"
                    className={cx("btn", "xs", confirmId === snap.id ? "danger" : "")}
                    disabled={busy || snap.truncated}
                    title={snap.truncated ? "Truncated snapshots cannot be rolled back" : "Restore the previous content"}
                    onClick={() => void rollback(snap)}
                  >
                    <IconHistory size={12} />
                    {confirmId === snap.id ? "Confirm rollback" : snap.before === null ? "Delete file" : "Rollback"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface DiffRow {
  kind: "same" | "add" | "del";
  text: string;
}

/** Tiny LCS line diff — good enough for review rendering. */
function diffLines(before: string, after: string, maxLines = 400): { rows: DiffRow[]; cut: boolean } {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length + b.length > maxLines * 2) {
    return {
      rows: [
        ...a.slice(0, maxLines).map((text) => ({ kind: "del" as const, text })),
        ...b.slice(0, maxLines).map((text) => ({ kind: "add" as const, text })),
      ],
      cut: true,
    };
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "del", text: a[i] });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++] });
  while (j < m) rows.push({ kind: "add", text: b[j++] });
  return { rows, cut: false };
}

function DiffView({ before, after, isNew }: { before: string; after: string; isNew: boolean }) {
  const { rows, cut } = useMemo(() => diffLines(before, after), [before, after]);
  // Collapse long unchanged runs to keep the panel readable.
  const visible: Array<DiffRow | { kind: "gap"; text: string }> = [];
  let pending = 0;
  const flush = () => {
    if (pending > 0) {
      if (pending > 6) visible.push({ kind: "gap", text: `⋯ ${pending - 4} unchanged lines ⋯` });
      pending = 0;
    }
  };
  const sameBuffer: DiffRow[] = [];
  for (const row of rows) {
    if (row.kind === "same") {
      sameBuffer.push(row);
      pending++;
      if (sameBuffer.length > 2 && pending > 4) sameBuffer.shift();
    } else {
      if (pending > 0 && pending <= 4) {
        // short run — show it fully
      } else if (pending > 4) {
        visible.push(...sameBuffer.slice(-2));
        visible.push({ kind: "gap", text: `⋯ ${pending - 4} unchanged lines ⋯` });
        sameBuffer.length = 0;
      } else {
        visible.push(...sameBuffer.splice(0));
      }
      pending = 0;
      flush();
      visible.push(row);
    }
  }
  visible.push(...sameBuffer.slice(-4));
  if (isNew) {
    return (
      <pre className="wp-diff new">
        {after.slice(0, 6000).split("\n").slice(0, 200).map((line, k) => (
          <div key={k} className="add">+{line}</div>
        ))}
      </pre>
    );
  }
  return (
    <pre className="wp-diff">
      {cut ? <div className="gap">Large file — showing first 400 lines of each side.</div> : null}
      {visible.map((row, k) =>
        row.kind === "gap" ? (
          <div key={k} className="gap">{row.text}</div>
        ) : (
          <div key={k} className={row.kind}>
            {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}{row.text}
          </div>
        ),
      )}
    </pre>
  );
}

/* ------------------------------------------------------------------ */
/* Activity — subagent delegations + notifications                      */
/* ------------------------------------------------------------------ */

function ActivityTab({ store, sessionId }: { store: SenastrStore; sessionId: string }) {
  const items = store.delegations[sessionId] ?? [];
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="wp-activity">
      <div className="wp-section-head">
        <IconUsers size={13} />
        <span>Subagents</span>
        {items.length ? <b>{items.length}</b> : null}
      </div>
      {!items.length ? (
        <div className="wp-empty slim">
          <p>No delegations in this session.</p>
          <small>The agent can spawn subagents with the Task tool.</small>
        </div>
      ) : (
        <div className="wp-list">
          {[...items].reverse().map((d) => (
            <DelegationCard key={d.id} d={d} open={openId === d.id} onToggle={() => setOpenId(openId === d.id ? null : d.id)} />
          ))}
        </div>
      )}
      <div className="wp-section-head">
        <IconBell size={13} />
        <span>Notifications</span>
      </div>
      <NotificationList store={store} />
    </div>
  );
}

function DelegationCard({ d, open, onToggle }: { d: DelegationSummary; open: boolean; onToggle: () => void }) {
  return (
    <div className={cx("wp-card", d.status === "error" && "fail")}>
      <button type="button" className="wp-card-head" onClick={onToggle}>
        <span className={cx("wp-status", d.status === "running" ? "running" : d.status === "done" ? "ok" : "fail")} />
        <span className="wp-card-title">{d.agentName}</span>
        <span className="wp-card-sub" title={d.description}>{d.description}</span>
      </button>
      {open && (
        <div className="wp-card-body">
          <div className="wp-drow">
            <span>Status</span>
            <strong className="cap">{d.status}</strong>
          </div>
          {typeof d.turns === "number" ? (
            <div className="wp-drow">
              <span>Steps</span>
              <strong>{d.turns}</strong>
            </div>
          ) : null}
          {d.error ? <p className="wp-error">{d.error}</p> : null}
          {d.report ? <pre className="wp-report">{d.report}</pre> : d.status === "running" ? <p className="wp-muted">Working…</p> : null}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Git — branch status + open PRs                                       */
/* ------------------------------------------------------------------ */

function GitTab({ store, projectPath }: { store: SenastrStore; projectPath: string | null }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [prs, setPrs] = useState<PullSummary[] | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const [g, p] = await Promise.all([
        api.projectCtx.gitInfo(projectPath),
        api.projectCtx.prList(projectPath, 20),
      ]);
      setInfo(g);
      setPrs(p.prs);
      setPrError(p.error ?? null);
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setInfo(null);
    setPrs(null);
    setPrError(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  if (!projectPath) {
    return (
      <div className="wp-empty">
        <IconBranch size={22} />
        <p>No project attached.</p>
        <small>Open a project folder to see git status and PRs.</small>
      </div>
    );
  }

  return (
    <div className="wp-git">
      <div className="wp-list-actions">
        <button type="button" className="btn xs" disabled={loading} onClick={() => void load()}>
          <IconRefresh size={12} />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="wp-details">
        <div className="wp-drow">
          <span>Branch</span>
          <strong>{info ? info.branch ?? "—" : "…"}</strong>
        </div>
        <div className="wp-drow">
          <span>Changed files</span>
          <strong>{info ? info.dirty : "…"}</strong>
        </div>
        {info?.error ? (
          <div className="wp-drow">
            <span>Status</span>
            <strong className="wp-muted">{info.error}</strong>
          </div>
        ) : null}
      </div>
      <div className="wp-section-head">
        <IconClock size={13} />
        <span>Open pull requests</span>
        {prs?.length ? <b>{prs.length}</b> : null}
      </div>
      {prs === null ? (
        <div className="wp-empty slim"><p>Loading…</p></div>
      ) : prError ? (
        <div className="wp-empty slim">
          <p>{prError}</p>
          <small>PRs need the GitHub CLI (gh) and a GitHub remote.</small>
        </div>
      ) : !prs.length ? (
        <div className="wp-empty slim"><p>No open pull requests.</p></div>
      ) : (
        <div className="wp-list">
          {prs.map((pr) => (
            <div key={pr.number} className="wp-card">
              <div className="wp-card-head static">
                <span className="wp-pr-num">#{pr.number}</span>
                <span className="wp-card-title" title={pr.title}>{pr.title}</span>
              </div>
              <div className="wp-card-body">
                <div className="wp-drow">
                  <span>Branch</span>
                  <strong>{pr.headRefName ?? "—"}{pr.baseRefName ? ` → ${pr.baseRefName}` : ""}</strong>
                </div>
                {pr.author ? (
                  <div className="wp-drow">
                    <span>Author</span>
                    <strong>{pr.author}</strong>
                  </div>
                ) : null}
                {pr.isDraft ? (
                  <div className="wp-drow">
                    <span>State</span>
                    <strong>Draft</strong>
                  </div>
                ) : null}
                {pr.url ? (
                  <div className="wp-card-actions">
                    <button type="button" className="btn xs" onClick={() => void api.app.openExternal(pr.url)}>
                      <IconExternal size={12} />
                      Open in browser
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Files + Details (unchanged behavior)                                 */
/* ------------------------------------------------------------------ */

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
