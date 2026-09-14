import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppNotification,
  AskAnswers,
  AskRequest,
  ChatMessage,
  DelegationSummary,
  GrantScope,
  PermissionGrant,
  PermissionRequest,
  PlanProposal,
  PluginInfo,
  ProviderSummary,
  Session,
  SessionMeta,
  SessionMode,
  ToolCall,
  ToolResult,
  TurnStopReason,
  Usage,
} from "@senastr/shared";
import { api, cleanError, readStoredModelRef, storeModelRef } from "../lib/api";
import type { SenastrEvent, SenastrModelRef } from "../types";
import {
  estimateTokens,
  prefs,
  type AgentMode,
  type PermissionMode,
  type ProjectMeta,
  type SessionPrefs,
  type SessionSort,
  type ThemePref,
} from "../lib/prefs";

export interface StreamState {
  text: string;
  blocks: Array<{ call: ToolCall; result?: ToolResult }>;
}

export interface Notice {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface QueuedPrompt {
  id: number;
  text: string;
  createdAt: number;
}

export interface TurnError {
  text: string;
  at: number;
}

export function useSenastr() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [streamSessionId, setStreamSessionId] = useState<string | null>(null);
  const [pendingPermissionQueue, setPendingPermissionQueue] = useState<PermissionRequest[]>([]);
  const [pendingAsks, setPendingAsks] = useState<AskRequest[]>([]);
  const [planProposal, setPlanProposal] = useState<PlanProposal | null>(null);
  const [delegations, setDelegations] = useState<Record<string, DelegationSummary[]>>({});
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [modelRef, setModelRefState] = useState<SenastrModelRef | null>(() => readStoredModelRef());

  // ---- shell / appearance -------------------------------------------------
  const [theme, setThemeState] = useState<ThemePref>(() => prefs.theme);
  const [fontScale, setFontScaleState] = useState<number>(() => prefs.fontScale);
  const [enterToSend, setEnterToSendState] = useState<boolean>(() => prefs.enterToSend);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => prefs.sidebarCollapsed);
  const [workPanelOpen, setWorkPanelOpenState] = useState<boolean>(() => prefs.workPanel.open);
  const [workPanelTab, setWorkPanelTabState] = useState<string>(() => prefs.workPanel.tab || "review");
  const [searchOpen, setSearchOpen] = useState(false);

  // ---- session prefs -------------------------------------------------------
  const [sessionPrefs, setSessionPrefsState] = useState<Record<string, SessionPrefs>>(() => prefs.sessionPrefs);
  const [projectMeta, setProjectMetaState] = useState<Record<string, ProjectMeta>>(() => prefs.projectMeta);
  const [sessionSort, setSessionSortState] = useState<SessionSort>(() => prefs.sessionSort);
  const [defaultPermissionMode, setDefaultPermissionModeState] = useState<PermissionMode>(
    () => prefs.defaultPermissionMode,
  );
  const [defaultAgentMode, setDefaultAgentModeState] = useState<AgentMode>(() => prefs.defaultAgentMode);

  // ---- turn state ----------------------------------------------------------
  const [queued, setQueued] = useState<Record<string, QueuedPrompt[]>>({});
  const [lastUsage, setLastUsage] = useState<Usage | null>(null);
  const [lastStopReason, setLastStopReason] = useState<TurnStopReason | null>(null);
  const [lastError, setLastError] = useState<TurnError | null>(null);
  const [settingsTab, setSettingsTabState] = useState<string>(() => prefs.settingsTab);

  const noticeSeq = useRef(0);
  const queueSeq = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const inFlightSessionRef = useRef<string | null>(null);
  const lastUserTextRef = useRef<string>("");
  const initializedRef = useRef(false);
  const queuedRef = useRef<Record<string, QueuedPrompt[]>>({});
  queuedRef.current = queued;
  const flushRef = useRef<(s: Session, t: string) => Promise<void>>(async () => {});

  activeIdRef.current = activeSession?.id ?? null;

  const pushNotice = useCallback((text: string, kind: Notice["kind"]) => {
    const id = ++noticeSeq.current;
    setNotices((n) => [...n.slice(-4), { id, text, kind }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 6000);
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((n) => n.filter((x) => x.id !== id));
  }, []);

  // ---- init ---------------------------------------------------------------
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      try {
        const [list, provs, plugs, grantsList, appVersion, appDataDir, notes] = await Promise.all([
          api.session.list(),
          api.provider.list(),
          api.plugin.list(),
          api.permission.list(),
          api.app.version(),
          api.app.dataDir(),
          api.notify.list().catch(() => [] as AppNotification[]),
        ]);
        setSessions(list);
        setProviders(provs);
        setPlugins(plugs);
        setGrants(grantsList);
        setVersion(appVersion);
        setDataDir(appDataDir);
        setNotifications(notes);
        const unarchived = list.filter((s) => !prefs.sessionPrefs[s.id]?.archived);
        const first = unarchived[0] ?? list[0];
        if (first) {
          setActiveSession(await api.session.get(first.id));
        }
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    })();
  }, [pushNotice]);

  // Keep a ref of the latest session titles for the auto-title check below.
  const sessionsRefTitle = useRef(new Map<string, string>());

  // Refs read by the single event subscription (modes can change mid-turn).
  const modesRef = useRef({ sessionPrefs, defaultPermissionMode });
  modesRef.current = { sessionPrefs, defaultPermissionMode };
  const activeSessionRef = useRef<Session | null>(null);
  activeSessionRef.current = activeSession;

  // ---- live events ----------------------------------------------------------
  useEffect(() => {
    const off = api.onEvent((ev: SenastrEvent) => {
      // Main-process notifications carry `kind`; everything else is an AgentEvent.
      if ("kind" in ev) {
        switch (ev.kind) {
          case "permission/requested": {
            const request = ev.request;
            // Auto-approve when the session's permission mode allows it.
            if (
              (modesRef.current.sessionPrefs[request.sessionId]?.permissionMode ??
                modesRef.current.defaultPermissionMode) === "auto" ||
              ((modesRef.current.sessionPrefs[request.sessionId]?.permissionMode ??
                modesRef.current.defaultPermissionMode) === "accept-edits" &&
                request.tool === "write_file")
            ) {
              void api.permission
                .respond({ requestId: request.requestId, allow: true })
                .catch(() => undefined);
              return;
            }
            setPendingPermissionQueue((prev) =>
              prev.some((r) => r.requestId === request.requestId) ? prev : [...prev, request],
            );
            return;
          }
          case "notify/added":
            setNotifications((prev) => [ev.notification, ...prev].slice(0, 100));
            return;
          case "scheduled/started":
            pushNotice(`Scheduled task started: ${ev.name}`, "info");
            return;
          case "scheduled/finished": {
            pushNotice(
              ev.status === "done"
                ? "Scheduled task finished"
                : `Scheduled task failed${ev.error ? `: ${ev.error}` : ""}`,
              ev.status === "done" ? "info" : "error",
            );
            void api.session.list().then(setSessions).catch(() => undefined);
            if (ev.sessionId && ev.sessionId === activeIdRef.current) {
              void api.session.get(ev.sessionId).then(setActiveSession).catch(() => undefined);
            }
            return;
          }
          default:
            return;
        }
      }
      switch (ev.type) {
        case "turn/start":
          inFlightSessionRef.current = ev.sessionId;
          setStreamSessionId(ev.sessionId);
          setBusy(true);
          setLastError(null);
          setStream({ text: "", blocks: [] });
          break;
        case "assistant/delta":
          setStream((s) => (s ? { ...s, text: s.text + ev.delta } : { text: ev.delta, blocks: [] }));
          break;
        case "tool/call":
          setStream((s) =>
            s ? { ...s, blocks: [...s.blocks, { call: ev.call }] } : { text: "", blocks: [{ call: ev.call }] },
          );
          break;
        case "tool/result":
          setStream((s) =>
            s
              ? {
                  ...s,
                  blocks: s.blocks.map((b) => (b.call.id === ev.callId ? { ...b, result: ev.result } : b)),
                }
              : s,
          );
          break;
        case "ask/request":
          setPendingAsks((prev) =>
            prev.some((r) => r.requestId === ev.request.requestId) ? prev : [...prev, ev.request],
          );
          pushNotice("The agent asked a question", "info");
          break;
        case "ask/resolved":
          setPendingAsks((prev) => prev.filter((r) => r.requestId !== ev.requestId));
          break;
        case "plan/proposed":
          setPlanProposal(ev.proposal);
          pushNotice("Plan ready for review", "info");
          break;
        case "subagent/start":
        case "subagent/end":
          setDelegations((prev) => {
            const rows = prev[ev.sessionId] ?? [];
            const found = rows.findIndex((d) => d.id === ev.delegation.id);
            const next =
              found >= 0
                ? rows.map((d, i) => (i === found ? ev.delegation : d))
                : [...rows, ev.delegation];
            return { ...prev, [ev.sessionId]: next.slice(-50) };
          });
          break;
        case "turn/end": {
          const finishedId = inFlightSessionRef.current;
          inFlightSessionRef.current = null;
          if (finishedId) {
            // Aborted turns never emit ask/resolved — drop their dialogs.
            setPendingAsks((prev) => prev.filter((r) => r.sessionId !== finishedId));
          }
          setBusy(false);
          setStream(null);
          setStreamSessionId(null);
          setLastUsage(ev.usage ?? null);
          setLastStopReason(ev.stopReason);
          if (ev.stopReason === "error" && ev.error) {
            setLastError({ text: ev.error, at: Date.now() });
          }
          // Auto-title: first user message becomes the session title.
          if (finishedId) {
            const current = sessionsRefTitle.current.get(finishedId);
            if (current === "New session" && lastUserTextRef.current) {
              const title =
                lastUserTextRef.current.slice(0, 48) + (lastUserTextRef.current.length > 48 ? "…" : "");
              void api.session.rename(finishedId, title).catch(() => undefined);
            }
            if (finishedId === activeIdRef.current) {
              void api.session
                .get(finishedId)
                .then(setActiveSession)
                .catch(() => undefined);
            }
          }
          void api.session.list().then(setSessions).catch(() => undefined);
          // Flush one queued prompt for the finished session, if any.
          if (finishedId) {
            const next = queuedRef.current[finishedId]?.[0];
            if (next && next.text.trim()) {
              setQueued((q) => ({ ...q, [finishedId]: (q[finishedId] ?? []).slice(1) }));
              // Defer so the turn/end state settles first.
              setTimeout(() => {
                void api.session
                  .get(finishedId)
                  .then((s) => {
                    void flushRef.current(s, next.text);
                  })
                  .catch(() => undefined);
              }, 350);
            }
          }
          break;
        }
        default:
          break;
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushNotice]);

  useEffect(() => {
    const map = new Map<string, string>();
    for (const s of sessions) map.set(s.id, s.title);
    sessionsRefTitle.current = map;
  }, [sessions]);

  // ---- appearance / shell setters ------------------------------------------
  const setTheme = useCallback((v: ThemePref) => {
    prefs.theme = v;
    setThemeState(v);
  }, []);
  const setFontScale = useCallback((v: number) => {
    prefs.fontScale = v;
    setFontScaleState(v);
  }, []);
  const setEnterToSend = useCallback((v: boolean) => {
    prefs.enterToSend = v;
    setEnterToSendState(v);
  }, []);
  const setSidebarCollapsed = useCallback((v: boolean) => {
    prefs.sidebarCollapsed = v;
    setSidebarCollapsedState(v);
  }, []);
  const setWorkPanelOpen = useCallback(
    (v: boolean) => {
      prefs.workPanel = { open: v, tab: workPanelTab };
      setWorkPanelOpenState(v);
    },
    [workPanelTab],
  );
  const setWorkPanelTab = useCallback((tab: string) => {
    setWorkPanelTabState(tab);
    setWorkPanelOpenState((open) => {
      prefs.workPanel = { open, tab };
      return open;
    });
  }, []);
  const setSessionSort = useCallback((v: SessionSort) => {
    prefs.sessionSort = v;
    setSessionSortState(v);
  }, []);
  const setDefaultPermissionMode = useCallback((v: PermissionMode) => {
    prefs.defaultPermissionMode = v;
    setDefaultPermissionModeState(v);
  }, []);
  const setDefaultAgentMode = useCallback((v: AgentMode) => {
    prefs.defaultAgentMode = v;
    setDefaultAgentModeState(v);
  }, []);

  const updateSessionPrefs = useCallback((id: string, patch: Partial<SessionPrefs>) => {
    setSessionPrefsState((prev) => {
      const next = { ...prev, [id]: { ...prev[id], ...patch } };
      prefs.sessionPrefs = next;
      return next;
    });
  }, []);

  const updateProjectMeta = useCallback((path: string, patch: Partial<ProjectMeta>) => {
    setProjectMetaState((prev) => {
      const next = { ...prev, [path]: { ...prev[path], ...patch } };
      prefs.projectMeta = next;
      return next;
    });
  }, []);

  const setSettingsTab = useCallback((tab: string) => {
    prefs.settingsTab = tab;
    setSettingsTabState(tab);
  }, []);

  const openSettings = useCallback((tab?: string) => {
    if (tab) {
      prefs.settingsTab = tab;
      setSettingsTabState(tab);
    }
    setView("settings");
  }, []);

  const permissionModeFor = useCallback(
    (sessionId: string | null): PermissionMode =>
      (sessionId && sessionPrefs[sessionId]?.permissionMode) || defaultPermissionMode,
    [sessionPrefs, defaultPermissionMode],
  );

  const agentModeFor = useCallback(
    (sessionId: string | null): AgentMode =>
      (sessionId && sessionPrefs[sessionId]?.mode) || defaultAgentMode,
    [sessionPrefs, defaultAgentMode],
  );

  // ---- actions --------------------------------------------------------------
  const selectSession = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return;
      void api.session
        .get(id)
        .then((s) => {
          setActiveSession(s);
          // The server is the source of truth for build/plan mode.
          if (s.mode === "build" || s.mode === "plan") {
            updateSessionPrefs(s.id, { mode: s.mode });
          }
          void api.chat
            .delegations(s.id)
            .then((rows) => setDelegations((prev) => ({ ...prev, [s.id]: rows })))
            .catch(() => undefined);
        })
        .catch((err) => pushNotice(cleanError(err), "error"));
    },
    [pushNotice, updateSessionPrefs],
  );

  const newSession = useCallback(
    async (projectPath?: string | null) => {
      if (busy) return;
      try {
        const s = await api.session.create({ projectPath: projectPath ?? undefined });
        setSessions(await api.session.list());
        setActiveSession(s);
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    },
    [busy, pushNotice],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      if (busy && id === activeIdRef.current) return;
      try {
        await api.session.delete(id);
        const list = await api.session.list();
        setSessions(list);
        if (activeIdRef.current === id) {
          const unarchived = list.filter((s) => !prefs.sessionPrefs[s.id]?.archived);
          const first = unarchived[0] ?? list[0];
          setActiveSession(first ? await api.session.get(first.id) : null);
        }
        pushNotice("Session deleted", "info");
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    },
    [busy, pushNotice],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const t = title.trim();
      if (!t) return;
      try {
        const updated = await api.session.rename(id, t);
        setSessions(await api.session.list());
        if (activeIdRef.current === id) setActiveSession(updated);
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    },
    [pushNotice],
  );

  const forkSession = useCallback(
    async (id: string) => {
      try {
        const src = await api.session.get(id);
        const copy = await api.session.create({
          title: `${src.title} (fork)`,
          projectPath: src.projectPath,
        });
        if (src.messages.length) {
          await api.session.appendMessages(
            copy.id,
            src.messages.map((m) => ({ ...m })),
          );
        }
        setSessions(await api.session.list());
        setActiveSession(await api.session.get(copy.id));
        pushNotice("Session forked", "info");
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    },
    [pushNotice],
  );

  const openProject = useCallback(async () => {
    try {
      const dir = await api.project.open();
      if (!dir) return;
      // Attach the project to the active session, or create one if needed.
      let activeId = activeIdRef.current;
      if (!activeId) {
        const created = await api.session.create({});
        activeId = created.id;
      }
      const updated = await api.session.setProject(activeId, dir);
      setActiveSession(updated);
      setSessions(await api.session.list());
      pushNotice(`Project opened: ${dir}`, "info");
    } catch (err) {
      pushNotice(cleanError(err), "error");
    }
  }, [pushNotice]);

  const resolveModelRef = useCallback(
    (override?: SenastrModelRef | null): SenastrModelRef | null => {
      const enabledProviders = providers.filter((provider) => provider.enabled && provider.models.length > 0);
      if (!enabledProviders.length) return null;
      const ref = override ?? modelRef;
      if (
        ref &&
        enabledProviders.some((p) => p.id === ref.providerId && p.models.includes(ref.model))
      ) {
        return ref;
      }
      const first = enabledProviders[0];
      return { providerId: first.id, model: first.defaultModel ?? first.models[0] };
    },
    [modelRef, providers],
  );

  /** Send implementation shared by send(), retry and queue flush. */
  const flushQueueSend = useCallback(
    async (session: Session, rawText: string, modeOverride?: SessionMode) => {
      const trimmed = rawText.trim();
      if (!trimmed) return;
      if (inFlightSessionRef.current) {
        // Lost a race with another turn — requeue at the front.
        const id = ++queueSeq.current;
        setQueued((q) => ({
          ...q,
          [session.id]: [{ id, text: trimmed, createdAt: Date.now() }, ...(q[session.id] ?? [])],
        }));
        return;
      }
      const ref = resolveModelRef();
      if (!ref) {
        pushNotice("Add or enable a model provider in Settings first", "error");
        return;
      }
      if (!session.projectPath) {
        pushNotice("Open a project folder to get started", "error");
        return;
      }
      // An explicit override wins (plan approve/reject must not depend on
      // stale prefs); otherwise use the session's remembered mode.
      const mode: SessionMode = (modeOverride ??
        sessionPrefs[session.id]?.mode ??
        defaultAgentMode) as SessionMode;
      lastUserTextRef.current = trimmed;
      setLastError(null);
      // Optimistic busy: chat/send resolves before turn/start arrives.
      inFlightSessionRef.current = session.id;
      setStreamSessionId(session.id);
      setBusy(true);
      setStream({ text: "", blocks: [] });
      if (session.mode !== mode) {
        // Optimistic: main applies the same mode with the send.
        setActiveSession((prev) => (prev && prev.id === session.id ? { ...prev, mode } : prev));
      }
      try {
        await api.chat.send({ sessionId: session.id, text: trimmed, modelRef: ref, mode });
      } catch (err) {
        inFlightSessionRef.current = null;
        setBusy(false);
        setStream(null);
        setStreamSessionId(null);
        setLastError({ text: cleanError(err), at: Date.now() });
        pushNotice(cleanError(err), "error");
      }
    },
    [defaultAgentMode, pushNotice, resolveModelRef, sessionPrefs],
  );
  flushRef.current = flushQueueSend;

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const session = activeSessionRef.current;
      if (!session) {
        pushNotice("Create a session first", "error");
        return;
      }
      if (busy || inFlightSessionRef.current) {
        // Queue while a turn is running instead of dropping the prompt.
        const id = ++queueSeq.current;
        setQueued((q) => ({
          ...q,
          [session.id]: [...(q[session.id] ?? []), { id, text: trimmed, createdAt: Date.now() }],
        }));
        pushNotice("Prompt queued — will send when the turn finishes", "info");
        return;
      }
      await flushQueueSend(session, trimmed);
    },
    [busy, flushQueueSend, pushNotice],
  );

  const queuePrompt = useCallback((sessionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = ++queueSeq.current;
    setQueued((q) => ({
      ...q,
      [sessionId]: [...(q[sessionId] ?? []), { id, text: trimmed, createdAt: Date.now() }],
    }));
    pushNotice("Prompt queued — will send when the turn finishes", "info");
  }, [pushNotice]);

  const removeQueuedPrompt = useCallback((sessionId: string, id: number) => {
    setQueued((q) => ({ ...q, [sessionId]: (q[sessionId] ?? []).filter((x) => x.id !== id) }));
  }, []);

  const stop = useCallback(() => {
    const id = activeIdRef.current;
    if (id) void api.chat.stop(id);
  }, []);

  const retryLast = useCallback(() => {
    const session = activeSessionRef.current;
    const text = lastUserTextRef.current;
    if (!session || !text) {
      pushNotice("Nothing to retry", "error");
      return;
    }
    if (busy) return;
    setLastError(null);
    void flushQueueSend(session, text);
  }, [busy, flushQueueSend, pushNotice]);

  const clearError = useCallback(() => setLastError(null), []);

  const resolveAsk = useCallback(
    async (requestId: string, answers: AskAnswers) => {
      try {
        const ok = await api.chat.resolveAsk(requestId, answers);
        if (!ok) {
          pushNotice("That question already expired (the turn ended)", "error");
          setPendingAsks((prev) => prev.filter((r) => r.requestId !== requestId));
          return;
        }
        setPendingAsks((prev) => prev.filter((r) => r.requestId !== requestId));
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    },
    [pushNotice],
  );

  /** Approve a plan proposal: back to build mode and implement. */
  const approvePlan = useCallback(async () => {
    const proposal = planProposal;
    if (!proposal || busy) return;
    setPlanProposal(null);
    try {
      const s = await api.session.get(proposal.sessionId);
      setActiveSession(s);
      updateSessionPrefs(s.id, { mode: "build" });
      const updated = await api.session.setMode(s.id, "build");
      setActiveSession(updated);
      await flushQueueSend({ ...updated }, "The plan is approved. Implement it now, step by step.", "build");
    } catch (err) {
      pushNotice(cleanError(err), "error");
    }
  }, [planProposal, busy, flushQueueSend, pushNotice, updateSessionPrefs]);

  /** Reject a plan proposal: stay in plan mode and ask for a revision. */
  const rejectPlan = useCallback(
    async (feedback: string) => {
      const proposal = planProposal;
      if (!proposal || busy) return;
      setPlanProposal(null);
      try {
        const s = await api.session.get(proposal.sessionId);
        setActiveSession(s);
        updateSessionPrefs(s.id, { mode: "plan" });
        const note = feedback.trim();
        await flushQueueSend(
          s,
          note
            ? `Plan rejected — revise it with this feedback, then submit the updated plan (do not implement yet):\n\n${note}`
            : "Plan rejected. Revise the plan and submit it again (do not implement yet).",
          "plan",
        );
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    },
    [planProposal, busy, flushQueueSend, pushNotice, updateSessionPrefs],
  );

  const dismissPlan = useCallback(() => setPlanProposal(null), []);

  /** Rewrite a draft prompt with the active model (tool-less one-shot). */
  const enhancePrompt = useCallback(
    async (text: string): Promise<string | null> => {
      const ref = resolveModelRef();
      if (!ref) {
        pushNotice("Add or enable a model provider in Settings first", "error");
        return null;
      }
      try {
        const out = await api.chat.enhance({ text, modelRef: ref });
        return out.text.trim() || null;
      } catch (err) {
        pushNotice(cleanError(err), "error");
        return null;
      }
    },
    [pushNotice, resolveModelRef],
  );

  /** Ask the active model for a short title for the active session. */
  const suggestTitle = useCallback(async () => {
    const session = activeSessionRef.current;
    const ref = resolveModelRef();
    if (!session) return;
    if (!ref) {
      pushNotice("Add or enable a model provider in Settings first", "error");
      return;
    }
    const excerpt = session.messages
      .slice(-8)
      .map((m) => `${m.role}: ${(m.content || "").slice(0, 600)}`)
      .join("\n\n")
      .slice(0, 4000);
    if (!excerpt.trim()) {
      pushNotice("Nothing to summarize yet", "error");
      return;
    }
    try {
      const out = await api.chat.suggestTitle({ modelRef: ref, excerpt });
      await renameSession(session.id, out.title);
    } catch (err) {
      pushNotice(cleanError(err), "error");
    }
  }, [pushNotice, renameSession, resolveModelRef]);

  const markNotificationsRead = useCallback(
    async (params: { id?: string; all?: boolean }) => {
      setNotifications((prev) =>
        prev.map((n) => (params.all || n.id === params.id ? { ...n, read: true } : n)),
      );
      try {
        await api.notify.markRead(params);
      } catch {
        /* local state already updated */
      }
    },
    [],
  );

  const clearNotifications = useCallback(async () => {
    setNotifications([]);
    try {
      await api.notify.clear();
    } catch {
      /* already cleared locally */
    }
  }, []);

  const openNotification = useCallback(
    (n: AppNotification) => {
      if (n.sessionId) {
        void markNotificationsRead({ id: n.id });
        selectSession(n.sessionId);
        setView("chat");
      } else if (n.taskId) {
        openSettings("scheduled");
      }
    },
    [markNotificationsRead, selectSession, openSettings],
  );

  const respondPermission = useCallback(
    (allow: boolean, remember: GrantScope | null = null) => {
      const request = pendingPermissionQueue[0];
      if (!request) return;
      setPendingPermissionQueue((prev) => prev.slice(1));
      void api.permission
        .respond({ requestId: request.requestId, allow, remember })
        .then(() => api.permission.list())
        .then(setGrants)
        .catch((err) => pushNotice(cleanError(err), "error"));
    },
    [pendingPermissionQueue, pushNotice],
  );

  const refresh = useCallback(async () => {
    try {
      const [list, provs, plugs, grantsList] = await Promise.all([
        api.session.list(),
        api.provider.list(),
        api.plugin.list(),
        api.permission.list(),
      ]);
      setSessions(list);
      setProviders(provs);
      setPlugins(plugs);
      setGrants(grantsList);
      const id = activeIdRef.current;
      if (id) {
        try {
          setActiveSession(await api.session.get(id));
        } catch {
          /* session may be gone */
        }
      }
    } catch (err) {
      pushNotice(cleanError(err), "error");
    }
  }, [pushNotice]);

  const setModelRef = useCallback((ref: SenastrModelRef | null) => {
    setModelRefState(ref);
    storeModelRef(ref);
  }, []);

  const contextStats = useMemo(() => {
    const messages = activeSession?.messages ?? [];
    let chars = 0;
    let tools = 0;
    for (const m of messages) {
      chars += (m.content || "").length;
      tools += m.toolCalls?.length ?? 0;
    }
    return { tokens: estimateTokens(messages.map((m) => m.content || "").join("\n")), messages: messages.length, tools, chars };
  }, [activeSession]);

  /** Head of the permission queue — the dialog currently on screen. */
  const pendingPermission = pendingPermissionQueue[0] ?? null;

  return {
    view,
    setView,
    settingsTab,
    setSettingsTab,
    openSettings,
    sessions,
    activeSession,
    providers,
    plugins,
    grants,
    busy,
    stream,
    streamSessionId,
    pendingPermission,
    pendingPermissionCount: pendingPermissionQueue.length,
    pendingAsks,
    planProposal,
    delegations,
    notifications,
    notices,
    version,
    dataDir,
    modelRef,
    setModelRef,
    // shell
    theme,
    setTheme,
    fontScale,
    setFontScale,
    enterToSend,
    setEnterToSend,
    sidebarCollapsed,
    setSidebarCollapsed,
    workPanelOpen,
    setWorkPanelOpen,
    workPanelTab,
    setWorkPanelTab,
    searchOpen,
    setSearchOpen,
    // prefs
    sessionPrefs,
    updateSessionPrefs,
    projectMeta,
    updateProjectMeta,
    sessionSort,
    setSessionSort,
    defaultPermissionMode,
    setDefaultPermissionMode,
    defaultAgentMode,
    setDefaultAgentMode,
    permissionModeFor,
    agentModeFor,
    // turns
    queued,
    queuePrompt,
    removeQueuedPrompt,
    lastUsage,
    lastStopReason,
    lastError,
    clearError,
    contextStats,
    // actions
    selectSession,
    newSession,
    deleteSession,
    renameSession,
    forkSession,
    openProject,
    send,
    stop,
    retryLast,
    respondPermission,
    resolveAsk,
    approvePlan,
    rejectPlan,
    dismissPlan,
    enhancePrompt,
    suggestTitle,
    markNotificationsRead,
    clearNotifications,
    openNotification,
    refresh,
    pushNotice,
    dismissNotice,
  };
}

export type SenastrStore = ReturnType<typeof useSenastr>;

/** Convert a persisted tool message into a UI ToolResult. */
export function toolMessageToResult(msg: ChatMessage | undefined): ToolResult | undefined {
  if (!msg) return undefined;
  try {
    const parsed = JSON.parse(msg.content) as { ok?: boolean; output?: string; error?: string; durationMs?: number };
    if (typeof parsed?.ok === "boolean") {
      return {
        ok: parsed.ok,
        output: parsed.output,
        error: parsed.error,
        durationMs: parsed.durationMs ?? 0,
      };
    }
  } catch {
    /* fall through to plain-text form */
  }
  return { ok: true, output: msg.content, durationMs: 0 };
}