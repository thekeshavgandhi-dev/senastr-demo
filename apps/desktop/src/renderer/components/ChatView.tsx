import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ToolCall, ToolResult } from "@senastr/shared";
import type { SenastrStore, StreamState } from "../hooks/useSenastr";
import { toolMessageToResult } from "../hooks/useSenastr";
import { projectDisplayName } from "../lib/prefs";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { OnboardingChecklist } from "./OnboardingChecklist";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconFile,
  IconFolderOpen,
  IconHelp,
  IconNewSession,
  IconPlug,
  IconRefresh,
  IconServer,
  IconSettings,
  IconSparkles,
  IconTerminal,
  IconUsers,
  IconX,
} from "./icons";
import { TooltipButton, cx } from "./ui";

/* ------------------------------------------------------------------ */
/* transcript model                                                    */
/* ------------------------------------------------------------------ */

interface Item {
  kind: "user" | "assistant" | "stream";
  msg?: ChatMessage;
  blocks?: Array<{ call: ToolCall; result?: ToolResult }>;
  stream?: StreamState;
}

function buildItems(messages: ChatMessage[], stream: StreamState | null): Item[] {
  const toolByCall = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) toolByCall.set(m.toolCallId, m);
  }
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ kind: "user", msg: m });
    } else if (m.role === "assistant") {
      const blocks = (m.toolCalls ?? []).map((call) => ({
        call,
        result: toolMessageToResult(toolByCall.get(call.id)),
      }));
      items.push({ kind: "assistant", msg: m, blocks });
    }
  }
  if (stream) items.push({ kind: "stream", stream });
  return items;
}

/* ------------------------------------------------------------------ */
/* tool rows                                                           */
/* ------------------------------------------------------------------ */

function toolIcon(name: string, size = 13) {
  if (name === "run_command") return <IconTerminal size={size} />;
  if (name === "read_file" || name === "write_file" || name === "list_dir") return <IconFile size={size} />;
  if (name === "ask_user") return <IconHelp size={size} />;
  if (name === "submit_plan") return <IconSparkles size={size} />;
  if (name === "Task") return <IconUsers size={size} />;
  if (name.startsWith("mcp_")) return <IconServer size={size} />;
  return <IconPlug size={size} />;
}

function toolLabel(name: string): string {
  if (name === "ask_user") return "Asked you";
  if (name === "submit_plan") return "Submitted plan";
  if (name === "Task") return "Subagent";
  return name;
}

function toolSummary(call: ToolCall): string {
  const a = (call.arguments ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  if (call.name === "read_file" || call.name === "write_file" || call.name === "list_dir") {
    return str(a.path ?? a.file ?? a.dir) || "";
  }
  if (call.name === "run_command") {
    return str(a.command ?? a.cmd) || "";
  }
  if (call.name === "ask_user") {
    const qs = Array.isArray(a.questions) ? a.questions : [];
    const first = qs[0] as { question?: unknown } | undefined;
    return typeof first?.question === "string" ? first.question : `${qs.length} question${qs.length === 1 ? "" : "s"}`;
  }
  if (call.name === "submit_plan") {
    return str(a.summary) || "";
  }
  if (call.name === "Task") {
    return str(a.description) || (typeof a.subagent === "string" ? a.subagent : "");
  }
  const keys = Object.keys(a);
  if (!keys.length) return "";
  const first = keys[0];
  const val = str(a[first]);
  return val.length > 80 ? `${first}: ${val.slice(0, 80)}…` : `${first}: ${val}`;
}

function ToolRow({ call, result, live }: { call: ToolCall; result?: ToolResult; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const status = result ? (result.ok ? "ok" : "fail") : "running";
  const summary = toolSummary(call);
  return (
    <div className={cx("tool-row", status)}>
      <button type="button" className="tool-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-row-icon">{toolIcon(call.name)}</span>
        <span className="tool-row-name" title={call.name}>{toolLabel(call.name)}</span>
        {summary ? (
          <span className="tool-row-summary" title={summary}>
            {summary}
          </span>
        ) : null}
        <span className="tool-row-status">
          {result ? (result.ok ? "done" : "failed") : live ? "running…" : "…"}
          {result && result.durationMs > 0 ? ` · ${result.durationMs}ms` : ""}
        </span>
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="tool-row-body">
          <div className="tool-row-args">
            <span>args</span>
            <pre>{JSON.stringify(call.arguments ?? {}, null, 2)}</pre>
          </div>
          {result && (
            <div className="tool-row-args">
              <span>{result.ok ? "output" : "error"}</span>
              <pre className={result.ok ? "" : "err"}>{result.ok ? result.output || "(empty)" : result.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <TooltipButton
      className="msg-copy"
      tooltip={copied ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </TooltipButton>
  );
}

/* ------------------------------------------------------------------ */
/* transcript                                                          */
/* ------------------------------------------------------------------ */

export const Transcript = memo(function Transcript({ store }: { store: SenastrStore }) {
  const { activeSession } = store;
  const stream = activeSession && store.streamSessionId === activeSession.id ? store.stream : null;
  const showBusy = store.busy && stream != null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const items = useMemo(() => buildItems(activeSession?.messages ?? [], stream), [activeSession, stream]);

  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeSession?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowJump(!stickToBottom.current);
  };

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="transcript-wrap">
      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        {items.map((item, i) => {
          if (item.kind === "user") {
            return (
              <div key={item.msg!.id} className="msg user">
                <div className="bubble">{item.msg!.content}</div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            const msg = item.msg!;
            return (
              <div key={msg.id} className="msg assistant">
                {item.blocks && item.blocks.length > 0 && (
                  <div className="tool-rows">
                    {item.blocks.map((b) => (
                      <ToolRow key={b.call.id} call={b.call} result={b.result} />
                    ))}
                  </div>
                )}
                {msg.content ? (
                  <div className="assistant-text">
                    <Markdown text={msg.content} />
                    <CopyButton text={msg.content} />
                  </div>
                ) : null}
              </div>
            );
          }
          const s = item.stream!;
          return (
            <div key={`stream-${i}`} className="msg assistant streaming">
              {s.blocks.length > 0 && (
                <div className="tool-rows">
                  {s.blocks.map((b) => (
                    <ToolRow key={b.call.id} call={b.call} result={b.result} live />
                  ))}
                </div>
              )}
              {s.text ? (
                <div className="assistant-text">
                  <Markdown text={s.text} />
                  {showBusy && <span className="cursor" />}
                </div>
              ) : (
                <div className="assistant-text pending">
                  thinking…
                  {showBusy && <span className="cursor" />}
                </div>
              )}
            </div>
          );
        })}
        {store.lastStopReason && store.lastStopReason !== "stop" && !store.busy && (
          <TurnOutcome store={store} />
        )}
      </div>
      {showJump && (
        <button type="button" className="jump-latest" onClick={jump}>
          <IconChevronDown size={14} />
          Latest
        </button>
      )}
    </div>
  );
});

function TurnOutcome({ store }: { store: SenastrStore }) {
  const reason = store.lastStopReason;
  if (reason !== "aborted" && reason !== "max-steps") return null;
  return (
    <div className="turn-outcome">
      <IconAlert size={14} />
      <span>
        {reason === "aborted" ? "Turn stopped." : "Stopped: step limit reached."}
      </span>
      <button type="button" className="turn-outcome-btn" onClick={() => store.retryLast()}>
        <IconRefresh size={12} />
        Retry
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* chat surface: home hero vs transcript + error layer                 */
/* ------------------------------------------------------------------ */

export function ChatSurface({ store }: { store: SenastrStore }) {
  const { activeSession } = store;
  const stream = activeSession && store.streamSessionId === activeSession.id ? store.stream : null;

  if (!activeSession) {
    return (
      <div className="chat-surface">
        <div className="home-main">
          <div className="home-scroll">
            <div className="empty-hero">
              <div className="empty-hero-icon" aria-hidden>
                <span className="mascot">s</span>
              </div>
              <h1>Local-first coding agent</h1>
              <p>Bring your own model. Open any local project. Stay in control.</p>
              <div className="home-cta-row">
                <button type="button" className="btn primary" onClick={() => void store.newSession()}>
                  <IconNewSession size={14} />
                  New session
                </button>
                <button type="button" className="btn" onClick={() => void store.openProject()}>
                  <IconFolderOpen size={14} />
                  Open project…
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const hasTranscript =
    activeSession.messages.length > 0 || Boolean(stream && (stream.text || stream.blocks.length));
  const showEmpty = !hasTranscript && !store.busy;
  const project = activeSession.projectPath
    ? projectDisplayName(activeSession.projectPath, store.projectMeta[activeSession.projectPath])
    : null;

  return (
    <div className="chat-surface">
      {showEmpty ? (
        <div className="home-main">
          <div className="home-scroll">
            <div className="empty-hero">
              <div className="empty-hero-icon" aria-hidden>
                <span className="mascot">s</span>
              </div>
              <h1>{project ? <>What should we do in <span className="hero-project">{project}</span>?</> : "What should we build?"}</h1>
            </div>
            <OnboardingChecklist store={store} />
          </div>
          <div className="home-composer">
            <Composer store={store} variant="home" />
          </div>
        </div>
      ) : (
        <div className="docked-wrap">
          <Transcript store={store} />
          <Composer store={store} variant="docked" />
        </div>
      )}

      {store.lastError && !store.busy && (
        <div className="chat-error-layer">
          <div className="chat-error-notice">
            <span className="chat-error-text" title={store.lastError.text}>
              {store.lastError.text}
            </span>
            <button type="button" className="chat-error-action" onClick={() => store.openSettings("models")}>
              Settings
            </button>
            <button type="button" className="chat-error-action" onClick={() => store.retryLast()}>
              Retry
            </button>
            <TooltipButton
              type="button"
              tooltip="Dismiss"
              className="chat-error-dismiss"
              onClick={() => store.clearError()}
            >
              <IconX size={13} />
            </TooltipButton>
          </div>
        </div>
      )}
    </div>
  );
}
