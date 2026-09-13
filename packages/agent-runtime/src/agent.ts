import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type ChatMessage,
  type ToolCall,
  type TurnStopReason,
  type Usage,
} from "@senastr/shared";
import type { AgentOptions, HostBridge, ModelSpec, Provider } from "./types";
import { createProvider } from "./providers/factory";
import { defaultSystemPrompt } from "./messages";

export interface TurnParams {
  sessionId: string;
  userMessage: string;
  model: ModelSpec;
}

const DEFAULT_MAX_STEPS = 24;

/**
 * The senastr agent loop.
 *
 * One turn:
 *   user message → (model → tool calls → results)* → final answer
 *
 * The runtime never touches disk or the network directly for project work:
 * model I/O goes through the provider (with the API key resolved by the
 * caller), everything else goes through the HostBridge, which enforces
 * project confinement and the permission layer.
 *
 * All transcript writes happen here (single writer per session), so the
 * host store and the UI can stay in lockstep by re-reading after a turn.
 */
export class AgentRuntime {
  private active = new Map<string, AbortController>();

  constructor(
    private readonly host: HostBridge,
    private readonly opts: AgentOptions = {},
  ) {}

  private makeProvider(spec: ModelSpec): Provider {
    return this.opts.providerFactory ? this.opts.providerFactory(spec) : createProvider(spec);
  }

  async *runTurn(params: TurnParams): AsyncGenerator<AgentEvent> {
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;
    const session = await this.host.getSession(params.sessionId);
    if (!session.projectPath) {
      throw new Error("session has no project set — open a project first");
    }
    if (!params.model.model) {
      throw new Error("no model selected");
    }

    const abort = new AbortController();
    this.active.set(session.id, abort);
    const usage: Usage = {};
    let stopReason: TurnStopReason = "stop";
    let errorText: string | undefined;

    try {
      yield { type: "turn/start", sessionId: session.id, turnId: randomUUID() };
      await this.host.appendMessages(session.id, [makeMessage("user", params.userMessage)]);

      const provider = this.makeProvider(params.model);
      let step = 0;

      for (;;) {
        step += 1;
        const tools = await this.host.listTools();
        const history = (await this.host.getSession(session.id)).messages;
        const system = defaultSystemPrompt(session.projectPath!);

        let text = "";
        const calls: ToolCall[] = [];

        for await (const evt of provider.streamChat({
          model: params.model.model,
          system,
          messages: history,
          tools,
          signal: abort.signal,
        })) {
          if (evt.kind === "text") {
            text += evt.delta;
            yield { type: "assistant/delta", delta: evt.delta };
          } else if (evt.kind === "tool-call") {
            calls.push({ id: evt.id, name: evt.name, arguments: evt.arguments });
          } else if (evt.kind === "done") {
            addUsage(usage, evt.usage);
          }
        }

        if (abort.signal.aborted) {
          stopReason = "aborted";
        }

        if (calls.length === 0) {
          await this.host.appendMessages(session.id, [makeMessage("assistant", text)]);
          if (stopReason !== "aborted") stopReason = "stop";
          break;
        }

        await this.host.appendMessages(session.id, [makeMessage("assistant", text, calls)]);
        for (const call of calls) {
          if (abort.signal.aborted) break;
          yield { type: "tool/call", call };
          const result = await this.host.runTool({
            sessionId: session.id,
            tool: call.name,
            args: call.arguments,
          });
          yield { type: "tool/result", callId: call.id, ok: result.ok, result };
          const toolMessage: ChatMessage = {
            id: randomUUID(),
            role: "tool",
            content: result.ok ? result.output ?? "" : `ERROR: ${result.error ?? "tool failed"}`,
            createdAt: Date.now(),
            toolCallId: call.id,
            toolName: call.name,
          };
          await this.host.appendMessages(session.id, [toolMessage]);
        }

        if (abort.signal.aborted) {
          stopReason = "aborted";
          break;
        }
        if (step >= maxSteps) {
          stopReason = "max-steps";
          break;
        }
      }
    } catch (err) {
      stopReason = abort.signal.aborted ? "aborted" : "error";
      errorText = err instanceof Error ? err.message : String(err);
    } finally {
      this.active.delete(session.id);
      yield { type: "turn/end", stopReason, usage, error: errorText };
    }
  }

  /** Stop the in-flight turn for a session. Returns true if one was running. */
  stop(sessionId: string): boolean {
    const controller = this.active.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

function makeMessage(role: ChatMessage["role"], content: string, toolCalls?: ToolCall[]): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function addUsage(total: Usage, part?: Usage): void {
  if (!part) return;
  if (typeof part.inputTokens === "number") total.inputTokens = (total.inputTokens ?? 0) + part.inputTokens;
  if (typeof part.outputTokens === "number") total.outputTokens = (total.outputTokens ?? 0) + part.outputTokens;
}
