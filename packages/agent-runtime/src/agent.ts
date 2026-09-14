import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type AskAnswers,
  type AskQuestion,
  type AskRequest,
  type ChatMessage,
  type DelegationSummary,
  type DelegationStatus,
  type PlanProposal,
  type ProjectContext,
  type SkillRecord,
  type SubagentRecord,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type TurnStopReason,
  type Usage,
} from "@senastr/shared";
import type { AgentOptions, HostBridge, ModelSpec, Provider } from "./types";
import type { MessageAttachment } from "@senastr/shared";
import { createProvider } from "./providers/factory";
import { compactHistory, type CompactResult } from "./context";
import { defaultSystemPrompt } from "./messages";

export interface TurnParams {
  sessionId: string;
  userMessage: string;
  model: ModelSpec;
  /** Files/images attached to this prompt (parity: prompt attachments). */
  attachments?: MessageAttachment[];
}

const DEFAULT_MAX_STEPS = 24;
const DELEGATION_MAX_STEPS = 12;
const DELEGATION_REPORT_CHARS = 8000;
const MAX_RETAINED_DELEGATIONS = 50;
const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 6;

const ASK_ABORTED = Symbol("ask-aborted");

interface PendingAsk {
  request: AskRequest;
  resolve: (answers: AskAnswers | typeof ASK_ABORTED) => void;
}

export const GOAL_MODE_PROMPT = [
  "",
  "GOAL MODE: the user locked an objective and acceptance criteria instead of a plan.",
  "- Work autonomously toward the stated outcome; you choose the path.",
  "- Use every tool you need (read, write, run, delegate) — privileged calls still ask for approval.",
  "- Verify your own work: run tests, re-read the result, and iterate until the outcome is met.",
  "- Do not stop to ask how to proceed unless the objective itself is ambiguous or destructive.",
  "- Finish with a short report: what changed, how you verified it, and anything left undone.",
].join("\n");

export const PLAN_MODE_PROMPT = [
  "",
  "PLAN MODE: you are planning, not executing.",
  "- Investigate with read-only tools (read_file, glob, grep, list_dir).",
  "- Do NOT write files, run commands, or spawn subagents; those calls will be rejected.",
  "- You may call ask_user when a decision blocks the plan.",
  "- When the plan is complete, call submit_plan exactly once with the full plan.",
  "- After submitting, stop: the user will approve, reject, or ask for revisions.",
].join("\n");

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
 * Three tools are intercepted here instead of reaching the host:
 *   ask_user    — pauses the turn until the user answers (resolveAsk)
 *   submit_plan — ends a plan-mode turn with a proposal awaiting approval
 *   Task        — runs a nested delegated loop and returns its report
 *
 * All transcript writes happen here (single writer per session), so the
 * host store and the UI can stay in lockstep by re-reading after a turn.
 */
export class AgentRuntime {
  private active = new Map<string, AbortController>();
  private pendingAsks = new Map<string, PendingAsk>();
  private pendingProposals = new Map<string, PlanProposal>();
  private delegations = new Map<string, DelegationSummary[]>();

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
    const planMode = session.mode === "plan";
    const goalMode = session.mode === "goal";
    const thinkingLevel = session.thinkingLevel ?? params.model.thinkingLevel;

    const abort = new AbortController();
    this.active.set(session.id, abort);
    const usage: Usage = {};
    let stopReason: TurnStopReason = "stop";
    let errorText: string | undefined;
    let compaction: CompactResult = { messages: [], dropped: 0, truncated: false };

    try {
      yield { type: "turn/start", sessionId: session.id, turnId: randomUUID() };
      await this.host.appendMessages(session.id, [
        { ...makeMessage("user", params.userMessage), ...(params.attachments?.length ? { attachments: params.attachments } : {}) },
      ]);

      const provider = this.makeProvider(params.model);
      let step = 0;

      for (;;) {
        step += 1;
        const tools = await this.host.listTools(session.id);
        const riskByName = new Map(tools.map((t) => [t.name, t.risk]));
        const history = (await this.host.getSession(session.id)).messages;
        // The transcript on disk is the durable record; the model only ever
        // sees a bounded window so long sessions cannot overflow the context.
        compaction = compactHistory(history, this.opts.contextCharBudget);
        const skills = this.host.listSkills ? await this.host.listSkills(session.projectPath) : [];
        const contexts = await this.loadProjectContexts(session.projectPath);
        let system = withActiveSkills(defaultSystemPrompt(session.projectPath!), skills);
        system = withProjectContext(system, contexts);
        if (planMode) system += PLAN_MODE_PROMPT;
        if (goalMode) system += GOAL_MODE_PROMPT;

        let text = "";
        let reasoning = "";
        const calls: ToolCall[] = [];

        for await (const evt of provider.streamChat({
          model: params.model.model,
          system,
          messages: await this.hydrateAttachments(compaction.messages),
          tools: planMode ? tools.filter((t) => t.name !== "Task") : tools,
          signal: abort.signal,
          thinkingLevel,
          temperature: params.model.temperature,
          maxTokens: params.model.maxOutputTokens,
        })) {
          if (evt.kind === "text") {
            text += evt.delta;
            yield { type: "assistant/delta", delta: evt.delta };
          } else if (evt.kind === "reasoning") {
            reasoning += evt.delta;
            yield { type: "assistant/reasoning", delta: evt.delta };
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
          await this.host.appendMessages(session.id, [makeMessage("assistant", text, reasoning)]);
          if (stopReason !== "aborted") stopReason = "stop";
          break;
        }

        await this.host.appendMessages(session.id, [makeMessage("assistant", text, reasoning, calls)]);
        for (const call of calls) {
          if (abort.signal.aborted) break;
          yield { type: "tool/call", call };

          // --- runtime-intercepted tools ------------------------------------
          if (call.name === "ask_user") {
            // Streamed live: ask/request must reach the UI while the turn
            // is still paused (it only resumes via resolveAsk).
            const outcome = yield* this.runAsk(session.id, call, abort.signal);
            if (outcome.aborted) {
              stopReason = "aborted";
              break;
            }
            yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
            await this.host.appendMessages(session.id, [toolMessage(call, outcome.result)]);
            continue;
          }
          if (call.name === "submit_plan") {
            const result = this.handleSubmitPlan(session.id, call, planMode);
            yield { type: "tool/result", callId: call.id, ok: result.ok, result: result.result };
            await this.host.appendMessages(session.id, [toolMessage(call, result.result)]);
            if (result.proposed) {
              yield { type: "plan/proposed", sessionId: session.id, proposal: result.proposed };
              this.pendingProposals.set(session.id, result.proposed);
              stopReason = "plan";
            }
            break;
          }
          if (call.name === "Task") {
            const outcome = yield* this.runTask(session.id, call, params.model, abort.signal);
            yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
            await this.host.appendMessages(session.id, [toolMessage(call, outcome.result)]);
            continue;
          }
          if (planMode && riskByName.get(call.name) !== "read") {
            // Read-only enforcement is deterministic: the model is told, and
            // the call is rejected here even if it tries anyway.
            const blocked: ToolResult = {
              ok: false,
              error:
                "Plan mode is read-only: this tool is disabled. Investigate with read-only tools, then call submit_plan with the full plan.",
              durationMs: 0,
            };
            yield { type: "tool/result", callId: call.id, ok: false, result: blocked };
            await this.host.appendMessages(session.id, [toolMessage(call, blocked)]);
            continue;
          }

          const result = await this.host.runTool({
            sessionId: session.id,
            tool: call.name,
            args: call.arguments,
          });
          yield { type: "tool/result", callId: call.id, ok: result.ok, result };
          await this.host.appendMessages(session.id, [toolMessage(call, result)]);
        }

        if (stopReason === "plan") break;
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
      this.failSessionAsks(session.id);
      // Token accounting is written by the host so usage survives a closed
      // window and feeds the stats view (parity: stats/getTokenUsageHistory).
      if (this.host.recordUsage && (usage.inputTokens || usage.outputTokens)) {
        try {
          await this.host.recordUsage({
            sessionId: session.id,
            providerId: params.model.providerId,
            model: params.model.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            stopReason,
          });
        } catch {
          /* usage accounting must never fail a turn */
        }
      }
      yield {
        type: "turn/end",
        stopReason,
        usage,
        error: errorText,
        compaction:
          compaction.dropped > 0 || compaction.truncated
            ? { dropped: compaction.dropped, truncated: compaction.truncated }
            : undefined,
      };
    }
  }

  /** Stop the in-flight turn for a session. Returns true if one was running. */
  stop(sessionId: string): boolean {
    const controller = this.active.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.failSessionAsks(sessionId);
    return true;
  }

  /**
   * Resolve image attachments to base64 for the model request. The transcript
   * keeps only the store id, so this runs on every step (cheap: images are
   * small and the host caches nothing it cannot re-read).
   */
  private async hydrateAttachments(messages: ChatMessage[]): Promise<ChatMessage[]> {
    if (!this.host.readAttachment) return messages;
    let needed = false;
    for (const message of messages) {
      if (message.attachments?.some((a) => a.kind === "image" && a.storeId && !a.dataBase64)) {
        needed = true;
        break;
      }
    }
    if (!needed) return messages;
    return Promise.all(
      messages.map(async (message) => {
        if (!message.attachments?.length) return message;
        const attachments = await Promise.all(
          message.attachments.map(async (attachment) => {
            if (attachment.kind !== "image" || !attachment.storeId || attachment.dataBase64) return attachment;
            try {
              const resolved = await this.host.readAttachment?.(attachment.storeId);
              if (!resolved) return attachment;
              return { ...attachment, mimeType: resolved.mimeType || attachment.mimeType, dataBase64: resolved.base64 };
            } catch {
              // A missing image must not break the turn; the note stays in text.
              return attachment;
            }
          }),
        );
        return { ...message, attachments };
      }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* ask_user                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Async-generator form: yields ask/request immediately so the UI can show
   * the dialog while the turn is paused, then resolves to the tool outcome.
   */
  private async *runAsk(
    sessionId: string,
    call: ToolCall,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, { result: ToolResult; aborted: boolean }> {
    const started = Date.now();
    const fail = (error: string) => ({
      result: { ok: false, error, durationMs: Date.now() - started } as ToolResult,
      aborted: false,
    });
    let questions: AskQuestion[];
    try {
      questions = normalizeQuestions(call.arguments);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (signal.aborted) {
      return { result: { ok: false, error: "stopped by user", durationMs: 0 }, aborted: true };
    }
    const request: AskRequest = {
      requestId: randomUUID(),
      sessionId,
      toolCallId: call.id,
      questions,
      createdAt: Date.now(),
    };
    yield { type: "ask/request", request };
    const answers = await new Promise<AskAnswers | typeof ASK_ABORTED>((resolve) => {
      this.pendingAsks.set(request.requestId, { request, resolve });
    });
    this.pendingAsks.delete(request.requestId);
    if (answers === ASK_ABORTED || signal.aborted) {
      return {
        result: { ok: false, error: "stopped by user", durationMs: Date.now() - started },
        aborted: true,
      };
    }
    yield { type: "ask/resolved", requestId: request.requestId, sessionId };
    const lines = questions.map((q, i) => {
      const answer = answers[i];
      const label = q.header || `Question ${i + 1}`;
      if (answer == null) return `${label}: (skipped)`;
      if (answer.length === 0) return `${label}: (no answer)`;
      return `${label}: ${answer.join("; ")}`;
    });
    return {
      result: { ok: true, output: `User answers:\n${lines.join("\n")}`, durationMs: Date.now() - started },
      aborted: false,
    };
  }

  /**
   * Resolve a waiting ask_user call. Returns false when the request id is
   * unknown (already resolved, or the turn ended).
   */
  resolveAsk(requestId: string, answers: AskAnswers): boolean {
    const pending = this.pendingAsks.get(requestId);
    if (!pending) return false;
    this.pendingAsks.delete(requestId);
    const normalized: AskAnswers = pending.request.questions.map((_, i) => {
      const entry = answers[i];
      if (entry == null) return null;
      return Array.isArray(entry) ? entry.map(String).slice(0, MAX_ASK_OPTIONS + 1) : [String(entry)];
    });
    pending.resolve(normalized);
    return true;
  }

  pendingAsksFor(sessionId: string): AskRequest[] {
    return [...this.pendingAsks.values()]
      .filter((p) => p.request.sessionId === sessionId)
      .map((p) => p.request);
  }

  private failSessionAsks(sessionId: string): void {
    for (const [id, pending] of this.pendingAsks) {
      if (pending.request.sessionId === sessionId) {
        this.pendingAsks.delete(id);
        pending.resolve(ASK_ABORTED);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* submit_plan                                                          */
  /* ------------------------------------------------------------------ */

  private handleSubmitPlan(
    sessionId: string,
    call: ToolCall,
    planMode: boolean,
  ): { ok: boolean; result: ToolResult; proposed: PlanProposal | null } {
    const fail = (error: string) => ({
      ok: false,
      result: { ok: false, error, durationMs: 0 } as ToolResult,
      proposed: null as PlanProposal | null,
    });
    if (!planMode) return fail("submit_plan is only available in plan mode.");
    const args = call.arguments ?? {};
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    const steps = Array.isArray(args.steps)
      ? args.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 50)
      : [];
    if (!summary) return fail("submit_plan requires a non-empty summary.");
    if (steps.length === 0) return fail("submit_plan requires at least one step.");
    const risks = typeof args.risks === "string" && args.risks.trim() ? args.risks.trim().slice(0, 4000) : undefined;
    const proposed: PlanProposal = {
      sessionId,
      toolCallId: call.id,
      summary: summary.slice(0, 4000),
      steps: steps.map((s) => s.slice(0, 1000)),
      risks,
      createdAt: Date.now(),
    };
    return {
      ok: true,
      result: {
        ok: true,
        output: "Plan submitted. The turn is now paused — wait for the user to approve, reject, or request revisions.",
        durationMs: 0,
      },
      proposed,
    };
  }

  /** Take (and clear) the proposal awaiting approval for a session. */
  takePlanProposal(sessionId: string): PlanProposal | null {
    const proposal = this.pendingProposals.get(sessionId) ?? null;
    if (proposal) this.pendingProposals.delete(sessionId);
    return proposal;
  }

  /* ------------------------------------------------------------------ */
  /* Task (subagents)                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Async-generator form: yields subagent/start as soon as the delegation is
   * registered so the UI shows live progress, then the final tool outcome.
   */
  private async *runTask(
    sessionId: string,
    call: ToolCall,
    parentModel: ModelSpec,
    parentSignal: AbortSignal,
  ): AsyncGenerator<AgentEvent, { result: ToolResult }> {
    const started = Date.now();
    const fail = (error: string): { result: ToolResult } => ({
      result: { ok: false, error, durationMs: Date.now() - started },
    });
    const args = call.arguments ?? {};
    const description = typeof args.description === "string" ? args.description.trim().slice(0, 120) : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!description) return fail("Task requires a short description.");
    if (!prompt) return fail("Task requires a prompt.");
    if (prompt.length > 24_000) return fail("Task prompt exceeds 24000 characters.");

    const session = await this.host.getSession(sessionId);
    const projectPath = session.projectPath;
    if (!projectPath) return fail("session has no project set");

    // Resolve the named personality, if any.
    let def: SubagentRecord | undefined;
    const wanted = typeof args.subagent === "string" ? args.subagent.trim().toLowerCase() : "";
    if (wanted && this.host.listSubagents) {
      const all = await this.host.listSubagents(projectPath);
      def = all.find((d) => d.name.toLowerCase() === wanted || d.id === wanted);
      if (!def) return fail(`unknown subagent: ${args.subagent}`);
    }
    let model = parentModel;
    if (def?.model && this.host.resolveModel) {
      try {
        model = await this.host.resolveModel(def.model);
      } catch {
        model = parentModel;
      }
    }

    const delegationId = randomUUID();
    const record: DelegationSummary = {
      id: delegationId,
      sessionId,
      agentName: def?.name ?? "default",
      description,
      status: "running",
      startedAt: started,
    };
    this.storeDelegation(sessionId, record);
    yield { type: "subagent/start", sessionId, delegation: { ...record } };

    try {
      const tools = (await this.host.listTools(sessionId)).filter(
        (t) => t.name !== "Task" && t.name !== "ask_user" && t.name !== "submit_plan",
      );
      const outcome = await this.runDelegation({
        sessionId,
        prompt,
        projectPath,
        tools,
        model,
        systemExtra: def?.systemPrompt,
        parentSignal,
      });
      record.status = outcome.status;
      record.completedAt = Date.now();
      record.turns = outcome.turns;
      record.usage = outcome.usage;
      record.report = outcome.report;
      record.error = outcome.error;
      this.storeDelegation(sessionId, record);
      yield { type: "subagent/end", sessionId, delegation: { ...record } };
      const ok = outcome.status === "done";
      return {
        result: ok
          ? { ok: true, output: `Subagent report (${record.agentName}):\n${outcome.report}`, durationMs: Date.now() - started }
          : { ok: false, error: outcome.error ?? "subagent failed", durationMs: Date.now() - started },
      };
    } catch (err) {
      record.status = parentSignal.aborted ? "stopped" : "error";
      record.completedAt = Date.now();
      record.error = err instanceof Error ? err.message : String(err);
      this.storeDelegation(sessionId, record);
      yield { type: "subagent/end", sessionId, delegation: { ...record } };
      return {
        result: { ok: false, error: record.error, durationMs: Date.now() - started },
      };
    }
  }

  private async runDelegation(opts: {
    sessionId: string;
    prompt: string;
    projectPath: string;
    tools: ToolDefinition[];
    model: ModelSpec;
    systemExtra?: string;
    parentSignal: AbortSignal;
  }): Promise<{ status: DelegationStatus; report: string; turns: number; usage: Usage; error?: string }> {
    const provider = this.makeProvider(opts.model);
    const system = [
      `You are a senastr subagent working on one self-contained task inside the project: ${opts.projectPath}`,
      "Rules: stay within the task, use tools to inspect and (when asked) modify the project, then report back concisely.",
      "You cannot ask the user questions — make reasonable assumptions and note them.",
      opts.systemExtra ? `\nPersonality:\n${opts.systemExtra}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const history: ChatMessage[] = [makeMessage("user", opts.prompt)];
    const usage: Usage = {};
    let turns = 0;
    let lastText = "";

    for (let step = 0; step < DELEGATION_MAX_STEPS; step++) {
      if (opts.parentSignal.aborted) {
        return { status: "stopped", report: lastText || "(stopped before producing a report)", turns, usage };
      }
      turns += 1;
      let text = "";
      const calls: ToolCall[] = [];
      const window = compactHistory(history, this.opts.contextCharBudget);
      for await (const evt of provider.streamChat({
        model: opts.model.model,
        system,
        messages: window.messages,
        tools: opts.tools,
        signal: opts.parentSignal,
      })) {
        if (evt.kind === "text") text += evt.delta;
        else if (evt.kind === "tool-call") calls.push({ id: evt.id, name: evt.name, arguments: evt.arguments });
        else if (evt.kind === "done") addUsage(usage, evt.usage);
      }
      lastText = text;
      if (calls.length === 0) {
        const report = text.trim() || "(the subagent produced no output)";
        return { status: "done", report: capReport(report), turns, usage };
      }
      history.push(makeMessage("assistant", text, undefined, calls));
      for (const call of calls) {
        if (opts.parentSignal.aborted) break;
        const result = await this.host.runTool({ sessionId: opts.sessionId, tool: call.name, args: call.arguments });
        history.push({
          id: randomUUID(),
          role: "tool",
          content: result.ok ? (result.output ?? "").slice(0, 12_000) : `ERROR: ${result.error ?? "tool failed"}`,
          createdAt: Date.now(),
          toolCallId: call.id,
          toolName: call.name,
        });
      }
    }
    const report = lastText.trim() || "(the subagent hit its step limit without a final answer)";
    return { status: "done", report: capReport(`${report}\n\n(note: step limit reached)`), turns, usage };
  }

  private storeDelegation(sessionId: string, record: DelegationSummary): void {
    const all = this.delegations.get(sessionId) ?? [];
    const found = all.findIndex((d) => d.id === record.id);
    if (found >= 0) all[found] = { ...record };
    else all.push({ ...record });
    this.delegations.set(sessionId, all.slice(-MAX_RETAINED_DELEGATIONS));
  }

  listDelegations(sessionId: string): DelegationSummary[] {
    return (this.delegations.get(sessionId) ?? []).map((d) => ({ ...d }));
  }

  /* ------------------------------------------------------------------ */
  /* context                                                              */
  /* ------------------------------------------------------------------ */

  private async loadProjectContexts(projectPath: string): Promise<ProjectContext[]> {
    if (!this.host.getProjectContext) return [];
    try {
      const [global, project] = await Promise.all([
        this.host.getProjectContext(null),
        this.host.getProjectContext(projectPath),
      ]);
      return [global, project].filter(
        (c) => (c.instructions && c.instructions.trim()) || (c.memory && c.memory.trim()),
      );
    } catch {
      return [];
    }
  }
}

function makeMessage(
  role: ChatMessage["role"],
  content: string,
  reasoning?: string,
  toolCalls?: ToolCall[],
): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function toolMessage(call: ToolCall, result: ToolResult): ChatMessage {
  return {
    id: randomUUID(),
    role: "tool",
    content: result.ok ? (result.output ?? "") : `ERROR: ${result.error ?? "tool failed"}`,
    createdAt: Date.now(),
    toolCallId: call.id,
    toolName: call.name,
  };
}

function addUsage(total: Usage, part?: Usage): void {
  if (!part) return;
  if (typeof part.inputTokens === "number") total.inputTokens = (total.inputTokens ?? 0) + part.inputTokens;
  if (typeof part.outputTokens === "number") total.outputTokens = (total.outputTokens ?? 0) + part.outputTokens;
}

function capReport(report: string): string {
  if (report.length <= DELEGATION_REPORT_CHARS) return report;
  return `${report.slice(0, DELEGATION_REPORT_CHARS)}\n\n(report truncated)`;
}

function normalizeQuestions(args: Record<string, unknown>): AskQuestion[] {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("ask_user requires a non-empty questions array.");
  }
  if (raw.length > MAX_ASK_QUESTIONS) {
    throw new Error(`ask_user accepts at most ${MAX_ASK_QUESTIONS} questions per call.`);
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`ask_user question ${i + 1} must be an object.`);
    }
    const q = entry as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!question) throw new Error(`ask_user question ${i + 1} needs question text.`);
    const options = Array.isArray(q.options)
      ? q.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).slice(0, MAX_ASK_OPTIONS)
      : undefined;
    return {
      id: `q${i + 1}`,
      header: typeof q.header === "string" && q.header.trim() ? q.header.trim().slice(0, 60) : undefined,
      question: question.slice(0, 2000),
      options: options?.length ? options.map((o) => o.slice(0, 300)) : undefined,
      multiSelect: q.multiSelect === true,
    };
  });
}

/** Skills are explicit user instructions, not tools. Delimit each document so
 * one skill cannot accidentally blend into the next in the system prompt. */
export function withActiveSkills(system: string, skills: SkillRecord[]): string {
  if (!skills.length) return system;
  const blocks = skills.map((skill) =>
    [
      `<skill id="${skill.id}" name="${skill.name.replace(/["<>]/g, "")}">`,
      skill.description ? `Purpose: ${skill.description}` : "",
      skill.content,
      "</skill>",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return `${system}\n\nActive user skills\nFollow these project-relevant instruction packs when applicable:\n\n${blocks.join("\n\n")}`;
}

/** Standing instructions + memory (global layer first, then project). */
export function withProjectContext(system: string, contexts: ProjectContext[]): string {
  const blocks: string[] = [];
  for (const ctx of contexts) {
    const scope = ctx.projectPath ? "project" : "global";
    if (ctx.instructions && ctx.instructions.trim()) {
      blocks.push(`<${scope}-instructions>\n${ctx.instructions.trim()}\n</${scope}-instructions>`);
    }
    if (ctx.memory && ctx.memory.trim()) {
      blocks.push(`<${scope}-memory>\n${ctx.memory.trim()}\n</${scope}-memory>`);
    }
  }
  if (!blocks.length) return system;
  return `${system}\n\nStanding instructions from the user (follow unless the current task says otherwise):\n\n${blocks.join("\n\n")}`;
}
