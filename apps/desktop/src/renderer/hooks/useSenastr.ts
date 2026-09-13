import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  GrantScope,
  PermissionGrant,
  PermissionRequest,
  PluginInfo,
  ProviderSummary,
  Session,
  SessionMeta,
  ToolCall,
  ToolResult,
} from "@senastr/shared";
import { api, cleanError, readStoredModelRef, storeModelRef } from "../lib/api";
import type { SenastrEvent, SenastrModelRef } from "../types";

export interface StreamState {
  text: string;
  blocks: Array<{ call: ToolCall; result?: ToolResult }>;
}

export interface Notice {
  id: number;
  text: string;
  kind: "info" | "error";
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
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [modelRef, setModelRefState] = useState<SenastrModelRef | null>(() => readStoredModelRef());

  const noticeSeq = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const lastUserTextRef = useRef<string>("");
  const initializedRef = useRef(false);

  activeIdRef.current = activeSession?.id ?? null;

  const pushNotice = useCallback((text: string, kind: Notice["kind"]) => {
    const id = ++noticeSeq.current;
    setNotices((n) => [...n, { id, text, kind }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 6000);
  }, []);

  // ---- init ---------------------------------------------------------------
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      try {
        const [list, provs, plugs, grantsList, appVersion, appDataDir] = await Promise.all([
          api.session.list(),
          api.provider.list(),
          api.plugin.list(),
          api.permission.list(),
          api.app.version(),
          api.app.dataDir(),
        ]);
        setSessions(list);
        setProviders(provs);
        setPlugins(plugs);
        setGrants(grantsList);
        setVersion(appVersion);
        setDataDir(appDataDir);
        if (list[0]) {
          setActiveSession(await api.session.get(list[0].id));
        }
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    })();
  }, [pushNotice]);

  // Keep a ref of the latest session titles for the auto-title check below.
  const sessionsRefTitle = useRef(new Map<string, string>());

  // ---- live events ----------------------------------------------------------
  useEffect(() => {
    const off = api.onEvent((ev: SenastrEvent) => {
      // The permission notification is the only event carrying `kind`;
      // checking `in` alone narrows the rest of the union to AgentEvent.
      if ("kind" in ev) {
        setPendingPermission(ev.request);
        return;
      }
      switch (ev.type) {
        case "turn/start":
          setBusy(true);
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
        case "turn/end": {
          setBusy(false);
          setStream(null);
          if (ev.stopReason === "error" && ev.error) pushNotice(ev.error, "error");
          const id = activeIdRef.current;
          if (id) {
            // Auto-title: first user message becomes the session title.
            const current = sessionsRefTitle.current.get(id);
            if (current === "New session" && lastUserTextRef.current) {
              const title = lastUserTextRef.current.slice(0, 48) + (lastUserTextRef.current.length > 48 ? "…" : "");
              void api.session
                .rename(id, title)
                .catch(() => undefined);
            }
            void api.session
              .get(id)
              .then(setActiveSession)
              .catch(() => undefined);
          }
          void api.session.list().then(setSessions).catch(() => undefined);
          break;
        }
        default:
          break;
      }
    });
    return off;
  }, [pushNotice]);

  useEffect(() => {
    const map = new Map<string, string>();
    for (const s of sessions) map.set(s.id, s.title);
    sessionsRefTitle.current = map;
  }, [sessions]);

  // ---- actions --------------------------------------------------------------
  const selectSession = useCallback(
    (id: string) => {
      if (busy) return;
      void api.session
        .get(id)
        .then(setActiveSession)
        .catch((err) => pushNotice(cleanError(err), "error"));
    },
    [busy, pushNotice],
  );

  const newSession = useCallback(async () => {
    if (busy) return;
    try {
      const s = await api.session.create({});
      setSessions(await api.session.list());
      setActiveSession(s);
    } catch (err) {
      pushNotice(cleanError(err), "error");
    }
  }, [busy, pushNotice]);

  const deleteSession = useCallback(
    async (id: string) => {
      if (busy) return;
      try {
        await api.session.delete(id);
        const list = await api.session.list();
        setSessions(list);
        if (activeIdRef.current === id) {
          setActiveSession(list[0] ? await api.session.get(list[0].id) : null);
        }
      } catch (err) {
        pushNotice(cleanError(err), "error");
      }
    },
    [busy, pushNotice],
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

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const session = activeSession;
      if (!session) {
        pushNotice("Create a session first", "error");
        return;
      }
      if (!session.projectPath) {
        pushNotice("Open a project folder to get started", "error");
        return;
      }
      const enabledProviders = providers.filter((provider) => provider.enabled);
      if (!enabledProviders.length) {
        pushNotice("Add or enable a model provider in Settings first", "error");
        return;
      }
      const ref =
        modelRef && enabledProviders.some((p) => p.id === modelRef.providerId && p.models.includes(modelRef.model))
          ? modelRef
          : {
              providerId: enabledProviders[0].id,
              model: enabledProviders[0].defaultModel ?? enabledProviders[0].models[0],
            };
      lastUserTextRef.current = trimmed;
      try {
        await api.chat.send({ sessionId: session.id, text: trimmed, modelRef: ref });
      } catch (err) {
        setBusy(false);
        pushNotice(cleanError(err), "error");
      }
    },
    [activeSession, busy, modelRef, providers, pushNotice],
  );

  const stop = useCallback(() => {
    if (activeSession) void api.chat.stop(activeSession.id);
  }, [activeSession]);

  const respondPermission = useCallback(
    (allow: boolean, remember: GrantScope | null = null) => {
      const request = pendingPermission;
      if (!request) return;
      setPendingPermission(null);
      void api.permission
        .respond({ requestId: request.requestId, allow, remember })
        .then(() => api.permission.list())
        .then(setGrants)
        .catch((err) => pushNotice(cleanError(err), "error"));
    },
    [pendingPermission, pushNotice],
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
    } catch (err) {
      pushNotice(cleanError(err), "error");
    }
  }, [pushNotice]);

  const setModelRef = useCallback((ref: SenastrModelRef | null) => {
    setModelRefState(ref);
    storeModelRef(ref);
  }, []);

  return {
    view,
    setView,
    sessions,
    activeSession,
    providers,
    plugins,
    grants,
    busy,
    stream,
    pendingPermission,
    notices,
    version,
    dataDir,
    modelRef,
    setModelRef,
    selectSession,
    newSession,
    deleteSession,
    openProject,
    send,
    stop,
    respondPermission,
    refresh,
    pushNotice,
  };
}

export type SenastrStore = ReturnType<typeof useSenastr>;

/** Convert a persisted tool message into a UI ToolResult. */
export function toolMessageToResult(m: ChatMessage | undefined): ToolResult | undefined {
  if (!m || m.role !== "tool") return undefined;
  if (m.content.startsWith("ERROR: ")) {
    return { ok: false, error: m.content.slice("ERROR: ".length), durationMs: 0 };
  }
  return { ok: true, output: m.content, durationMs: 0 };
}
