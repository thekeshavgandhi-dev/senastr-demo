import { useEffect, useMemo, useRef } from "react";
import type { ChatMessage, ToolCall, ToolResult } from "@senastr/shared";
import type { SenastrStore, StreamState } from "../hooks/useSenastr";
import { toolMessageToResult } from "../hooks/useSenastr";
import { Composer, modelOptions } from "./Composer";

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
    // tool messages are rendered inside the assistant's blocks
  }
  if (stream) items.push({ kind: "stream", stream });
  return items;
}

export function ChatView({ store }: { store: SenastrStore }) {
  const { activeSession, stream, busy, providers, modelRef, setModelRef, send, stop } = store;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const items = useMemo(
    () => buildItems(activeSession?.messages ?? [], stream),
    [activeSession, stream],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!activeSession) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-card">
          <h1>senastr</h1>
          <p>
            Create a session and open a project folder, then bring your own model — OpenAI, Anthropic, or any
            OpenAI-compatible endpoint.
          </p>
          <button className="btn primary" onClick={() => void store.newSession()}>
            + New session
          </button>
        </div>
      </div>
    );
  }

  const options = modelOptions(providers);
  const canSend = Boolean(activeSession.projectPath) && options.length > 0 && !busy;

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-title" title={activeSession.title}>
          {activeSession.title}
        </div>
        <div className="chat-project" title={activeSession.projectPath ?? "no project"}>
          {activeSession.projectPath ?? "no project open"}
        </div>
      </header>

      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 && (
          <div className="messages-empty">
            {activeSession.projectPath
              ? "Ask senastr to inspect, modify or run things in this project."
              : "Open a project folder to get started."}
          </div>
        )}
        {items.map((item, i) => {
          if (item.kind === "user") {
            return (
              <div key={item.msg!.id} className="msg user">
                <div className="bubble">{item.msg!.content}</div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.msg!.id} className="msg assistant">
                {item.blocks && item.blocks.length > 0 && <ToolBlocks blocks={item.blocks} />}
                {item.msg!.content && <div className="assistant-text">{item.msg!.content}</div>}
              </div>
            );
          }
          // live stream
          return (
            <div key={`stream-${i}`} className="msg assistant streaming">
              {item.stream!.blocks.length > 0 && <ToolBlocks blocks={item.stream!.blocks} live />}
              {item.stream!.text && <div className="assistant-text">{item.stream!.text}</div>}
              {item.stream!.text === "" && item.stream!.blocks.length === 0 && (
                <div className="assistant-text pending">thinking…</div>
              )}
              {busy && <span className="cursor" />}
            </div>
          );
        })}
      </div>

      <Composer
        busy={busy}
        canSend={canSend}
        hint={
          options.length === 0
            ? "Add or enable a model provider in Settings to start chatting"
            : !activeSession.projectPath
              ? "Open a project folder to get started"
              : undefined
        }
        options={options}
        value={modelRef}
        onChange={setModelRef}
        onSend={(text) => void send(text)}
        onStop={stop}
      />
    </div>
  );
}

function ToolBlocks({ blocks, live }: { blocks: Array<{ call: ToolCall; result?: ToolResult }>; live?: boolean }) {
  return (
    <div className="tool-blocks">
      {blocks.map((b, i) => (
        <details key={b.call.id} className={`tool-block ${b.result ? (b.result.ok ? "ok" : "fail") : "running"}`}>
          <summary>
            <span className="tool-name">{b.call.name}</span>
            <span className="tool-args">
              {JSON.stringify(b.call.arguments)
                .slice(0, 90)
                .replace(/\s+/g, " ")}
            </span>
            <span className="tool-status">
              {b.result ? (b.result.ok ? "done" : "failed") : live ? "running…" : "…"}
            </span>
          </summary>
          {b.result && (
            <pre className="tool-output">{b.result.ok ? b.result.output : b.result.error}</pre>
          )}
        </details>
      ))}
    </div>
  );
}
