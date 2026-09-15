import { useEffect, useMemo, useRef, useState } from "react";
import type { SenastrStore } from "../hooks/useSenastr";
import { api, cleanError } from "../lib/api";
import { loadRaw, prefs, type AgentMode, type PermissionMode } from "../lib/prefs";
import {
  THINKING_LEVELS,
  applyCompletion,
  detectTrigger,
  rankFileCandidates,
  rewriteIdeographicCommaTrigger,
  type ComposerTrigger,
  type ThinkingLevel,
} from "@senastr/shared";
import {
  IconBot,
  IconCheck,
  IconChevronDown,
  IconFile,
  IconPlus,
  IconSend,
  IconSettings,
  IconShield,
  IconSparkles,
  IconStop,
  IconTerminal,
  IconX,
  IconZap,
} from "./icons";
import { Menu, MenuHeading, MenuItem, MenuSeparator, TooltipButton, cx } from "./ui";

export interface ModelOption {
  value: string; // "providerId:model"
  label: string;
  provider: string;
  model: string;
}

/** @deprecated — kept for backwards-compat imports. */
export function modelOptions(providers: SenastrStore["providers"]): ModelOption[] {
  return providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ value: `${p.id}:${m}`, label: `${p.label} · ${m}`, provider: p.label, model: m })));
}

interface Attachment {
  id: number;
  label: string;
  kind: "file" | "paste" | "image";
  path?: string;
  content?: string;
  /** Host attachment id for images (and large pastes) once stored. */
  storeId?: string;
  mimeType?: string;
  dataBase64?: string;
}

const MODE_META: Record<AgentMode, { label: string; hint: string }> = {
  build: { label: "Agent", hint: "Inspect, edit and run — you approve privileged actions" },
  plan: { label: "Plan", hint: "Research first, produce a plan, change nothing until approved" },
  goal: { label: "Goal", hint: "Lock the objective; the agent picks the path and verifies it" },
};

const MODE_ORDER: AgentMode[] = ["build", "plan", "goal"];

const PERM_META: Record<PermissionMode, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Approve every privileged tool" },
  "accept-edits": { label: "Accept edits", hint: "Auto-approve file writes, ask for commands" },
  auto: { label: "Auto", hint: "Auto-approve all tools in this session" },
};

const THINKING_META: Record<ThinkingLevel, string> = {
  off: "No extra reasoning",
  minimal: "Minimal reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Maximum reasoning (slowest)",
};

let attachSeq = 0;

export function Composer({ store, variant = "docked" }: { store: SenastrStore; variant?: "home" | "docked" }) {
  const session = store.activeSession;
  const sessionId = session?.id ?? null;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [thinkMenuOpen, setThinkMenuOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [ctxMenuOpen, setCtxMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Autocomplete state: one menu, two modes ("/" commands, "@" files).
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [remoteCommands, setRemoteCommands] = useState<SenastrStore["commands"]>([]);
  const [fileCandidates, setFileCandidates] = useState<string[]>([]);

  // Load draft when switching sessions.
  useEffect(() => {
    setAttachments([]);
    setTrigger(null);
    if (!sessionId) {
      setText("");
      return;
    }
    try {
      const drafts = loadRaw<Record<string, string>>("senastr.drafts", {});
      setText(drafts[sessionId] ?? "");
    } catch {
      setText("");
    }
  }, [sessionId]);

  // Palette / slash-menu draft insertions arrive as window events so the
  // command palette can write into the composer without prop-drilling.
  useEffect(() => {
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; text?: string; path?: string }>).detail;
      if (!detail || (detail.sessionId && detail.sessionId !== sessionId)) return;
      if (typeof detail.text === "string") setText(detail.text);
      else if (typeof detail.path === "string") {
        setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${detail.path} `);
      }
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener("senastr:draft-insert", onInsert);
    return () => window.removeEventListener("senastr:draft-insert", onInsert);
  }, [sessionId]);

  // Persist draft.
  useEffect(() => {
    if (!sessionId) return;
    const t = setTimeout(() => {
      try {
        const drafts = loadRaw<Record<string, string>>("senastr.drafts", {});
        if (text) drafts[sessionId] = text;
        else delete drafts[sessionId];
        prefs.drafts = drafts;
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, sessionId]);

  // Auto-resize.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), 180)}px`;
  }, [text]);

  // Focus empty home composer.
  useEffect(() => {
    if (variant === "home" && session && session.messages.length === 0) {
      taRef.current?.focus();
    }
  }, [variant, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(() => modelOptions(store.providers), [store.providers]);
  const selectedValue = store.modelRef ? `${store.modelRef.providerId}:${store.modelRef.model}` : "";
  const effective = options.find((o) => o.value === selectedValue) ?? options[0] ?? null;

  const mode = store.agentModeFor(sessionId);
  const permMode = store.permissionModeFor(sessionId);
  const thinkingLevel = store.thinkingLevelFor(sessionId);
  const queued = sessionId ? (store.queued[sessionId] ?? []) : [];

  // Reasoning ladder: the model's published levels when the provider has been
  // configured for it, otherwise the canonical ladder.
  const thinkingLevels = useMemo<ThinkingLevel[]>(() => {
    const provider = store.providers.find((p) => p.id === store.modelRef?.providerId);
    const configured = store.modelRef
      ? provider?.modelConfigs?.[store.modelRef.model]?.supportedThinkingLevels
      : undefined;
    return configured?.length ? (configured as ThinkingLevel[]) : [...THINKING_LEVELS];
  }, [store.providers, store.modelRef]);

  /* ---------------- autocomplete ---------------- */

  // "/" menu: the host command catalogue (builtin + plugin + skill commands).
  useEffect(() => {
    if (trigger?.mode !== "slash") return;
    let cancelled = false;
    void store
      .searchCommandsRemote(trigger.query)
      .then((rows) => {
        if (!cancelled) setRemoteCommands(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [trigger?.mode, trigger?.query]); // eslint-disable-line react-hooks/exhaustive-deps

  // "@" menu: the project file index.
  useEffect(() => {
    if (trigger?.mode !== "file") return;
    let cancelled = false;
    void store
      .ensureFileIndex(session?.projectPath ?? null)
      .then((paths) => {
        if (!cancelled) setFileCandidates(rankFileCandidates(paths, trigger.query, 8));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [trigger?.mode, trigger?.query, session?.projectPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const slashCandidates = useMemo(() => {
    if (trigger?.mode !== "slash") return [];
    return remoteCommands.slice(0, 8);
  }, [remoteCommands, trigger?.mode]);

  useEffect(() => setAcIndex(0), [trigger?.query, trigger?.mode]);

  const acCount = trigger?.mode === "slash" ? slashCandidates.length : fileCandidates.length;

  const updateAutocomplete = (value: string, cursor: number) => {
    const next = detectTrigger(value, cursor);
    setTrigger(next);
  };

  const applyCommand = (name: string) => {
    const el = taRef.current;
    if (!trigger || !el) return;
    const { value, cursor } = applyCompletion(text, trigger, name);
    setText(value);
    setTrigger(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = cursor;
    });
  };

  const applyFile = (file: string) => {
    const el = taRef.current;
    if (!trigger || !el) return;
    const { value, cursor } = applyCompletion(text, trigger, file);
    setText(value);
    setTrigger(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = cursor;
    });
  };

  const acceptedItem = (index: number): void => {
    if (trigger?.mode === "slash") {
      const command = slashCandidates[index];
      if (command) void runSlashCommand(command);
      return;
    }
    const file = fileCandidates[index];
    if (file) applyFile(file);
  };

  /**
   * Builtin slash commands act immediately (parity: `composerCommands` /
   * `commandPaletteExecute`); plugin and skill commands are inserted as text
   * because they expand into model instructions.
   */
  const runSlashCommand = async (command: SenastrStore["commands"][number]) => {
    setTrigger(null);
    switch (command.id) {
      case "builtin.session.new":
        setText("");
        void store.newSession(session?.projectPath ?? undefined);
        return;
      case "builtin.agent.compact":
        setText("");
        await store.compactContext();
        return;
      case "builtin.mode.agent":
      case "builtin.mode.plan":
      case "builtin.mode.goal": {
        const next: AgentMode =
          command.id === "builtin.mode.plan" ? "plan" : command.id === "builtin.mode.goal" ? "goal" : "build";
        setText("");
        if (sessionId) {
          store.updateSessionPrefs(sessionId, { mode: next });
          void api.session.setMode(sessionId, next).then(() => store.refresh()).catch(() => undefined);
        }
        return;
      }
      case "builtin.project.open":
        setText("");
        await store.openProject();
        return;
      case "builtin.settings.open":
        setText("");
        store.openSettings();
        return;
      case "builtin.view.search":
        setText("");
        store.setSearchOpen(true);
        return;
      case "builtin.view.workpanel":
        setText("");
        store.setWorkPanelOpen(!store.workPanelOpen);
        return;
      case "builtin.view.sidebar":
        setText("");
        store.setSidebarCollapsed(!store.sidebarCollapsed);
        return;
      case "builtin.session.fork":
        setText("");
        if (sessionId) void store.forkSession(sessionId);
        return;
      case "builtin.session.import":
        setText("");
        store.openSettings("import");
        return;
      case "builtin.app.updates":
        setText("");
        store.openSettings("updates");
        void store.checkForUpdates();
        return;
      default:
        break;
    }
    // Plugin / skill commands expand into the prompt.
    const slash = command.slash ?? command.keywords[0] ?? command.title;
    const { value, cursor } = applyCompletion(text, trigger ?? { mode: "slash", query: "", tokenStart: 0, tokenEnd: 0 }, slash);
    setText(value);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = cursor;
    });
  };

  /* ---------------- attachments ---------------- */

  const pickFiles = async () => {
    setPicking(true);
    try {
      const paths = await api.file.pick(session?.projectPath);
      if (paths.length) {
        setAttachments((prev) => [
          ...prev,
          ...paths.map((p) => ({
            id: ++attachSeq,
            label: p.split(/[\\/]/).pop() || p,
            kind: "file" as const,
            path: p,
          })),
        ]);
      }
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    } finally {
      setPicking(false);
    }
  };

  const pickImages = async () => {
    setPicking(true);
    try {
      const photos = await api.file.pickPhotos();
      if (!photos.length) return;
      // Store the bytes in the host so the transcript only carries a store id.
      for (const photo of photos) {
        const stored = await store.addAttachment({
          kind: "image",
          name: photo.name,
          mimeType: photo.mimeType,
          dataBase64: photo.dataBase64,
        });
        if (!stored) continue;
        setAttachments((prev) => [
          ...prev,
          {
            id: ++attachSeq,
            label: photo.name,
            kind: "image",
            storeId: stored.storeId,
            mimeType: photo.mimeType,
            dataBase64: photo.dataBase64,
          },
        ]);
      }
    } catch (err) {
      store.pushNotice(cleanError(err), "error");
    } finally {
      setPicking(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
          void store
            .addAttachment({ kind: "image", name: file.name || "pasted image", mimeType: file.type, dataBase64: base64 })
            .then((stored) => {
              if (!stored) return;
              setAttachments((prev) => [
                ...prev,
                {
                  id: ++attachSeq,
                  label: file.name || "pasted image",
                  kind: "image",
                  storeId: stored.storeId,
                  mimeType: file.type,
                  dataBase64: base64,
                },
              ]);
            });
        };
        reader.readAsDataURL(file);
        return;
      }
    }

    const pasted = e.clipboardData?.getData("text") ?? "";
    const threshold = prefs.largePasteThreshold;
    if (pasted.length >= threshold) {
      e.preventDefault();
      void api.clipboard.recordPaste(pasted).catch(() => undefined);
      const id = ++attachSeq;
      setAttachments((prev) => [
        ...prev,
        { id, label: `Pasted text ${(pasted.length / 1024).toFixed(1)}k`, kind: "paste", content: pasted },
      ]);
      store.pushNotice(`Large paste attached (${pasted.length.toLocaleString()} chars)`, "info");
      return;
    }
    if (pasted.trim()) void api.clipboard.recordPaste(pasted).catch(() => undefined);
  };

  /* ---------------- submit ---------------- */

  const buildPayload = (raw: string): string => {
    let out = raw.trim();
    const fileAtts = attachments.filter((a) => a.kind === "file" && a.path);
    const pasteAtts = attachments.filter((a) => a.kind === "paste" && a.content);
    if (fileAtts.length) {
      out += `\n\n[Attached files — read them for context: ${fileAtts.map((a) => a.path).join(", ")}]`;
    }
    for (const p of pasteAtts) {
      out += `\n\n[Pasted content "${p.label}":]\n\`\`\`\n${p.content}\n\`\`\``;
    }
    return out;
  };

  const submit = () => {
    if (!session) return;
    if (!text.trim() && !attachments.length) return;
    if (!canInteract) return;
    const payload = buildPayload(text);
    const outgoing = attachments
      .filter((a) => a.kind === "image" && a.storeId)
      .map((a) => ({
        id: `att-${a.id}`,
        kind: "image" as const,
        name: a.label,
        mimeType: a.mimeType ?? "image/png",
        storeId: a.storeId,
      }));
    if (store.busy) {
      store.queuePrompt(session.id, payload);
    } else {
      void store.send(payload, outgoing);
    }
    setText("");
    setAttachments([]);
    setTrigger(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && acCount > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acCount) % acCount);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptedItem(acIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    } else if (trigger && e.key === "Escape") {
      e.preventDefault();
      setTrigger(null);
      return;
    }
    const sendKey = store.enterToSend ? e.key === "Enter" && !e.shiftKey : e.key === "Enter" && (e.metaKey || e.ctrlKey);
    if (sendKey) {
      e.preventDefault();
      submit();
    }
  };

  if (!session) return null;

  const canInteract = options.length > 0 && Boolean(session.projectPath);

  if (!canInteract) {
    return (
      <div className="composer-hint">
        {options.length === 0 ? (
          <>
            <span>Add or enable a model provider to start chatting.</span>
            <button type="button" className="btn primary" onClick={() => store.setView("settings")}>
              Open settings
            </button>
          </>
        ) : (
          <>
            <span>Open a project folder to get started.</span>
            <button type="button" className="btn primary" onClick={() => void store.openProject()}>
              Open project…
            </button>
          </>
        )}
      </div>
    );
  }

  const stats = store.contextStats;

  return (
    <div className={`composer-shell ${variant}`}>
      {mode === "plan" && (
        <div className="plan-banner">
          <IconSparkles size={13} />
          <span>Plan mode — the agent will propose a plan and won't change anything until you ask.</span>
        </div>
      )}
      {mode === "goal" && (
        <div className="plan-banner goal">
          <IconZap size={13} />
          <span>Goal mode — state the outcome and acceptance criteria; the agent chooses the path.</span>
        </div>
      )}
      {queued.length > 0 && (
        <div className="queued-list">
          {queued.map((q) => (
            <div key={q.id} className="queued-item">
              <span className="queued-label">Queued</span>
              <span className="queued-text" title={q.text}>
                {q.text.slice(0, 120)}
                {q.text.length > 120 ? "…" : ""}
              </span>
              <button
                type="button"
                className="queued-remove"
                aria-label="Remove queued prompt"
                onClick={() => store.removeQueuedPrompt(session.id, q.id)}
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <span key={a.id} className={cx("attach-chip", a.kind === "image" && "image")} title={a.path ?? a.label}>
                {a.kind === "image" && a.dataBase64 ? (
                  <img className="attach-thumb" src={`data:${a.mimeType};base64,${a.dataBase64}`} alt="" />
                ) : (
                  <IconFile size={12} />
                )}
                {a.label}
                <button
                  type="button"
                  aria-label={`Remove ${a.label}`}
                  onClick={() => {
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                    if (a.storeId) void api.attachment.remove(a.storeId).catch(() => undefined);
                  }}
                >
                  <IconX size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-input-wrap">
          <textarea
            ref={taRef}
            rows={1}
            data-testid="composer-input"
            placeholder={
              store.busy
                ? "Type to queue the next prompt… (Enter to queue)"
                : `Ask senastr to work on this project…  (/ commands · @ files · ${
                    store.enterToSend ? "Enter to send" : "Ctrl+Enter to send"
                  })`
            }
            value={text}
            onChange={(e) => {
              const next = rewriteIdeographicCommaTrigger(e.target.value);
              setText(next);
              updateAutocomplete(next, e.target.selectionStart ?? next.length);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={(e) => updateAutocomplete(text, e.currentTarget.selectionStart ?? text.length)}
          />
          {trigger && acCount > 0 && (
            <div
              className="composer-ac"
              role="listbox"
              aria-label={trigger.mode === "slash" ? "Command suggestions" : "File suggestions"}
            >
              <div className="composer-ac-head">
                {trigger.mode === "slash" ? "Commands" : "Reference a file in this project"}
              </div>
              {trigger.mode === "slash"
                ? slashCandidates.map((command, i) => (
                    <button
                      key={command.id}
                      type="button"
                      role="option"
                      aria-selected={i === acIndex}
                      className={cx("composer-ac-item", i === acIndex && "active")}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        void runSlashCommand(command);
                      }}
                      onMouseEnter={() => setAcIndex(i)}
                    >
                      <IconTerminal size={13} />
                      <span className="ac-title">{command.title}</span>
                      {command.slash ? <span className="ac-slash">/{command.slash}</span> : null}
                      {command.category ? <span className="ac-cat">{command.category}</span> : null}
                    </button>
                  ))
                : fileCandidates.map((file, i) => (
                    <button
                      key={file}
                      type="button"
                      role="option"
                      aria-selected={i === acIndex}
                      className={cx("composer-ac-item", i === acIndex && "active")}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyFile(file);
                      }}
                      onMouseEnter={() => setAcIndex(i)}
                    >
                      <IconFile size={13} />
                      <span title={file}>{file}</span>
                    </button>
                  ))}
            </div>
          )}
        </div>
        <div className="composer-toolbar">
          <div className="composer-left">
            <TooltipButton
              type="button"
              className="icon-btn"
              tooltip="Attach files"
              disabled={picking}
              onClick={() => void pickFiles()}
            >
              <IconPlus size={15} />
            </TooltipButton>
            <TooltipButton
              type="button"
              className="icon-btn"
              tooltip="Attach images (multimodal models)"
              disabled={picking}
              onClick={() => void pickImages()}
            >
              <IconFile size={14} />
            </TooltipButton>
            <Menu
              label="Agent mode"
              open={modeMenuOpen}
              onClose={() => setModeMenuOpen(false)}
              trigger={(ref) => (
                <TooltipButton
                  ref={ref as React.RefObject<HTMLButtonElement>}
                  type="button"
                  className={cx("mode-chip", mode, modeMenuOpen && "active")}
                  tooltip={`${MODE_META[mode].label}: ${MODE_META[mode].hint}`}
                  aria-haspopup="menu"
                  aria-expanded={modeMenuOpen}
                  onClick={() => setModeMenuOpen((v) => !v)}
                >
                  <IconZap size={13} />
                  <span>{MODE_META[mode].label}</span>
                  <IconChevronDown size={11} />
                </TooltipButton>
              )}
            >
              <MenuHeading>Mode · this session</MenuHeading>
              {MODE_ORDER.map((key) => (
                <MenuItem
                  key={key}
                  checked={mode === key}
                  icon={mode === key ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
                  hint={MODE_META[key].hint}
                  onClick={() => {
                    setModeMenuOpen(false);
                    store.updateSessionPrefs(session.id, { mode: key });
                    void api.session
                      .setMode(session.id, key)
                      .then(() => store.refresh())
                      .catch((err) => store.pushNotice(cleanError(err), "error"));
                  }}
                >
                  {MODE_META[key].label}
                </MenuItem>
              ))}
            </Menu>
            <Menu
              label="Reasoning level"
              open={thinkMenuOpen}
              onClose={() => setThinkMenuOpen(false)}
              trigger={(ref) => (
                <TooltipButton
                  ref={ref as React.RefObject<HTMLButtonElement>}
                  type="button"
                  className={cx("mode-chip think", thinkMenuOpen && "active")}
                  tooltip={thinkingLevel ? THINKING_META[thinkingLevel] : "Model default reasoning"}
                  aria-haspopup="menu"
                  aria-expanded={thinkMenuOpen}
                  onClick={() => setThinkMenuOpen((v) => !v)}
                >
                  <IconSparkles size={13} />
                  <span>{thinkingLevel ? thinkingLevel : "auto"}</span>
                  <IconChevronDown size={11} />
                </TooltipButton>
              )}
            >
              <MenuHeading>Reasoning · this session</MenuHeading>
              <MenuItem
                checked={thinkingLevel === null}
                icon={thinkingLevel === null ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
                hint="Let the model and its configuration decide"
                onClick={() => {
                  setThinkMenuOpen(false);
                  void store.setThinkingLevel(session.id, null);
                }}
              >
                Model default
              </MenuItem>
              {thinkingLevels.map((level) => (
                <MenuItem
                  key={level}
                  checked={thinkingLevel === level}
                  icon={thinkingLevel === level ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
                  hint={THINKING_META[level]}
                  onClick={() => {
                    setThinkMenuOpen(false);
                    void store.setThinkingLevel(session.id, level);
                  }}
                >
                  {level}
                </MenuItem>
              ))}
            </Menu>
            <Menu
              label="Permission mode"
              open={permMenuOpen}
              onClose={() => setPermMenuOpen(false)}
              trigger={(ref) => (
                <TooltipButton
                  ref={ref as React.RefObject<HTMLButtonElement>}
                  type="button"
                  className={`mode-chip perm ${permMenuOpen ? "active" : ""}`}
                  tooltip={`Permission mode: ${PERM_META[permMode].hint}`}
                  aria-haspopup="menu"
                  aria-expanded={permMenuOpen}
                  onClick={() => setPermMenuOpen((v) => !v)}
                >
                  <IconShield size={13} />
                  <span>{PERM_META[permMode].label}</span>
                  <IconChevronDown size={11} />
                </TooltipButton>
              )}
            >
              <MenuHeading>Permission mode · this session</MenuHeading>
              {(Object.keys(PERM_META) as PermissionMode[]).map((key) => (
                <MenuItem
                  key={key}
                  checked={permMode === key}
                  icon={permMode === key ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
                  hint={PERM_META[key].hint}
                  onClick={() => {
                    store.updateSessionPrefs(session.id, { permissionMode: key });
                    setPermMenuOpen(false);
                  }}
                >
                  {PERM_META[key].label}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                icon={<IconSettings size={13} />}
                onClick={() => {
                  setPermMenuOpen(false);
                  store.setView("settings");
                }}
              >
                Review standing grants…
              </MenuItem>
            </Menu>
            <Menu
              label="Model"
              open={modelMenuOpen}
              onClose={() => setModelMenuOpen(false)}
              trigger={(ref) => (
                <TooltipButton
                  ref={ref as React.RefObject<HTMLButtonElement>}
                  type="button"
                  className="model-chip"
                  tooltip={effective ? `${effective.provider} · ${effective.model}` : "Select model"}
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  onClick={() => setModelMenuOpen((v) => !v)}
                >
                  <IconBot size={13} />
                  <span>{effective ? effective.model : "No model"}</span>
                  <IconChevronDown size={11} />
                </TooltipButton>
              )}
            >
              <ModelMenuContent
                store={store}
                options={options}
                selectedValue={effective?.value ?? ""}
                onPick={(value) => {
                  const [providerId, ...rest] = value.split(":");
                  store.setModelRef({ providerId, model: rest.join(":") });
                  setModelMenuOpen(false);
                }}
              />
            </Menu>
            <Menu
              label="Context usage"
              open={ctxMenuOpen}
              onClose={() => setCtxMenuOpen(false)}
              trigger={(ref) => (
                <TooltipButton
                  ref={ref as React.RefObject<HTMLButtonElement>}
                  type="button"
                  className="ctx-pill"
                  tooltip="Estimated context usage"
                  aria-haspopup="menu"
                  aria-expanded={ctxMenuOpen}
                  onClick={() => setCtxMenuOpen((v) => !v)}
                >
                  {formatTokens(stats.tokens)}
                </TooltipButton>
              )}
            >
              <MenuHeading>Context (estimated)</MenuHeading>
              <div className="ctx-rows">
                <div>
                  <span>Tokens</span>
                  <strong>~{stats.tokens.toLocaleString()}</strong>
                </div>
                <div>
                  <span>Messages</span>
                  <strong>{stats.messages}</strong>
                </div>
                <div>
                  <span>Tool calls</span>
                  <strong>{stats.tools}</strong>
                </div>
                {store.lastUsage?.inputTokens != null || store.lastUsage?.outputTokens != null ? (
                  <>
                    <div>
                      <span>Last turn in/out</span>
                      <strong>
                        {store.lastUsage?.inputTokens ?? "?"} / {store.lastUsage?.outputTokens ?? "?"}
                      </strong>
                    </div>
                  </>
                ) : null}
              </div>
            </Menu>
          </div>
          <div className="composer-right">
            {!store.busy && text.trim() ? (
              <TooltipButton
                type="button"
                className="icon-btn enhance-btn"
                tooltip="Enhance prompt with AI"
                disabled={enhancing}
                onClick={() => {
                  const draft = text;
                  setEnhancing(true);
                  void store
                    .enhancePrompt(draft)
                    .then((out) => {
                      if (out) {
                        setText(out);
                        store.pushNotice("Prompt enhanced", "info");
                      }
                    })
                    .finally(() => setEnhancing(false));
                }}
              >
                <IconSparkles size={14} className={enhancing ? "spin" : ""} />
              </TooltipButton>
            ) : null}
            {store.busy ? (
              <TooltipButton type="button" className="send-btn stop" tooltip="Stop" onClick={() => store.stop()}>
                <IconStop size={14} />
              </TooltipButton>
            ) : (
              <TooltipButton
                type="button"
                className={`send-btn ${text.trim() || attachments.length ? "has-text" : ""}`}
                tooltip={store.enterToSend ? "Send (Enter)" : "Send (Ctrl+Enter)"}
                disabled={!text.trim() && !attachments.length}
                onClick={submit}
              >
                <IconSend size={14} />
              </TooltipButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelMenuContent({
  store,
  options,
  selectedValue,
  onPick,
}: {
  store: SenastrStore;
  options: ModelOption[];
  selectedValue: string;
  onPick: (value: string) => void;
}) {
  const groups = new Map<string, ModelOption[]>();
  for (const o of options) {
    if (!groups.has(o.provider)) groups.set(o.provider, []);
    groups.get(o.provider)!.push(o);
  }
  return (
    <>
      <MenuHeading>Model · this turn</MenuHeading>
      {[...groups.entries()].map(([provider, items]) => (
        <div key={provider}>
          <div className="model-group">{provider}</div>
          {items.map((o) => (
            <MenuItem
              key={o.value}
              className="model-pick"
              checked={o.value === selectedValue}
              icon={o.value === selectedValue ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
              onClick={() => onPick(o.value)}
            >
              {o.model}
            </MenuItem>
          ))}
        </div>
      ))}
      <MenuSeparator />
      <MenuItem
        icon={<IconSettings size={13} />}
        onClick={() => {
          store.setView("settings");
        }}
      >
        Manage providers…
      </MenuItem>
    </>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
