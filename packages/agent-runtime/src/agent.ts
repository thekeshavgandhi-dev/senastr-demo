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
  type TodoItem,
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
import { composeSystemPrompt, DELEGATION_REPORT_CONTRACT, BASE_PROTOCOL } from "./prompt";
import {
  describeRepairs,
  repairToolCall,
  type ToolCallRepair,
} from "./tool-validation";
import { SUMMARIZE_SYSTEM, renderTranscriptForSummary } from "./summarize";

export interface TurnParams {
  sessionId: string;
  userMessage: string;
  model: ModelSpec;
}

const DEFAULT_MAX_STEPS = 40;
const DELEGATION_MAX_STEPS = 16;
const DELEGATION_REPORT_CHARS = 8_000;
const MAX_RETAINED_DELEGATIONS = 50;
const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 6;
/** Independent read-only calls executed concurrently in one block. */
const MAX_PARALLEL_TOOLS = 8;
/** Identical failing call repetitions before the runtime intervenes. */
const REPEAT_WARN_AT = 2;
const REPEAT_STOP_AT = 4;
/** How many times the runtime may insist on verification before finishing. */
const VERIFICATION_NUDGE_LIMIT = 1;
/** Auto-loaded skill bodies are capped so they cannot swamp the prompt. */
const AUTO_SKILL_CHAR_BUDGET = 9_000;
const MAX_AUTO_SKILLS = 3;
const SUMMARIZE_MIN_DROPPED = 6;
const SUMMARIZE_INPUT_CHARS = 28_000;

const ASK_ABORTED = Symbol("ask-aborted");

/** One item of a `batch_tasks` call, after normalisation. */
interface BatchTask {
  id: string;
  description: string;
  prompt: string;
  subagent?: string;
  dependsOn: string[];
  readOnly: boolean;
  context?: string;
}

/** Tools the runtime answers itself instead of forwarding to the host. */
const INTERCEPTED_TOOLS = new Set([
  "ask_user",
  "submit_plan",
  "Task",
  "batch_tasks",
  "todo_write",
  "think",
]);
/** Tools that mutate the project; verification is owed after them. */
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "patch_file"]);

interface PendingAsk {
  request: AskRequest;
  resolve: (answers: AskAnswers | typeof ASK_ABORTED) => void;
}

interface TurnState {
  todos: TodoItem[];
  /** Signature → consecutive failure count, for stuck detection. */
  failures: Map<string, number>;
  repeatedSignature?: string;
  /** Think-tool notes, surfaced in the prompt as a scratchpad. */
  scratchpad: string[];
  writesSinceVerify: number;
  verifyRan: boolean;
  verificationNudges: number;
  /** Cached LLM summary of compacted-away history. */
  summary?: { key: string; text: string };
  /** Skills auto-loaded this turn (ids), so we do not re-inject forever. */
  activeSkillIds: Set<string>;
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
 * What it layers on top of a plain "model → tool → result" cycle:
 *
 *  - **Progressive disclosure.** Skills ship as one-line manifests; bodies
 *    load on demand through `use_skill` (plus a keyword auto-activator as a
 *    safety net when the model forgets to ask).
 *  - **Durable memory.** The host injects a memory index plus passages
 *    recalled for the current request, so context survives compaction and
 *    session boundaries.
 *  - **Self-correction.** Every call is schema-checked and repaired where the
 *    fix is unambiguous; unfixable calls come back as an actionable message
 *    instead of an exception.
 *  - **Loop breaking.** Repeated identical failures escalate to a warning in
 *    the prompt, then end the turn rather than burning the step budget.
 *  - **Verification gate.** After writes the runtime refuses to let the turn
 *    end silently until the project's checks have run (or are excused).
 *  - **Context that survives itself.** Dropped history is summarised by the
 *    model instead of vanishing behind a placeholder.
 *  - **Real orchestration.** Subagents take structured briefs, run as a
 *    dependency DAG with bounded concurrency, and report in a fixed shape.
 */
export class AgentRuntime {
  private active = new Map<string, AbortController>();
  private pendingAsks = new Map<string, PendingAsk>();
  private pendingProposals = new Map<string, PlanProposal>();
  private delegations = new Map<string, DelegationSummary[]>();
  private turnState = new Map<string, TurnState>();

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
    const state = this.resetState(session.id);

    try {
      yield { type: "turn/start", sessionId: session.id, turnId: randomUUID() };
      await this.host.appendMessages(session.id, [makeMessage("user", params.userMessage)]);

      const provider = this.makeProvider(params.model);
      const projectPath = session.projectPath;
      let step = 0;

      for (;;) {
        step += 1;
        if (abort.signal.aborted) {
          stopReason = "aborted";
          break;
        }

        const tools = await this.host.listTools(session.id);
        const toolByName = new Map(tools.map((t) => [t.name, t]));
        const history = (await this.host.getSession(session.id)).messages;
        compaction = compactHistory(history, this.opts.contextCharBudget);

        const recallQuery = latestUserText(history) || params.userMessage;
        const system = await this.buildSystemPrompt({
          sessionId: session.id,
          projectPath,
          planMode,
          tools,
          recallQuery,
          step,
          maxSteps,
          state,
          history,
          compaction,
          model: params.model,
          signal: abort.signal,
          usage,
        });

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

        if (abort.signal.aborted) stopReason = "aborted";

        if (calls.length === 0) {
          // The model wants to stop. If it changed files without verifying,
          // insist once — an unverified "done" is the expensive failure mode.
          if (
            state.writesSinceVerify > 0 &&
            !state.verifyRan &&
            !planMode &&
            state.verificationNudges < VERIFICATION_NUDGE_LIMIT &&
            stopReason !== "aborted"
          ) {
            state.verificationNudges += 1;
            await this.host.appendMessages(session.id, [
              makeMessage("user", VERIFICATION_NUDGE(state.writesSinceVerify)),
            ]);
            continue;
          }
          await this.host.appendMessages(session.id, [makeMessage("assistant", text)]);
          if (stopReason !== "aborted") stopReason = "stop";
          break;
        }

        await this.host.appendMessages(session.id, [makeMessage("assistant", text, calls)]);

        const outcome = yield* this.runCalls({
          calls,
          sessionId: session.id,
          toolByName,
          planMode,
          state,
          model: params.model,
          signal: abort.signal,
        });

        if (outcome.stopReason === "plan") {
          stopReason = "plan";
          break;
        }
        if (outcome.stopReason === "aborted" || abort.signal.aborted) {
          stopReason = "aborted";
          break;
        }

        // Stuck detection: the model is repeating a call that keeps failing.
        const repeats = state.repeatedSignature ? (state.failures.get(state.repeatedSignature) ?? 0) : 0;
        if (repeats >= REPEAT_STOP_AT) {
          stopReason = "stuck";
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

  /** Live task list for a session (also emitted as `todo/update` events). */
  todosFor(sessionId: string): TodoItem[] {
    return (this.turnState.get(sessionId)?.todos ?? []).map((t) => ({ ...t }));
  }

  /* ------------------------------------------------------------------ */
  /* system prompt                                                        */
  /* ------------------------------------------------------------------ */

  private async buildSystemPrompt(input: {
    sessionId: string;
    projectPath: string;
    planMode: boolean;
    tools: ToolDefinition[];
    recallQuery: string;
    step: number;
    maxSteps: number;
    state: TurnState;
    history: ChatMessage[];
    compaction: CompactResult;
    model: ModelSpec;
    signal: AbortSignal;
    usage: Usage;
  }): Promise<string> {
    const { state, compaction, history } = input;

    const userSkills = this.host.listSkills ? await safeList(() => this.host.listSkills!(input.projectPath)) : [];
    const skills = mergeSkills(userSkills);
    const contexts = await this.loadProjectContexts(input.projectPath);

    // Auto-activate skills whose description matches the request. The model
    // is expected to call use_skill itself; this is the safety net that keeps
    // a missed activation from costing the whole task.
    const autoActivated =
      this.opts.autoActivateSkills === false
        ? []
        : autoActivateSkills(skills, input.recallQuery, state.activeSkillIds);
    for (const skill of autoActivated) state.activeSkillIds.add(skill.id);

    const memoryBlock = this.host.memoryPrompt
      ? await safeText(() => this.host.memoryPrompt!(input.projectPath, input.recallQuery, 6))
      : "";

    const checkpoint = await this.checkpointText({
      sessionId: input.sessionId,
      history,
      compaction,
      model: input.model,
      signal: input.signal,
      usage: input.usage,
      state,
    });
    if (checkpoint) compaction.messages = withCheckpointText(compaction, checkpoint);

    return composeSystemPrompt({
      projectPath: input.projectPath,
      base: defaultSystemPrompt(input.projectPath),
      skills,
      memory: memoryBlock,
      todos: state.todos,
      warnings: this.warnings(state, input.step, input.maxSteps),
      standingInstructions: withProjectContext("", contexts).trim() || undefined,
      planMode: input.planMode,
      autoSkills: autoActivated,
    });
  }

  private warnings(state: TurnState, step: number, maxSteps: number): string[] {
    const out: string[] = [];
    if (state.repeatedSignature) {
      const count = state.failures.get(state.repeatedSignature) ?? 0;
      if (count >= REPEAT_WARN_AT) {
        out.push(
          `You have repeated the same failing tool call ${count} times (${state.repeatedSignature}). ` +
            "Stop retrying it: re-read the relevant file, change the arguments materially, or use a different tool. " +
            `After ${REPEAT_STOP_AT} identical failures the turn is ended automatically.`,
        );
      }
    }
    if (state.writesSinceVerify > 0 && !state.verifyRan) {
      out.push(
        `You have made ${state.writesSinceVerify} file change(s) since the last verification. ` +
          "Run `verify` before reporting completion — a change is done when the project's checks pass.",
      );
    }
    if (state.scratchpad.length) {
      const last = state.scratchpad[state.scratchpad.length - 1];
      out.push(`Earlier reasoning on record: ${truncate(last.replace(/\s+/g, " "), 240)}`);
    }
    if (step >= Math.floor(maxSteps * 0.75)) {
      out.push(
        `Step budget: ${step}/${maxSteps} used. Wrap up: report what is done and verified, and what remains. ` +
          "Do not start a new line of work you cannot finish.",
      );
    }
    return out;
  }

  /**
   * Replace the placeholder checkpoint with a model-written summary of the
   * history that fell out of the window. Cached per compaction size so a long
   * turn pays for it once, not every step.
   */
  private async checkpointText(input: {
    sessionId: string;
    history: ChatMessage[];
    compaction: CompactResult;
    model: ModelSpec;
    signal: AbortSignal;
    usage: Usage;
    state: TurnState;
  }): Promise<string | undefined> {
    const { compaction, state } = input;
    if (this.opts.summarizeHistory === false) return undefined;
    if (compaction.dropped < SUMMARIZE_MIN_DROPPED) return undefined;

    const keptIds = new Set(compaction.messages.map((m) => m.id));
    const dropped = input.history.filter((m) => !keptIds.has(m.id));
    if (!dropped.length) return undefined;

    const key = `${input.history.length}:${compaction.dropped}`;
    if (state.summary?.key === key) return state.summary.text;

    const transcript = renderTranscriptForSummary(dropped, SUMMARIZE_INPUT_CHARS);
    try {
      const provider = this.makeProvider(input.model);
      let text = "";
      for await (const evt of provider.streamChat({
        model: input.model.model,
        system: SUMMARIZE_SYSTEM,
        messages: [makeMessage("user", transcript)],
        tools: [],
        signal: input.signal,
        maxTokens: 900,
      })) {
        if (evt.kind === "text") text += evt.delta;
        else if (evt.kind === "done") addUsage(input.usage, evt.usage);
      }
      const summary = text.trim();
      if (!summary) return undefined;
      const rendered = `[context checkpoint] ${compaction.dropped} earlier message(s) were compacted out of this request. Summary of what happened before this point:\n${summary}`;
      state.summary = { key, text: rendered };
      return rendered;
    } catch {
      // Summarisation is an optimisation; the placeholder checkpoint stands.
      return undefined;
    }
  }

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

  private resetState(sessionId: string): TurnState {
    const state: TurnState = {
      todos: [],
      failures: new Map(),
      scratchpad: [],
      writesSinceVerify: 0,
      verifyRan: false,
      verificationNudges: 0,
      activeSkillIds: new Set(),
    };
    this.turnState.set(sessionId, state);
    return state;
  }

  /* ------------------------------------------------------------------ */
  /* tool execution                                                       */
  /* ------------------------------------------------------------------ */

  private async *runCalls(input: {
    calls: ToolCall[];
    sessionId: string;
    toolByName: Map<string, ToolDefinition>;
    planMode: boolean;
    state: TurnState;
    model: ModelSpec;
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent, { stopReason?: TurnStopReason }> {
    const { calls, sessionId, toolByName, planMode, state } = input;
    const knownNames = [...toolByName.keys()];
    let index = 0;

    while (index < calls.length) {
      if (input.signal.aborted) return { stopReason: "aborted" };

      // Group consecutive independent read-only calls so they run at once.
      // The cursor only advances when the batch is actually taken, otherwise
      // the fall-through below would skip a call.
      let cursor = index;
      const batch: ToolCall[] = [];
      while (cursor < calls.length && batch.length < MAX_PARALLEL_TOOLS) {
        const candidate = calls[cursor];
        const tool = toolByName.get(candidate.name);
        if (!isParallelSafe(candidate, tool)) break;
        batch.push(candidate);
        cursor += 1;
      }

      if (batch.length > 1) {
        index = cursor;
        for (const call of batch) yield { type: "tool/call", call };
        const outcomes = await Promise.all(batch.map((call) => this.runHostTool(call, sessionId, toolByName, state)));
        for (const outcome of outcomes) {
          yield { type: "tool/result", callId: outcome.call.id, ok: outcome.result.ok, result: outcome.result };
        }
        await this.host.appendMessages(sessionId, outcomes.map((o) => toolMessage(o.call, o.result)));
        continue;
      }

      const call = calls[index];
      index += 1;

      if (input.signal.aborted) return { stopReason: "aborted" };
      yield { type: "tool/call", call };
      const tool = toolByName.get(call.name);

      // --- runtime-intercepted tools --------------------------------------
      if (call.name === "ask_user") {
        const outcome = yield* this.runAsk(sessionId, call, input.signal);
        if (outcome.aborted) {
          yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
          return { stopReason: "aborted" };
        }
        yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
        await this.host.appendMessages(sessionId, [toolMessage(call, outcome.result)]);
        continue;
      }

      if (call.name === "submit_plan") {
        const result = this.handleSubmitPlan(sessionId, call, planMode);
        yield { type: "tool/result", callId: call.id, ok: result.ok, result: result.result };
        await this.host.appendMessages(sessionId, [toolMessage(call, result.result)]);
        if (result.proposed) {
          yield { type: "plan/proposed", sessionId, proposal: result.proposed };
          this.pendingProposals.set(sessionId, result.proposed);
          return { stopReason: "plan" };
        }
        continue;
      }

      if (call.name === "Task") {
        const outcome = yield* this.runTask(sessionId, call, input.model, input.signal);
        yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
        await this.host.appendMessages(sessionId, [toolMessage(call, outcome.result)]);
        continue;
      }

      if (call.name === "batch_tasks") {
        const outcome = yield* this.runBatchTasks(sessionId, call, input.model, input.signal);
        yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
        await this.host.appendMessages(sessionId, [toolMessage(call, outcome.result)]);
        continue;
      }

      if (call.name === "todo_write") {
        const { result, todos } = this.handleTodoWrite(call, state);
        if (todos) yield { type: "todo/update", sessionId, todos };
        yield { type: "tool/result", callId: call.id, ok: result.ok, result };
        await this.host.appendMessages(sessionId, [toolMessage(call, result)]);
        continue;
      }

      if (call.name === "think") {
        const result = this.handleThink(call, state);
        yield { type: "tool/result", callId: call.id, ok: result.ok, result };
        await this.host.appendMessages(sessionId, [toolMessage(call, result)]);
        continue;
      }

      // --- host tools ------------------------------------------------------
      if (planMode && (tool?.risk ?? "write") !== "read") {
        const blocked: ToolResult = {
          ok: false,
          error:
            "Plan mode is read-only: this tool is disabled. Investigate with read-only tools, then call submit_plan with the full plan.",
          durationMs: 0,
        };
        yield { type: "tool/result", callId: call.id, ok: false, result: blocked };
        await this.host.appendMessages(sessionId, [toolMessage(call, blocked)]);
        continue;
      }

      const outcome = await this.runHostTool(call, sessionId, toolByName, state);
      yield { type: "tool/result", callId: call.id, ok: outcome.result.ok, result: outcome.result };
      await this.host.appendMessages(sessionId, [toolMessage(call, outcome.result)]);
    }

    return {};
  }

  /**
   * Validate → repair → execute one host tool call.
   *
   * A validation failure is returned as a normal (failed) tool result: the
   * model sees the message, fixes the call, and the turn continues. Nothing
   * here throws.
   */
  private async runHostTool(
    call: ToolCall,
    sessionId: string,
    toolByName: Map<string, ToolDefinition>,
    state: TurnState,
  ): Promise<{ call: ToolCall; result: ToolResult }> {
    const started = Date.now();
    const tool = toolByName.get(call.name);
    const repair: ToolCallRepair = repairToolCall(call, tool, [...toolByName.keys()]);

    if (!repair.ok) {
      this.noteFailure(state, call, false);
      return {
        call,
        result: {
          ok: false,
          error: `${repair.error}${describeRepairs(repair.repairs)}`,
          durationMs: Date.now() - started,
        },
      };
    }

    let result: ToolResult;
    try {
      result = await this.host.runTool({ sessionId, tool: call.name, args: repair.args });
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }

    if (result.ok && repair.repairs.length) {
      result = { ...result, output: `${result.output ?? ""}${describeRepairs(repair.repairs)}` };
    }

    if (result.ok) {
      state.failures.delete(signatureOf(call));
      if (state.repeatedSignature === signatureOf(call)) state.repeatedSignature = undefined;
      if (MUTATING_TOOLS.has(call.name)) state.writesSinceVerify += 1;
      if (call.name === "verify" || call.name === "run_command") {
        state.verifyRan = state.verifyRan || call.name === "verify";
        if (call.name === "verify") state.writesSinceVerify = 0;
      }
    } else {
      this.noteFailure(state, call, true);
    }

    return { call, result };
  }

  private noteFailure(state: TurnState, call: ToolCall, _counted: boolean): void {
    const signature = signatureOf(call);
    const next = (state.failures.get(signature) ?? 0) + 1;
    state.failures.set(signature, next);
    state.repeatedSignature = signature;
  }

  /* ------------------------------------------------------------------ */
  /* todo_write + think                                                   */
  /* ------------------------------------------------------------------ */

  private handleTodoWrite(
    call: ToolCall,
    state: TurnState,
  ): { result: ToolResult; todos?: TodoItem[] } {
    const started = Date.now();
    const raw = call.arguments as { todos?: unknown } | undefined;
    const list = Array.isArray(raw?.todos) ? raw!.todos : undefined;
    if (!list) {
      return { result: { ok: false, error: "todo_write requires a `todos` array", durationMs: Date.now() - started } };
    }
    const parsed: TodoItem[] = [];
    for (const [i, entry] of list.entries()) {
      if (!entry || typeof entry !== "object") {
        return {
          result: { ok: false, error: `todo_write item ${i + 1} must be an object`, durationMs: Date.now() - started },
        };
      }
      const item = entry as Record<string, unknown>;
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!content) {
        return {
          result: { ok: false, error: `todo_write item ${i + 1} needs content`, durationMs: Date.now() - started },
        };
      }
      const status = item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
      parsed.push({
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `t${i + 1}`,
        content: content.slice(0, 400),
        status,
        notes: typeof item.notes === "string" && item.notes.trim() ? item.notes.trim().slice(0, 400) : undefined,
      });
    }
    state.todos = parsed;
    const done = parsed.filter((t) => t.status === "completed").length;
    return {
      todos: parsed.map((t) => ({ ...t })),
      result: {
        ok: true,
        output: `Task list updated — ${done}/${parsed.length} completed.\n${renderTaskList(parsed)}`,
        durationMs: Date.now() - started,
      },
    };
  }

  private handleThink(call: ToolCall, state: TurnState): ToolResult {
    const started = Date.now();
    const thought = typeof (call.arguments as Record<string, unknown>)?.thought === "string"
      ? String((call.arguments as Record<string, unknown>).thought).trim()
      : "";
    if (!thought) {
      return { ok: false, error: "think requires a non-empty `thought`", durationMs: Date.now() - started };
    }
    state.scratchpad.push(thought.slice(0, 4_000));
    if (state.scratchpad.length > 12) state.scratchpad.shift();
    return {
      ok: true,
      output: `Recorded reasoning step ${state.scratchpad.length}. It stays in the transcript — build on it instead of re-deriving it.`,
      durationMs: Date.now() - started,
    };
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
        output: `Plan submitted for user approval:\n\nSummary: ${summary}\n\nSteps:\n${steps
          .map((s, i) => `${i + 1}. ${s}`)
          .join("\n")}${risks ? `\n\nRisks / notes:\n${risks}` : ""}`,
        durationMs: Date.now() - started,
      },
      proposed: proposal,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Task & batch delegation (the orchestra)                             */
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
    if (prompt.length < 12) {
      return fail(
        "Task.prompt is too short to be self-contained. Include the goal, the files or area to work in, the " +
          "constraints, and the acceptance criteria — the subagent sees only what you send.",
      );
    }

    const session = await this.host.getSession(sessionId);
    const projectPath = session.projectPath!;
    const wanted = (typeof args.subagent === "string" ? args.subagent.trim() : "").toLowerCase();
    let def: SubagentRecord | undefined;
    if (wanted) {
      const userSubagents = this.host.listSubagents ? await this.host.listSubagents(projectPath) : [];
      def =
        userSubagents.find((d) => d.name.toLowerCase() === wanted || d.id === wanted) ??
        BUILTIN_SUBAGENTS.find((d) => d.name.toLowerCase() === wanted || d.id === wanted);
      if (!def) {
        const known = [...(this.host.listSubagents ? await this.host.listSubagents(projectPath) : []), ...BUILTIN_SUBAGENTS]
          .map((d) => d.name)
          .join(", ");
        return fail(`unknown subagent: ${args.subagent}. Available: ${known}`);
      }
    }
    const model = await this.resolveModel(def, parentModel);

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

    const readOnly = args.read_only === true;
    const tools = this.delegationTools(await this.host.listTools(sessionId), readOnly);
    const context = typeof args.context === "string" ? args.context : undefined;

    try {
      let outcome = await this.runDelegation({
        sessionId,
        prompt,
        projectPath,
        tools,
        model,
        systemExtra: def?.systemPrompt,
        description,
        context,
        readOnly,
        parentSignal,
      });

      // One retry: hand the failure back with the error in context. Most
      // subagent failures are recoverable (wrong path, missing flag).
      if (outcome.status !== "done" && !parentSignal.aborted) {
        const retryPrompt = [
          prompt,
          "",
          "<previous-attempt>",
          `The first attempt did not finish: ${outcome.error ?? outcome.status}`,
          outcome.report ? `Partial output:\n${outcome.report.slice(0, 2_000)}` : "",
          "Re-approach: pick a different strategy rather than repeating the same steps, and finish with the required report.",
          "</previous-attempt>",
        ]
          .filter(Boolean)
          .join("\n");
        outcome = await this.runDelegation({
          sessionId,
          prompt: retryPrompt,
          projectPath,
          tools,
          model,
          systemExtra: def?.systemPrompt,
          description,
          context,
          readOnly,
          parentSignal,
        });
      }

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
          ? {
              ok: true,
              output: `Subagent report (${record.agentName}):\n${outcome.report}`,
              durationMs: Date.now() - started,
            }
          : { ok: false, error: outcome.error ?? "subagent failed", durationMs: Date.now() - started },
      };
    } catch (err) {
      record.status = parentSignal.aborted ? "stopped" : "error";
      record.completedAt = Date.now();
      record.error = err instanceof Error ? err.message : String(err);
      this.storeDelegation(sessionId, record);
      yield { type: "subagent/end", sessionId, delegation: { ...record } };
      return { result: { ok: false, error: record.error, durationMs: Date.now() - started } };
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
      return { result: { ok: false, error: "batch_tasks requires a non-empty tasks array", durationMs: Date.now() - started } };
    }

    const tasks = rawTasks.slice(0, 8).map((t: any, idx: number): BatchTask => ({
      id: typeof t?.id === "string" && t.id.trim() ? t.id.trim() : `task-${idx + 1}`,
      description:
        typeof t?.description === "string" && t.description.trim() ? t.description.trim() : `task-${idx + 1}`,
      prompt: typeof t?.prompt === "string" ? t.prompt.trim() : "",
      subagent: typeof t?.subagent === "string" ? t.subagent.trim() : undefined,
      dependsOn: Array.isArray(t?.depends_on)
        ? t.depends_on.filter((d: unknown): d is string => typeof d === "string" && !!d.trim())
        : ([] as string[]),
      readOnly: t?.read_only === true,
      context: typeof t?.context === "string" ? t.context : undefined,
    }));
    if (tasks.some((t) => !t.prompt)) {
      return { result: { ok: false, error: "batch_tasks: every task needs a non-empty prompt", durationMs: Date.now() - started } };
    }

    const ids = new Set(tasks.map((t) => t.id));
    if (ids.size !== tasks.length) {
      return { result: { ok: false, error: "batch_tasks: task ids must be unique", durationMs: Date.now() - started } };
    }
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          return {
            result: {
              ok: false,
              error: `batch_tasks: task "${task.id}" depends on unknown task "${dep}"`,
              durationMs: Date.now() - started,
            },
          };
        }
        if (dep === task.id) {
          return {
            result: { ok: false, error: `batch_tasks: task "${task.id}" depends on itself`, durationMs: Date.now() - started },
          };
        }
      }
    }

    const session = await this.host.getSession(sessionId);
    const projectPath = session.projectPath!;
    const userSubagents = this.host.listSubagents ? await this.host.listSubagents(projectPath) : [];
    const allSubagents = [
      ...userSubagents,
      ...BUILTIN_SUBAGENTS.filter(
        (b) => !userSubagents.some((u) => u.id === b.id || u.name.toLowerCase() === b.name.toLowerCase()),
      ),
    ];
    const allTools = await this.host.listTools(sessionId);

    const concurrencyRaw =
      typeof args.max_concurrency === "number"
        ? args.max_concurrency
        : (this.opts.maxDelegationConcurrency ?? 4);
    const concurrency = Math.min(Math.max(1, Math.floor(concurrencyRaw)), 8);

    const plans = new Map<
      string,
      {
        task: (typeof tasks)[number];
        def?: SubagentRecord;
        model: ModelSpec;
        record: DelegationSummary;
      }
    >();
    for (const task of tasks) {
      const wanted = (task.subagent ?? "").toLowerCase();
      const def = wanted ? allSubagents.find((d) => d.name.toLowerCase() === wanted || d.id === wanted) : undefined;
      const model = await this.resolveModel(def, parentModel);
      plans.set(task.id, {
        task,
        def,
        model,
        record: {
          id: randomUUID(),
          sessionId,
          agentName: def?.name ?? "default",
          description: task.description,
          status: "running",
          startedAt: Date.now(),
        },
      });
    }

    // Dependency-ordered waves. A cycle leaves tasks unrun — reported, not
    // silently dropped.
    const done = new Map<string, { report: string; status: DelegationStatus }>();
    const remaining = new Set(tasks.map((t) => t.id));
    const settled: Array<{ id: string; report: string; status: DelegationStatus; error?: string }> = [];

    while (remaining.size > 0) {
      const wave = [...remaining].filter((id) => {
        const task = plans.get(id)!.task;
        return task.dependsOn.every((dep) => done.has(dep));
      });
      if (wave.length === 0) {
        for (const id of remaining) {
          const plan = plans.get(id)!;
          const blockedBy = plan.task.dependsOn.filter((dep) => !done.has(dep)).join(", ");
          plan.record.status = "error";
          plan.record.completedAt = Date.now();
          plan.record.error = `not run: dependency cycle or unmet dependency (${blockedBy})`;
          yield { type: "subagent/end", sessionId, delegation: { ...plan.record } };
          settled.push({ id, report: "", status: "error", error: plan.record.error });
        }
        break;
      }
      if (parentSignal.aborted) break;

      for (const id of wave) remaining.delete(id);
      for (const id of wave) {
        const plan = plans.get(id)!;
        this.storeDelegation(sessionId, plan.record);
        yield { type: "subagent/start", sessionId, delegation: { ...plan.record } };
      }

      const results = await runWithConcurrency(wave, concurrency, async (id) => {
        const plan = plans.get(id)!;
        const tools = this.delegationTools(allTools, plan.task.readOnly);
        const depContext = plan.task.dependsOn.length
          ? plan.task.dependsOn
              .map((dep) => {
                const prior = done.get(dep);
                const priorPlan = plans.get(dep);
                return prior
                  ? `### ${priorPlan?.task.description ?? dep} [${prior.status}]\n${prior.report}`
                  : `### ${dep}\n(not available)`;
              })
              .join("\n\n")
          : "";
        const context = [plan.task.context, depContext ? `<prior-results>\n${depContext}\n</prior-results>` : ""]
          .filter(Boolean)
          .join("\n\n");

        const outcome = await this.runDelegation({
          sessionId,
          prompt: plan.task.prompt,
          projectPath,
          tools,
          model: plan.model,
          systemExtra: plan.def?.systemPrompt,
          description: plan.task.description,
          context: context || undefined,
          readOnly: plan.task.readOnly,
          parentSignal,
        });
        return { id, outcome };
      });

      for (const { id, outcome } of results) {
        const plan = plans.get(id)!;
        plan.record.status = outcome.status;
        plan.record.completedAt = Date.now();
        plan.record.turns = outcome.turns;
        plan.record.usage = outcome.usage;
        plan.record.report = outcome.report;
        plan.record.error = outcome.error;
        this.storeDelegation(sessionId, plan.record);
        yield { type: "subagent/end", sessionId, delegation: { ...plan.record } };
        settled.push({ id, report: outcome.report, status: outcome.status, error: outcome.error });
        done.set(id, { report: outcome.report, status: outcome.status });
      }
    }

    const order = new Map(tasks.map((t, i) => [t.id, i]));
    settled.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

    const reports = settled.map(({ id, status, report, error }) => {
      const plan = plans.get(id)!;
      const header = `### ${plan.task.description} (${plan.record.agentName}) [${status}]`;
      const body = report || error || "(no output)";
      return `${header}\n${body}`;
    });

    const failures = settled.filter((s) => s.status !== "done");
    const output = [
      `Batch complete — ${settled.length - failures.length}/${settled.length} task(s) finished.`,
      "",
      reports.join("\n\n"),
      "",
      failures.length
        ? "Some tasks did not finish. Verify anything you depend on before reporting completion."
        : "All tasks finished. Spot-check their claims (files changed, checks run) before reporting completion.",
    ].join("\n");

    return {
      result: {
        ok: failures.length === 0,
        output,
        durationMs: Date.now() - started,
      },
    };
  }

  private async resolveModel(def: SubagentRecord | undefined, fallback: ModelSpec): Promise<ModelSpec> {
    if (def?.model && this.host.resolveModel) {
      try {
        return await this.host.resolveModel(def.model);
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  /**
   * A subagent's toolset: never the delegation tools (no nesting), never the
   * interactive or planning tools (it cannot talk to the user), and only
   * read tools when the run is read-only.
   */
  private delegationTools(tools: ToolDefinition[], readOnly: boolean): ToolDefinition[] {
    const blocked = new Set([...INTERCEPTED_TOOLS]);
    const filtered = tools.filter((t) => !blocked.has(t.name));
    return readOnly ? filtered.filter((t) => t.risk === "read") : filtered;
  }

  private async runDelegation(opts: {
    sessionId: string;
    prompt: string;
    projectPath: string;
    tools: ToolDefinition[];
    model: ModelSpec;
    systemExtra?: string;
    description?: string;
    context?: string;
    readOnly?: boolean;
    parentSignal: AbortSignal;
  }): Promise<{ status: DelegationStatus; report: string; turns: number; usage: Usage; error?: string }> {
    const provider = this.makeProvider(opts.model);
    const system = composeSystemPrompt({
      projectPath: opts.projectPath,
      base: [
        `You are a specialised senastr subagent working inside the project: ${opts.projectPath}`,
        "",
        BASE_PROTOCOL,
      ].join("\n"),
      delegation: {
        description: opts.description,
        systemExtra: opts.systemExtra,
        context: opts.context,
        readOnly: opts.readOnly,
      },
    });

    const memoryBlock = this.host.memoryPrompt
      ? await safeText(() => this.host.memoryPrompt!(opts.projectPath, opts.prompt, 5))
      : "";
    const fullSystem = memoryBlock ? `${system}\n\n${memoryBlock}` : system;

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
        system: fullSystem,
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

      const toolByName = new Map(opts.tools.map((t) => [t.name, t]));
      history.push(makeMessage("assistant", text, calls));

      // Independent read-only calls run concurrently here too.
      const outcomes = await Promise.all(
        calls.map(async (call) => {
          if (opts.parentSignal.aborted) {
            return { call, result: { ok: false, error: "aborted", durationMs: 0 } as ToolResult };
          }
          const repair = repairToolCall(call, toolByName.get(call.name), [...toolByName.keys()]);
          if (!repair.ok) {
            return { call, result: { ok: false, error: repair.error, durationMs: 0 } as ToolResult };
          }
          const result = await this.host.runTool({ sessionId: opts.sessionId, tool: call.name, args: repair.args });
          return { call, result };
        }),
      );

      for (const { call, result } of outcomes) {
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

    // Exhausting the budget *with* a final answer is a partial success — say so.
    // Exhausting it without one is a failure: the parent must be able to react.
    const report = lastText.trim();
    if (!report) {
      return {
        status: "error",
        report: "",
        turns,
        usage,
        error: `hit the ${DELEGATION_MAX_STEPS}-step limit without producing a final report`,
      };
    }
    return {
      status: "done",
      report: capReport(`${report}\n\n(note: step limit reached)`),
      turns,
      usage,
    };
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
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function isParallelSafe(call: ToolCall, tool: ToolDefinition | undefined): boolean {
  if (!tool) return false;
  if (INTERCEPTED_TOOLS.has(call.name)) return false;
  return tool.risk === "read";
}

function signatureOf(call: ToolCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.arguments ?? {});
  } catch {
    args = String(call.arguments);
  }
  return `${call.name}:${args}`.slice(0, 400);
}

function mergeSkills(userSkills: SkillRecord[]): SkillRecord[] {
  const out: SkillRecord[] = [];
  const seen = new Set<string>();
  for (const skill of [...userSkills, ...BUILTIN_SKILLS]) {
    const key = skill.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out;
}

/**
 * Keyword auto-activation for skills. The model is told to call `use_skill`,
 * but a missed activation silently costs the whole skill, so we also load a
 * small number of strongly-matching bodies directly.
 */
export function autoActivateSkills(
  skills: SkillRecord[],
  query: string,
  alreadyActive: Set<string>,
): SkillRecord[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scored: Array<{ skill: SkillRecord; score: number }> = [];
  for (const skill of skills) {
    if (alreadyActive.has(skill.id)) continue;
    const haystack = tokenize(
      [skill.id, skill.name, skill.description ?? "", ...(skill.triggers ?? [])].join(" "),
    );
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score += 1;
    // A literal trigger phrase is a much stronger signal than word overlap.
    const lower = query.toLowerCase();
    for (const trigger of skill.triggers ?? []) {
      if (trigger && lower.includes(trigger.toLowerCase())) score += 3;
    }
    if (score >= 2) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const picked: SkillRecord[] = [];
  let used = 0;
  for (const { skill } of scored) {
    if (picked.length >= MAX_AUTO_SKILLS) break;
    const size = skill.content.length;
    if (used + size > AUTO_SKILL_CHAR_BUDGET && picked.length > 0) break;
    used += size;
    picked.push(skill);
  }
  return picked;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
}

function latestUserText(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return "";
}

function renderTaskList(todos: TodoItem[]): string {
  return todos
    .map((t) => {
      const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
      return `[${mark}] ${t.id} ${t.content}${t.notes ? ` — ${t.notes}` : ""}`;
    })
    .join("\n");
}

function VERIFICATION_NUDGE(changes: number): string {
  return (
    `You made ${changes} file change(s) this turn and have not run the project's checks yet. ` +
    "Before you finish: run `verify` (or the project's test/typecheck/lint command), read the exit codes, fix any " +
    "failure, and only then report. If a check genuinely cannot run in this environment, say so explicitly and " +
    "state what remains unverified."
  );
}

/** Swap the compaction placeholder for a model-written summary. */
function withCheckpointText(compaction: CompactResult, text: string): ChatMessage[] {
  return compaction.messages.map((message) =>
    message.id.startsWith("checkpoint-") ? { ...message, content: text } : message,
  );
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function safeList(fn: () => Promise<SkillRecord[]>): Promise<SkillRecord[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

async function safeText(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch {
    return "";
  }
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
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

/**
 * Skills are explicit user instructions, not tools. Delimit each document so
 * one skill cannot accidentally blend into the next in the system prompt.
 *
 * Kept for the inlining path (always-on skills and direct callers).
 */
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

export { DELEGATION_REPORT_CONTRACT };
