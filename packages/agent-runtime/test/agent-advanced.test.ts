import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  type ChatMessage,
  type Session,
  type SkillRecord,
  type ToolDefinition,
  type ToolResult,
} from "@senastr/shared";
import {
  AgentRuntime,
  autoActivateSkills,
  composeSystemPrompt,
  renderSkillManifests,
  type HostBridge,
  type Provider,
  type ProviderChatParams,
  type ProviderEvent,
} from "../src/index";

const tmpDirs: string[] = [];
function track<T extends string>(dir: T): T {
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const model = { kind: "openai" as const, model: "test-model" };

/** Records every system prompt the runtime sends, plus concurrent tool runs. */
class FakeHost implements HostBridge {
  sessions = new Map<string, Session>();
  toolLog: Array<{ tool: string; args: Record<string, unknown> }> = [];
  systems: string[] = [];
  prompts: string[] = [];
  concurrency = 0;
  maxConcurrency = 0;
  skills: SkillRecord[] = [];
  memoryBlock = "";
  toolBehavior: (tool: string, args: Record<string, unknown>) => ToolResult | Promise<ToolResult> = () => ({
    ok: true,
    output: "tool ok",
    durationMs: 1,
  });

  constructor(mode: "build" | "plan" = "build") {
    const project = track(mkdtempSync(join(tmpdir(), "senastr-adv-proj-")));
    const session: Session = {
      id: "s1",
      title: "test",
      projectPath: project,
      mode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      messages: [],
    };
    this.sessions.set(session.id, session);
  }

  async getSession(id: string): Promise<Session> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no session");
    return { ...s, messageCount: s.messages.length, messages: [...s.messages] };
  }

  async appendMessages(id: string, messages: ChatMessage[]): Promise<unknown> {
    this.sessions.get(id)!.messages.push(...messages);
    return null;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return BUILTIN_TOOLS;
  }

  async listSkills(): Promise<SkillRecord[]> {
    return this.skills;
  }

  async memoryPrompt(_projectPath: string, query: string): Promise<string> {
    this.prompts.push(query);
    return this.memoryBlock;
  }

  async runTool(req: { sessionId: string; tool: string; args: Record<string, unknown> }): Promise<ToolResult> {
    this.toolLog.push({ tool: req.tool, args: req.args });
    this.concurrency += 1;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.concurrency);
    try {
      if (this.concurrency > 1) await new Promise((r) => setTimeout(r, 5));
      return await this.toolBehavior(req.tool, req.args);
    } finally {
      this.concurrency -= 1;
    }
  }
}

class ScriptedProvider implements Provider {
  step = 0;
  lastParams: ProviderChatParams | undefined;
  params: ProviderChatParams[] = [];
  constructor(private scripts: Array<ProviderEvent[]>) {}
  async *streamChat(params: ProviderChatParams): AsyncIterable<ProviderEvent> {
    this.lastParams = params;
    this.params.push(params);
    this.systems.push(params.system ?? "");
    const script = this.scripts[Math.min(this.step, this.scripts.length - 1)];
    this.step += 1;
    for (const evt of script) yield evt;
  }
  systems: string[] = [];
}

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

const skill = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: "demo-skill",
  name: "Demo Skill",
  description: "Use when doing demo things carefully",
  content: "BODY-OF-DEMO-SKILL step one, step two",
  enabled: true,
  level: "global",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/* ------------------------------------------------------------------ */
/* progressive disclosure                                              */
/* ------------------------------------------------------------------ */

describe("progressive disclosure", () => {
  it("advertises skills by name and description, not by body", async () => {
    const host = new FakeHost();
    host.skills = [skill()];
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "do the demo thing", model }));

    const system = provider.systems[0];
    expect(system).toContain("<available-skills>");
    expect(system).toContain("demo-skill — Demo Skill");
    expect(system).toContain("Use when doing demo things");
    // The body is what we are saving: it must NOT be there.
    expect(system).not.toContain("BODY-OF-DEMO-SKILL");
    expect(system).toMatch(/use_skill/);
  });

  it("inlines a skill marked always: true", async () => {
    const host = new FakeHost();
    host.skills = [skill({ always: true })];
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "anything", model }));
    expect(provider.systems[0]).toContain("BODY-OF-DEMO-SKILL");
  });

  it("auto-loads a skill whose triggers match the request", async () => {
    const host = new FakeHost();
    host.skills = [skill({ triggers: ["demo things"], description: "Demo workflow" })];
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "please handle the demo things now", model }));
    expect(provider.systems[0]).toContain("BODY-OF-DEMO-SKILL");
    expect(provider.systems[0]).toContain("<active-skills>");
  });

  it("does not auto-load when the request is unrelated", async () => {
    const host = new FakeHost();
    host.skills = [skill({ triggers: ["demo things"] })];
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "rename the variable x to y", model }));
    expect(provider.systems[0]).not.toContain("BODY-OF-DEMO-SKILL");
  });

  it("can be turned off", async () => {
    const host = new FakeHost();
    host.skills = [skill({ triggers: ["demo things"] })];
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider, autoActivateSkills: false });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "handle the demo things", model }));
    expect(provider.systems[0]).not.toContain("BODY-OF-DEMO-SKILL");
  });

  it("keeps the manifest block small enough to ship on every request", () => {
    const many = Array.from({ length: 20 }, (_, i) => skill({ id: `s${i}`, name: `Skill ${i}` }));
    const block = renderSkillManifests(many);
    expect(block.length).toBeLessThan(4_000);
  });

  it("auto-activation stays inside its character budget", () => {
    const big = skill({ content: "x".repeat(20_000), triggers: ["demo things"] });
    const picked = autoActivateSkills([big, skill({ id: "small", triggers: ["demo things"] })], "demo things", new Set());
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(picked.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(9_000 + 20_000);
    expect(picked[0].id).toBe("demo-skill");
  });
});

/* ------------------------------------------------------------------ */
/* memory                                                              */
/* ------------------------------------------------------------------ */

describe("memory integration", () => {
  it("injects the host's memory block and passes the request as the recall query", async () => {
    const host = new FakeHost();
    host.memoryBlock = "<project memory index>\n- auth-flow: tokens rotate\n</project memory index>";
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "where are the tokens?", model }));
    expect(provider.systems[0]).toContain("auth-flow: tokens rotate");
    expect(host.prompts[0]).toContain("tokens");
  });

  it("keeps working when the memory host is unavailable", async () => {
    const host = new FakeHost();
    delete (host as { memoryPrompt?: unknown }).memoryPrompt;
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "hi", model }));
    expect(events[events.length - 1].stopReason).toBe("stop");
  });
});

/* ------------------------------------------------------------------ */
/* tool execution                                                      */
/* ------------------------------------------------------------------ */

describe("tool execution", () => {
  it("runs independent read-only calls concurrently and in order", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [
        { kind: "tool-call", id: "a", name: "glob", arguments: { pattern: "**/*.ts" } },
        { kind: "tool-call", id: "b", name: "grep", arguments: { pattern: "auth" } },
        { kind: "tool-call", id: "c", name: "list_dir", arguments: { path: "." } },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "done" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "explore", model }));

    expect(host.maxConcurrency).toBeGreaterThan(1);
    // Order of results in the transcript must follow the call order.
    const toolMessages = host.sessions.get("s1")!.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.toolName)).toEqual(["glob", "grep", "list_dir"]);
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
  });

  it("serialises write calls so two edits cannot race", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [
        { kind: "tool-call", id: "a", name: "write_file", arguments: { path: "a.ts", content: "1" } },
        { kind: "tool-call", id: "b", name: "write_file", arguments: { path: "b.ts", content: "2" } },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "done" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "write two files", model }));
    expect(host.maxConcurrency).toBe(1);
    expect(host.toolLog.map((t) => t.args.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("repairs a bad call and returns a message the model can act on", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "a", name: "read_file", arguments: { path: "a.ts", start_line: "12" } }, { kind: "done" }],
      [{ kind: "text", delta: "read it" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "read", model }));

    expect(host.toolLog[0].args.start_line).toBe(12);
    const result = events.find((e: any) => e.type === "tool/result");
    expect(result.ok).toBe(true);
    expect(result.result.output).toMatch(/auto-corrected/);
  });

  it("rejects an unknown tool without calling the host", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "a", name: "read_fil", arguments: { path: "a.ts" } }, { kind: "done" }],
      [{ kind: "text", delta: "understood" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "read", model }));
    expect(host.toolLog).toHaveLength(0);
    const result = events.find((e: any) => e.type === "tool/result");
    expect(result.ok).toBe(false);
    expect(result.result.error).toMatch(/Did you mean "read_file"/);
  });

  it("warns after repeated identical failures and stops before the budget is burnt", async () => {
    const host = new FakeHost();
    host.toolBehavior = () => ({ ok: false, error: "file not found", durationMs: 1 });
    const failing = [
      { kind: "tool-call", id: "a", name: "read_file", arguments: { path: "missing.ts" } },
      { kind: "done" },
    ] as ProviderEvent[];
    const provider = new ScriptedProvider([failing, failing, failing, failing, failing]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider, maxSteps: 20 });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "read it", model }));

    const last = events[events.length - 1];
    expect(last.stopReason).toBe("stuck");
    // The warning reached the model before the turn was cut.
    const warned = provider.systems.some((s) => s.includes("repeated the same failing tool call"));
    expect(warned).toBe(true);
    // It stopped well before maxSteps.
    expect(host.toolLog.length).toBeLessThanOrEqual(4);
  });
});

/* ------------------------------------------------------------------ */
/* task tracking + reasoning                                           */
/* ------------------------------------------------------------------ */

describe("task tracking", () => {
  it("emits todo/update and re-injects the list on later steps", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool-call",
          id: "t",
          name: "todo_write",
          arguments: {
            todos: [
              { id: "t1", content: "Find the bug", status: "in_progress" },
              { id: "t2", content: "Fix the bug", status: "pending" },
            ],
          },
        },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "on it" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "fix the bug", model }));

    const update = events.find((e: any) => e.type === "todo/update");
    expect(update.todos).toHaveLength(2);
    expect(update.todos[0].status).toBe("in_progress");
    expect(provider.systems[1]).toContain("<task-list>");
    expect(provider.systems[1]).toContain("Find the bug");
    expect(provider.systems[1]).toContain("0/2 completed");
    expect(runtime.todosFor("s1")).toHaveLength(2);
  });

  it("rejects a malformed todo list", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "t", name: "todo_write", arguments: { todos: [{ id: "t1" }] } }, { kind: "done" }],
      [{ kind: "text", delta: "ok" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "plan", model }));
    const result = events.find((e: any) => e.type === "tool/result");
    expect(result.ok).toBe(false);
    expect(result.result.error).toMatch(/needs content/);
  });

  it("records think steps and keeps the latest one in view", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "k", name: "think", arguments: { thought: "Option A is safer because it is reversible." } }, { kind: "done" }],
      [{ kind: "text", delta: "going with A" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "choose", model }));
    const result = events.find((e: any) => e.type === "tool/result");
    expect(result.ok).toBe(true);
    expect(result.result.output).toMatch(/Recorded reasoning step 1/);
    expect(provider.systems[1]).toContain("Option A is safer");
  });
});

/* ------------------------------------------------------------------ */
/* verification gate                                                   */
/* ------------------------------------------------------------------ */

describe("verification gate", () => {
  it("refuses to let a turn end after writes until checks have run", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "w", name: "write_file", arguments: { path: "a.ts", content: "x" } }, { kind: "done" }],
      // The model tries to finish without verifying.
      [{ kind: "text", delta: "all done" }, { kind: "done" }],
      [{ kind: "tool-call", id: "v", name: "verify", arguments: {} }, { kind: "done" }],
      [{ kind: "text", delta: "verified" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "change a file", model }));

    // The nudge reached the model as a user turn, the standing warning was in
    // the prompt, and verify actually ran.
    const transcript = host.sessions.get("s1")!.messages.map((m) => m.content).join("\n");
    expect(transcript).toContain("have not run the project's checks");
    expect(provider.systems.some((sys) => sys.includes("Run `verify` before reporting completion"))).toBe(true);
    expect(host.toolLog.map((t) => t.tool)).toEqual(["write_file", "verify"]);
  });

  it("insists at most once, so a turn can always end", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "w", name: "write_file", arguments: { path: "a.ts", content: "x" } }, { kind: "done" }],
      [{ kind: "text", delta: "done, cannot verify" }, { kind: "done" }],
      [{ kind: "text", delta: "still done" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "change a file", model }));
    expect(events[events.length - 1].stopReason).toBe("stop");
    expect(host.toolLog).toHaveLength(1);
  });

  it("does not nag when nothing was written", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "r", name: "read_file", arguments: { path: "a.ts" } }, { kind: "done" }],
      [{ kind: "text", delta: "here it is" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "read a file", model }));
    expect(provider.systems.some((s) => s.includes("have not run the project's checks"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* context                                                             */
/* ------------------------------------------------------------------ */

describe("context management", () => {
  it("summarises compacted-away history into the checkpoint", async () => {
    const host = new FakeHost();
    // Enough history to force compaction.
    const history: ChatMessage[] = [{ id: "u0", role: "user", content: "refactor the parser", createdAt: Date.now() }];
    for (let i = 0; i < 24; i++) {
      history.push({ id: `a${i}`, role: "assistant", content: `step ${i} `.repeat(600), createdAt: Date.now() });
      history.push({
        id: `t${i}`,
        role: "tool",
        toolCallId: `c${i}`,
        toolName: "read_file",
        content: "output ".repeat(900),
        createdAt: Date.now(),
      });
    }
    host.sessions.get("s1")!.messages = history;

    let summaryCalls = 0;
    const summarizer: Provider = {
      async *streamChat(): AsyncIterable<ProviderEvent> {
        summaryCalls += 1;
        yield { kind: "text", delta: "SUMMARY: refactored the parser; tests failing on fixtures." };
        yield { kind: "done", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const main = new ScriptedProvider([[{ kind: "text", delta: "continuing" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, {
      contextCharBudget: 20_000,
      // A tool-less request is the summariser; the main turn carries tools.
      providerFactory: () =>
        ({
          streamChat(params: ProviderChatParams) {
            return params.tools.length === 0 ? summarizer.streamChat(params) : main.streamChat(params);
          },
        }) as Provider,
    });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "keep going", model }));

    expect(summaryCalls).toBeGreaterThan(0);
    // The summary replaces the placeholder checkpoint inside the request window.
    const mainParams = main.params.find((p) => p.tools.length > 0)!;
    expect(mainParams.messages.some((m: ChatMessage) => m.content.includes("SUMMARY: refactored the parser"))).toBe(true);
    expect(events[events.length - 1].compaction?.dropped).toBeGreaterThan(0);
  });

  it("falls back to the placeholder when summarisation fails", async () => {
    const host = new FakeHost();
    const history: ChatMessage[] = [{ id: "u0", role: "user", content: "task", createdAt: Date.now() }];
    for (let i = 0; i < 20; i++) {
      history.push({ id: `a${i}`, role: "assistant", content: `x${i} `.repeat(900), createdAt: Date.now() });
    }
    host.sessions.get("s1")!.messages = history;

    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, {
      contextCharBudget: 8_000,
      providerFactory: () =>
        ({
          streamChat(params: ProviderChatParams) {
            if (params.tools.length === 0) throw new Error("summariser is down");
            return provider.streamChat(params);
          },
        }) as Provider,
    });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "go", model }));
    // No crash despite the summariser failing, and the placeholder still anchors the window.
    expect(events[events.length - 1].stopReason).toBe("stop");
    const mainParams = provider.params.find((p) => p.tools.length > 0);
    expect(mainParams?.messages.some((m: ChatMessage) => m.content.includes("context checkpoint"))).toBe(true);
  });

  it("can be turned off", async () => {
    const host = new FakeHost();
    const history: ChatMessage[] = [{ id: "u0", role: "user", content: "task", createdAt: Date.now() }];
    for (let i = 0; i < 20; i++) {
      history.push({ id: `a${i}`, role: "assistant", content: `x${i} `.repeat(900), createdAt: Date.now() });
    }
    host.sessions.get("s1")!.messages = history;
    const provider = new ScriptedProvider([[{ kind: "text", delta: "ok" }, { kind: "done" }]]);
    const runtime = new AgentRuntime(host, {
      contextCharBudget: 8_000,
      summarizeHistory: false,
      providerFactory: () => provider,
    });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "go", model }));
    // Exactly one model request: no summarisation round-trip.
    expect(provider.params).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* delegation                                                          */
/* ------------------------------------------------------------------ */

describe("delegation", () => {
  it("gives the subagent a structured reporting contract and project context", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool-call",
          id: "t1",
          name: "Task",
          arguments: { description: "audit auth", prompt: "audit the auth module end to end", subagent: "reviewer" },
        },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "## Summary\nFound two issues." }, { kind: "done" }],
      [{ kind: "text", delta: "delegated" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "review auth", model }));

    const subSystem = provider.systems[1];
    expect(subSystem).toContain("Reporting contract");
    expect(subSystem).toContain("## Verification");
    expect(subSystem).toContain("audit auth");
    // A subagent must not be able to delegate or interrupt the user.
    const subTools = provider.params[1].tools.map((t: ToolDefinition) => t.name);
    expect(subTools).not.toContain("Task");
    expect(subTools).not.toContain("ask_user");
    expect(subTools).toContain("verify");
  });

  it("restricts a read-only subagent to read tools", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool-call",
          id: "t1",
          name: "Task",
          arguments: { description: "map the code", prompt: "map the module structure for me", read_only: true },
        },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "mapped" }, { kind: "done" }],
      [{ kind: "text", delta: "done" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(runtime.runTurn({ sessionId: "s1", userMessage: "map it", model }));

    const names = provider.params[1].tools.map((t: ToolDefinition) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_command");
    expect(provider.systems[1]).toContain("READ-ONLY RUN");
  });

  it("runs a dependency graph in order and hands each wave the prior reports", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool-call",
          id: "b1",
          name: "batch_tasks",
          arguments: {
            tasks: [
              { id: "explore", description: "explore", prompt: "find the entry points", subagent: "explorer" },
              { id: "impl", description: "implement", prompt: "implement the change", depends_on: ["explore"] },
            ],
            max_concurrency: 1,
          },
        },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "ENTRY: src/index.ts" }, { kind: "done" }],
      [{ kind: "text", delta: "IMPLEMENTED the change in src/index.ts" }, { kind: "done" }],
      [{ kind: "text", delta: "all done" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "do both", model }));

    const results = events.filter((e: any) => e.type === "tool/result");
    const toolMessage = host.sessions.get("s1")!.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("Batch complete");
    expect(toolMessage?.content).toContain("ENTRY: src/index.ts");
    expect(toolMessage?.content).toContain("IMPLEMENTED");
    expect(results.length).toBeGreaterThan(0);

    // The dependent task was given the explorer's report.
    const implSystem = provider.systems[2];
    expect(implSystem).toContain("prior-results");
    expect(implSystem).toContain("ENTRY: src/index.ts");
  });

  it("rejects a batch with an unknown dependency or a cycle", async () => {
    const host = new FakeHost();
    const bad = new ScriptedProvider([
      [
        {
          kind: "tool-call",
          id: "b1",
          name: "batch_tasks",
          arguments: { tasks: [{ id: "a", description: "a", prompt: "do the thing", depends_on: ["ghost"] }] },
        },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "ok" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => bad });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "go", model }));
    const result = events.find((e: any) => e.type === "tool/result");
    expect(result.ok).toBe(false);
    expect(result.result.error).toMatch(/unknown task "ghost"/);
  });

  it("retries a failed delegation once with the error in context", async () => {
    const host = new FakeHost();
    let calls = 0;
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool-call",
          id: "t1",
          name: "Task",
          arguments: { description: "explore", prompt: "find the config loader module", subagent: "explorer" },
        },
        { kind: "done" },
      ],
      // First attempt: a tool call whose failure exhausts the subagent steps.
      ...Array.from({ length: 16 }, () => [
        { kind: "tool-call", id: `x${Math.random()}`, name: "read_file", arguments: { path: "nope.ts" } },
        { kind: "done" },
      ] as ProviderEvent[]),
      // Retry attempt: succeeds immediately.
      [{ kind: "text", delta: "RETRY-SUCCESS" }, { kind: "done" }],
      [{ kind: "text", delta: "parent done" }, { kind: "done" }],
    ]);
    host.toolBehavior = () => {
      calls += 1;
      return { ok: false, error: "no such file", durationMs: 1 };
    };
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "go", model }));
    const toolMessage = host.sessions.get("s1")!.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("RETRY-SUCCESS");
    expect(calls).toBeGreaterThan(1);
    expect(events[events.length - 1].stopReason).toBe("stop");
  });

  it("names the available subagents when an unknown one is requested", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool-call",
          id: "t1",
          name: "Task",
          arguments: { description: "x", prompt: "do the delegated work", subagent: "wizard" },
        },
        { kind: "done" },
      ],
      [{ kind: "text", delta: "ok" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "go", model }));
    const result = events.find((e: any) => e.type === "tool/result");
    expect(result.result.error).toMatch(/unknown subagent: wizard/);
    expect(result.result.error).toMatch(/Explorer/);
  });

  it("insists on a self-contained brief", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "t1", name: "Task", arguments: { description: "x", prompt: "go" } }, { kind: "done" }],
      [{ kind: "text", delta: "ok" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    const events = await collect(runtime.runTurn({ sessionId: "s1", userMessage: "go", model }));
    const result = events.find((e: any) => e.type === "tool/result");
    expect(result.result.error).toMatch(/too short to be self-contained/);
  });
});

/* ------------------------------------------------------------------ */
/* system prompt composition                                           */
/* ------------------------------------------------------------------ */

describe("composeSystemPrompt", () => {
  it("orders the layers: protocol, standing instructions, skills, memory, tasks, warnings", () => {
    const system = composeSystemPrompt({
      projectPath: "/p",
      base: "BASE",
      standingInstructions: "INSTRUCTIONS",
      skills: [skill()],
      memory: "MEMORY",
      todos: [{ id: "t1", content: "do it", status: "pending" }],
      warnings: ["careful"],
    });
    expect(system.indexOf("BASE")).toBeLessThan(system.indexOf("INSTRUCTIONS"));
    expect(system.indexOf("INSTRUCTIONS")).toBeLessThan(system.indexOf("<available-skills>"));
    expect(system.indexOf("<available-skills>")).toBeLessThan(system.indexOf("MEMORY"));
    expect(system.indexOf("MEMORY")).toBeLessThan(system.indexOf("<task-list>"));
    expect(system.indexOf("<task-list>")).toBeLessThan(system.indexOf("<runtime-warnings>"));
  });

  it("adds the read-only rules in plan mode", () => {
    const system = composeSystemPrompt({ projectPath: "/p", planMode: true });
    expect(system).toContain("PLAN MODE");
    expect(system).toContain("submit_plan");
  });

  it("omits empty layers entirely", () => {
    const system = composeSystemPrompt({ projectPath: "/p", base: "BASE" });
    expect(system).toBe("BASE");
  });
});
