import { randomUUID } from "node:crypto";
import {
  BUILTIN_SKILLS,
  BUILTIN_SUBAGENTS,
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
import { createProvider } from "./providers/factory";
import { compactHistory, type CompactResult } from "./context";
import { defaultSystemPrompt } from "./messages";

export interface TurnParams {
  sessionId: string;
  userMessage: string;
  model: ModelSpec;
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

export const PLAN_MODE_PROMPT = [
  "",
  "PLAN MODE: you are planning, not executing.",
  "- Investigate with read-only tools (read_file, glob, grep, code_intel, list_dir, web_fetch).",
  "- Do NOT write files, run commands, or spawn subagents; those calls will be rejected.",
  "- You may call ask_user when a decision blocks the plan.",
  "- When the plan is complete, call submit_plan exactly once with the full plan.",
  "- After submitting, stop: the user will approve, reject, or ask for revisions.",
].join("\n");

/**
 * The senastr agent loop.
 *
 * Combines:
 *  - Claude Code CLI primitives (reading, patching, shell execution, context economy, plan/build modes)
 *  - Hermes Agent function calling & multi-turn reasoning with auto-correction
 *  - Arena AI Multi-Agent Orchestra (specialist subagent delegation & parallel batch execution)
 *  - Comprehensive engineering skills library
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

    const abort = new AbortController();
    this.active.set(session.id, abort);
    const usage: Usage = {};
    let stopReason: TurnStopReason = "stop";
    let errorText: string | undefined;
    let compaction: CompactResult = { messages: [], dropped: 0, truncated: false };

    try {
      yield { type: "turn/start", sessionId: session.id, turnId: randomUUID() };
      await this.host.appendMessages(session.id, [makeMessage("user", params.userMessage)]);

      const provider = this.makeProvider(params.model);
      let step = 0;

      for (;;) {
        step += 1;
        const tools = await this.host.listTools(session.id);
        const riskByName = new Map(tools.map((t) => [t.name, t.risk]));
        const history = (await this.host.getSession(session.id)).messages;
        compaction = compactHistory(history, this.opts.contextCharBudget);

        const userSkills = this.host.listSkills ? await this.host.listSkills(session.projectPath) : [];
        const activeSkills = userSkills.length > 0 ? userSkills : BUILTIN_SKILLS;
        const contexts = await this.loadProjectContexts(session.projectPath);

        let system = withActiveSkills(defaultSystemPrompt(session.projectPath!), activeSkills);
        system = withProjectContext(system, contexts);
        if (planMode) system += PLAN_MODE_PROMPT;

        let text = "";
        const calls: ToolCall[] = [];

        for await (const evt of provider.streamChat({
          model: params.model.model,
          system,
          messages: compaction.messages,
          tools: planMode ? tools.filter((t) => t.name !== "Task" && t.name !== "batch_tasks") : tools,
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

          // --- runtime-intercepted tools ------------------------------------
          if (call.name === "ask_user") {
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

          if (call.name === "batch_tasks") {
            const outcome = yield* this.runBatchTasks(session.id, call, params.model, abort.signal);
            yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
            await this.host.appendMessages(session.id, [toolMessage(call, outcome.result)]);
            continue;
          }

          if (planMode && riskByName.get(call.name) !== "read") {
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

  /* ------------------------------------------------------------------ */
  /* ask_user                                                             */
  /* ------------------------------------------------------------------ */

  pendingAsksFor(sessionId: string): AskRequest[] {
    const pending = this.pendingAsks.get(sessionId);
    return pending ? [{ ...pending.request }] : [];
  }

  resolveAsk(requestId: string, answers: AskAnswers): boolean {
    for (const [sessionId, pending] of this.pendingAsks.entries()) {
      if (pending.request.requestId === requestId) {
        this.pendingAsks.delete(sessionId);
        pending.resolve(answers);
        return true;
      }
    }
    return false;
  }

  private failSessionAsks(sessionId: string): void {
    const pending = this.pendingAsks.get(sessionId);
    if (pending) {
      this.pendingAsks.delete(sessionId);
      pending.resolve(ASK_ABORTED);
    }
  }

  private async *runAsk(
    sessionId: string,
    call: ToolCall,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, { aborted: boolean; result: ToolResult }> {
    const started = Date.now();
    let questions: AskQuestion[];
    try {
      questions = normalizeQuestions(call.arguments);
    } catch (err) {
      return {
        aborted: false,
        result: {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        },
      };
    }

    const request: AskRequest = {
      requestId: randomUUID(),
      sessionId,
      toolCallId: call.id,
      questions,
      createdAt: Date.now(),
    };

    const answerPromise = new Promise<AskAnswers | typeof ASK_ABORTED>((resolve) => {
      this.pendingAsks.set(sessionId, { request, resolve });
    });

    yield { type: "ask/request", request };

    const onAbort = () => this.resolveAsk(request.requestId, ASK_ABORTED as unknown as AskAnswers);
    signal.addEventListener("abort", onAbort, { once: true });

    const answers = await answerPromise;
    signal.removeEventListener("abort", onAbort);

    if (answers === ASK_ABORTED || signal.aborted) {
      return {
        aborted: true,
        result: { ok: false, error: "aborted while waiting for user answer", durationMs: Date.now() - started },
      };
    }

    yield { type: "ask/resolved", requestId: request.requestId, sessionId };

    const lines = questions.map((q, i) => {
      const ans = answers[i];
      const rendered = !ans || ans.length === 0 ? "(no answer)" : ans.join(", ");
      return `${q.header ?? q.question}: ${rendered}`;
    });
    return {
      aborted: false,
      result: {
        ok: true,
        output: `User answered:\n${lines.join("\n")}`,
        durationMs: Date.now() - started,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* submit_plan                                                          */
  /* ------------------------------------------------------------------ */

  takePlanProposal(sessionId: string): PlanProposal | null {
    const p = this.pendingProposals.get(sessionId);
    if (!p) return null;
    this.pendingProposals.delete(sessionId);
    return p;
  }

  private handleSubmitPlan(
    sessionId: string,
    call: ToolCall,
    planMode: boolean,
  ): { ok: boolean; result: ToolResult; proposed?: PlanProposal } {
    const started = Date.now();
    if (!planMode) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "submit_plan is only available in plan mode — switch modes in the top bar to plan changes.",
          durationMs: 0,
        },
      };
    }
    const args = call.arguments as Record<string, unknown>;
    const summary = typeof args?.summary === "string" ? args.summary.trim() : "";
    const steps = Array.isArray(args?.steps)
      ? args.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const risks = typeof args?.risks === "string" ? args.risks.trim() : undefined;
    if (!summary || steps.length === 0) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "submit_plan requires a non-empty summary and at least one step.",
          durationMs: Date.now() - started,
        },
      };
    }
    const proposal: PlanProposal = {
      sessionId,
      toolCallId: call.id,
      summary,
      steps,
      risks,
      createdAt: Date.now(),
    };
    return {
      ok: true,
      result: {
        ok: true,
        output: `Plan submitted for user approval:\n\nSummary: ${summary}\n\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}${risks ? `\n\nRisks / notes:\n${risks}` : ""}`,
        durationMs: Date.now() - started,
      },
      proposed: proposal,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Task & Batch Subagent Delegation (Arena AI Multi-Agent Orchestra)  */
  /* ------------------------------------------------------------------ */

  private async *runTask(
    sessionId: string,
    call: ToolCall,
    parentModel: ModelSpec,
    parentSignal: AbortSignal,
  ): AsyncGenerator<AgentEvent, { result: ToolResult }> {
    const started = Date.now();
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const description = typeof args.description === "string" ? args.description.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const fail = (error: string): { result: ToolResult } => ({
      result: { ok: false, error, durationMs: Date.now() - started },
    });
    if (!description) return fail("Task.description is required");
    if (!prompt) return fail("Task.prompt is required");

    const session = await this.host.getSession(sessionId);
    const projectPath = session.projectPath!;
    const wanted = (typeof args.subagent === "string" ? args.subagent.trim() : "").toLowerCase();
    let def: SubagentRecord | undefined;
    if (wanted) {
      const userSubagents = this.host.listSubagents ? await this.host.listSubagents(projectPath) : [];
      def = userSubagents.find((d) => d.name.toLowerCase() === wanted || d.id === wanted);
      if (!def) {
        def = BUILTIN_SUBAGENTS.find((d) => d.name.toLowerCase() === wanted || d.id === wanted);
      }
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
        (t) => t.name !== "Task" && t.name !== "batch_tasks" && t.name !== "ask_user" && t.name !== "submit_plan",
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

  private async *runBatchTasks(
    sessionId: string,
    call: ToolCall,
    parentModel: ModelSpec,
    parentSignal: AbortSignal,
  ): AsyncGenerator<AgentEvent, { result: ToolResult }> {
    const started = Date.now();
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const rawTasks = args.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return {
        result: {
          ok: false,
          error: "batch_tasks requires a non-empty tasks array",
          durationMs: Date.now() - started,
        },
      };
    }

    const tasks = rawTasks
      .slice(0, 6)
      .map((t: any, idx) => ({
        description: typeof t?.description === "string" && t.description.trim() ? t.description.trim() : `task-${idx + 1}`,
        prompt: typeof t?.prompt === "string" ? t.prompt.trim() : "",
        subagent: typeof t?.subagent === "string" ? t.subagent.trim() : undefined,
      }))
      .filter((t) => Boolean(t.prompt));

    if (tasks.length === 0) {
      return {
        result: {
          ok: false,
          error: "batch_tasks: all task items had empty prompts",
          durationMs: Date.now() - started,
        },
      };
    }

    const session = await this.host.getSession(sessionId);
    const projectPath = session.projectPath!;
    const userSubagents = this.host.listSubagents ? await this.host.listSubagents(projectPath) : [];
    const allSubagents = [
      ...userSubagents,
      ...BUILTIN_SUBAGENTS.filter((b) => !userSubagents.some((u) => u.id === b.id || u.name.toLowerCase() === b.name.toLowerCase())),
    ];

    const availableTools = (await this.host.listTools(sessionId)).filter(
      (t) => t.name !== "Task" && t.name !== "batch_tasks" && t.name !== "ask_user" && t.name !== "submit_plan",
    );

    const taskPlans = await Promise.all(
      tasks.map(async (task) => {
        const wanted = (task.subagent ?? "").toLowerCase();
        let def = wanted ? allSubagents.find((d) => d.name.toLowerCase() === wanted || d.id === wanted) : undefined;
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
          description: task.description,
          status: "running",
          startedAt: Date.now(),
        };
        return { task, def, model, record };
      }),
    );

    for (const item of taskPlans) {
      this.storeDelegation(sessionId, item.record);
      yield { type: "subagent/start", sessionId, delegation: { ...item.record } };
    }

    const outcomes = await Promise.all(
      taskPlans.map(async (item) => {
        try {
          const outcome = await this.runDelegation({
            sessionId,
            prompt: item.task.prompt,
            projectPath,
            tools: availableTools,
            model: item.model,
            systemExtra: item.def?.systemPrompt,
            parentSignal,
          });
          item.record.status = outcome.status;
          item.record.completedAt = Date.now();
          item.record.turns = outcome.turns;
          item.record.usage = outcome.usage;
          item.record.report = outcome.report;
          item.record.error = outcome.error;
          this.storeDelegation(sessionId, item.record);
          return { item, outcome };
        } catch (err) {
          item.record.status = parentSignal.aborted ? "stopped" : "error";
          item.record.completedAt = Date.now();
          item.record.error = err instanceof Error ? err.message : String(err);
          this.storeDelegation(sessionId, item.record);
          return {
            item,
            outcome: {
              status: item.record.status,
              report: "",
              turns: 0,
              usage: {},
              error: item.record.error,
            },
          };
        }
      }),
    );

    for (const { item } of outcomes) {
      yield { type: "subagent/end", sessionId, delegation: { ...item.record } };
    }

    const reports = outcomes.map(
      ({ item, outcome }, idx) =>
        `### Task ${idx + 1}: ${item.record.description} (${item.record.agentName}) [${outcome.status}]\n${outcome.report || outcome.error || "(no output)"}`,
    );

    const allOk = outcomes.every((r) => r.outcome.status === "done");
    return {
      result: {
        ok: allOk,
        output: `Batch Tasks Completed (${outcomes.length} parallel subagents):\n\n${reports.join("\n\n")}`,
        durationMs: Date.now() - started,
      },
    };
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
      `You are a specialized senastr subagent working on a focused task inside the project: ${opts.projectPath}`,
      "Rules: stay within your assigned scope, use tools to inspect and modify project files, verify your changes, and report back concisely.",
      "You cannot ask the user questions — make reasonable assumptions and note them in your final report.",
      opts.systemExtra ? `\nRole & Personality:\n${opts.systemExtra}` : "",
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
      history.push(makeMessage("assistant", text, calls));
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

function makeMessage(role: ChatMessage["role"], content: string, toolCalls?: ToolCall[]): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: Date.now(),
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
