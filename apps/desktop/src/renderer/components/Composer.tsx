import { useEffect, useMemo, useRef, useState } from "react";
import type { SenastrStore } from "../hooks/useSenastr";
import { api, cleanError } from "../lib/api";
import { loadRaw, prefs, type AgentMode, type PermissionMode } from "../lib/prefs";
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
  kind: "file" | "paste";
  path?: string;
  content?: string;
}

const MODE_META: Record<AgentMode, { label: string; hint: string }> = {
  build: { label: "Build", hint: "Agent can inspect, edit and run" },
  plan: { label: "Plan", hint: "Plan only — no changes without asking" },
};

const PERM_META: Record<PermissionMode, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Approve every privileged tool" },
  "accept-edits": { label: "Accept edits", hint: "Auto-approve file writes, ask for commands" },
  auto: { label: "Auto", hint: "Auto-approve all tools in this session" },
};

let attachSeq = 0;

export function Composer({ store, variant = "docked" }: { store: SenastrStore; variant?: "home" | "docked" }) {
  const session = store.activeSession;
  const sessionId = session?.id ?? null;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [ctxMenuOpen, setCtxMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // autocomplete state
  const [acOpen, setAcOpen] = useState(false);
  const [acIndex, setAcIndex] = useState(0);
  const [acQuery, setAcQuery] = useState("");

  // Load draft when switching sessions.
  useEffect(() => {
    setAttachments([]);
    setAcOpen(false);
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
  const queued = sessionId ? (store.queued[sessionId] ?? []) : [];

  const touchedFiles = useMemo(() => {
    const files = new Set<string>();
    for (const m of session?.messages ?? []) {
      for (const c of m.toolCalls ?? []) {
        const a = (c.arguments ?? {}) as Record<string, unknown>;
        const p = a.path ?? a.file;
        if ((c.name === "read_file" || c.name === "write_file") && typeof p === "string" && p) files.add(p);
      }
    }
    return [...files].slice(-30).reverse();
  }, [session?.messages]); // eslint-disable-line react-hooks/exhaustive-deps

  const acItems = useMemo(() => {
    const q = acQuery.toLowerCase();
    return touchedFiles.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 8);
  }, [touchedFiles, acQuery]);

  if (!session) return null;

  const canInteract = options.length > 0 && Boolean(session.projectPath);

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
    if (!text.trim() && !attachments.length) return;
    if (!canInteract) return;
    const payload = buildPayload(text);
    if (store.busy) {
      store.queuePrompt(session.id, payload);
    } else {
      void store.send(payload);
    }
    setText("");
    setAttachments([]);
    setAcOpen(false);
  };

  const pickFiles = async () => {
    setPicking(true);
    try {
      const paths = await api.file.pick(session.projectPath);
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

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData?.getData("text") ?? "";
    const threshold = prefs.largePasteThreshold;
    if (pasted.length >= threshold) {
      e.preventDefault();
      const id = ++attachSeq;
      setAttachments((prev) => [...prev, { id, label: `Pasted text ${(pasted.length / 1024).toFixed(1)}k`, kind: "paste", content: pasted }]);
      store.pushNotice(`Large paste attached (${pasted.length.toLocaleString()} chars)`, "info");
    }
  };

  const updateAutocomplete = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const m = before.match(/(^|\s)@([\w\-./]*)$/);
    if (m && touchedFiles.length) {
      setAcQuery(m[2]);
      setAcIndex(0);
      setAcOpen(true);
    } else {
      setAcOpen(false);
    }
  };

  const applyAcItem = (file: string) => {
    const el = taRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? text.length;
    const before = text.slice(0, cursor).replace(/(^|\s)@[\w\-./]*$/, `$1@${file} `);
    const next = before + text.slice(cursor);
    setText(next);
    setAcOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acOpen && acItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyAcItem(acItems[acIndex] ?? acItems[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAcOpen(false);
        return;
      }
    }
    const sendKey = store.enterToSend ? e.key === "Enter" && !e.shiftKey : e.key === "Enter" && (e.metaKey || e.ctrlKey);
    if (sendKey) {
      e.preventDefault();
      submit();
    }
  };

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
      {queued.length > 0 && (
        <div className="queued-list">
          {queued.map((q) => (
            <div key={q.id} className="queued-item">
              <span className="queued-label">Queued</span>
              <span className="queued-text" title={q.text}>{q.text.slice(0, 120)}{q.text.length > 120 ? "…" : ""}</span>
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
              <span key={a.id} className="attach-chip" title={a.path ?? a.label}>
                <IconFile size={12} />
                {a.label}
                <button
                  type="button"
                  aria-label={`Remove ${a.label}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
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
                : `Ask senastr to work on this project…  (${store.enterToSend ? "Enter to send" : "Ctrl+Enter to send"})`
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              updateAutocomplete(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={(e) => updateAutocomplete(text, e.currentTarget.selectionStart ?? text.length)}
          />
          {acOpen && acItems.length > 0 && (
            <div className="composer-ac" role="listbox" aria-label="File suggestions">
              <div className="composer-ac-head">Reference a file from this session</div>
              {acItems.map((f, i) => (
                <button
                  key={f}
                  type="button"
                  role="option"
                  aria-selected={i === acIndex}
                  className={cx("composer-ac-item", i === acIndex && "active")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyAcItem(f);
                  }}
                  onMouseEnter={() => setAcIndex(i)}
                >
                  <IconFile size={13} />
                  <span title={f}>{f}</span>
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
              className={`mode-chip ${mode}`}
              tooltip={`${MODE_META[mode].label}: ${MODE_META[mode].hint} — click to switch`}
              onClick={() => store.updateSessionPrefs(session.id, { mode: mode === "build" ? "plan" : "build" })}
            >
              <IconZap size={13} />
              <span>{MODE_META[mode].label}</span>
            </TooltipButton>
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
                <div><span>Tokens</span><strong>~{stats.tokens.toLocaleString()}</strong></div>
                <div><span>Messages</span><strong>{stats.messages}</strong></div>
                <div><span>Tool calls</span><strong>{stats.tools}</strong></div>
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
