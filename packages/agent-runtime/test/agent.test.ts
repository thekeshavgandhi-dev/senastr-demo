import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  type ChatMessage,
  type Session,
  type ToolDefinition,
  type ToolResult,
} from "@senastr/shared";
import {
  AgentRuntime,
  toAnthropicMessages,
  toOpenAIMessages,
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

/** In-memory host: sessions + a scripted tool responder. */
class FakeHost implements HostBridge {
  sessions = new Map<string, Session>();
  toolLog: Array<{ tool: string; args: Record<string, unknown> }> = [];
  toolBehavior: (tool: string, args: Record<string, unknown>) => ToolResult = () => ({
    ok: true,
    output: "tool ok",
    durationMs: 1,
  });

  constructor() {
    const project = track(mkdtempSync(join(tmpdir(), "senastr-agent-proj-")));
    const session: Session = {
      id: "s1",
      title: "test",
      projectPath: project,
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
    const s = this.sessions.get(id)!;
    s.messages.push(...messages);
    s.updatedAt = Date.now();
    return null;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return BUILTIN_TOOLS;
  }

  async runTool(req: { sessionId: string; tool: string; args: Record<string, unknown> }): Promise<ToolResult> {
    this.toolLog.push({ tool: req.tool, args: req.args });
    return this.toolBehavior(req.tool, req.args);
  }
}

/** Scripted provider: one event script per model step. */
class ScriptedProvider implements Provider {
  constructor(private scripts: Array<ProviderEvent[]>) {}
  step = 0;
  lastParams: ProviderChatParams | undefined;
  async *streamChat(params: ProviderChatParams): AsyncIterable<ProviderEvent> {
    this.lastParams = params;
    const script = this.scripts[Math.min(this.step, this.scripts.length - 1)];
    this.step += 1;
    for (const evt of script) yield evt;
  }
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("AgentRuntime", () => {
  it("runs a plain conversational turn", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([
      [{ kind: "text", delta: "Hello " }, { kind: "text", delta: "there!" }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });

    const events = await collect(
      runtime.runTurn({ sessionId: "s1", userMessage: "hi", model: { kind: "openai", model: "test-model" } }),
    );
    const types = events.map((e: any) => e.type);
    expect(types[0]).toBe("turn/start");
    expect(types).toContain("assistant/delta");
    expect(types[types.length - 1]).toBe("turn/end");
    expect((events[events.length - 1] as any).stopReason).toBe("stop");

    const messages = host.sessions.get("s1")!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hello there!");
  });

  it("executes tool calls through the host and continues until the answer", async () => {
    const host = new FakeHost();
    host.toolBehavior = (tool) => ({ ok: true, output: `result of ${tool}`, durationMs: 2 });
    const provider = new ScriptedProvider([
      [
        { kind: "text", delta: "Let me look. " },
        { kind: "tool-call", id: "c1", name: "list_dir", arguments: { path: "." } },
        { kind: "done" },
      ],
      [
        { kind: "text", delta: "Done." },
        { kind: "done" },
      ],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });

    const events = (await collect(
      runtime.runTurn({ sessionId: "s1", userMessage: "what's in the project?", model: { kind: "openai", model: "m" } }),
    )) as any[];

    expect(host.toolLog).toEqual([{ tool: "list_dir", args: { path: "." } }]);
    const calls = events.filter((e) => e.type === "tool/call");
    const results = events.filter((e) => e.type === "tool/result");
    expect(calls).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].result.output).toBe("result of list_dir");
    expect(events[events.length - 1].stopReason).toBe("stop");

    const messages = host.sessions.get("s1")!.messages;
    // user, assistant(+toolCall), tool result, final assistant
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1].toolCalls).toHaveLength(1);
    expect(messages[2].toolCallId).toBe("c1");
    expect(messages[2].content).toBe("result of list_dir");
  });

  it("surfaces denied tools as ERROR tool messages the model can see", async () => {
    const host = new FakeHost();
    host.toolBehavior = () => ({ ok: false, error: "permission denied by user", durationMs: 1 });
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "c9", name: "write_file", arguments: { path: "a.txt", content: "x" } }, { kind: "done" }],
      [
        { kind: "text", delta: "Understood, I'll stop." },
        { kind: "done" },
      ],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(
      runtime.runTurn({ sessionId: "s1", userMessage: "write a.txt", model: { kind: "openai", model: "m" } }),
    );
    const toolMessage = host.sessions.get("s1")!.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe("ERROR: permission denied by user");
  });

  it("aborts mid-turn with stopReason=aborted", async () => {
    const host = new FakeHost();
    // A provider that only ends after a delay, so stop() lands mid-stream.
    const slowProvider: Provider = {
      async *streamChat() {
        yield { kind: "text", delta: "start" };
        await new Promise((r) => setTimeout(r, 120));
        yield { kind: "text", delta: "never" };
        yield { kind: "done" };
      },
    };
    const runtime = new AgentRuntime(host, { providerFactory: () => slowProvider });
    const gen = runtime.runTurn({ sessionId: "s1", userMessage: "hi", model: { kind: "openai", model: "m" } });
    const first = await gen.next();
    expect(first.value?.type).toBe("turn/start");
    const collecting = collect(gen);
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.stop("s1")).toBe(true);
    const events = (await collecting) as any[];
    expect(events[events.length - 1].stopReason).toBe("aborted");
  });

  it("enforces maxSteps as a safety valve", async () => {
    const host = new FakeHost();
    host.toolBehavior = () => ({ ok: true, output: "ok", durationMs: 1 });
    const provider = new ScriptedProvider([
      [{ kind: "tool-call", id: "loop", name: "list_dir", arguments: {} }, { kind: "done" }],
    ]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider, maxSteps: 3 });
    const events = (await collect(
      runtime.runTurn({ sessionId: "s1", userMessage: "loop forever", model: { kind: "openai", model: "m" } }),
    )) as any[];
    expect(events[events.length - 1].stopReason).toBe("max-steps");
    expect(host.toolLog).toHaveLength(3);
  });

  it("sends tools and system prompt to the provider", async () => {
    const host = new FakeHost();
    const provider = new ScriptedProvider([[{ kind: "done" }]]);
    const runtime = new AgentRuntime(host, { providerFactory: () => provider });
    await collect(
      runtime.runTurn({ sessionId: "s1", userMessage: "hi", model: { kind: "openai", model: "m" } }),
    );
    expect(provider.lastParams?.tools).toHaveLength(BUILTIN_TOOLS.length);
    expect(provider.lastParams?.system).toContain("senastr");
    expect(provider.lastParams?.system).toContain(host.sessions.get("s1")!.projectPath!);
    expect(provider.lastParams?.messages.at(-1)?.content).toBe("hi");
  });
});

describe("message mapping", () => {
  const transcript: ChatMessage[] = [
    { id: "u1", role: "user", content: "do the thing", createdAt: 1 },
    {
      id: "a1",
      role: "assistant",
      content: "working",
      createdAt: 2,
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }],
    },
    { id: "t1", role: "tool", content: "file body", createdAt: 3, toolCallId: "c1", toolName: "read_file" },
    { id: "a2", role: "assistant", content: "done", createdAt: 4 },
  ];

  it("openai mapping keeps tool messages as role=tool", () => {
    const out = toOpenAIMessages("sys", transcript) as any[];
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("c1");
    const withCalls = out.find((m) => m.tool_calls);
    expect(withCalls?.tool_calls[0].function.name).toBe("read_file");
    expect(JSON.parse(withCalls.tool_calls[0].function.arguments)).toEqual({ path: "x" });
  });

  it("anthropic mapping folds tool results into user messages", () => {
    const out = toAnthropicMessages(transcript);
    expect(out[0].role).toBe("user");
    const assistant = out.find((m) => m.role === "assistant")!;
    const content = assistant.content as any[];
    expect(content.find((b) => b.type === "tool_use")?.id).toBe("c1");
    // the tool result must be in a user message after the assistant
    const idx = out.indexOf(assistant);
    const userAfter = out.slice(idx + 1).find((m) => m.role === "user");
    expect(userAfter).toBeDefined();
    const blocks = userAfter!.content as any[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.find((b) => b.type === "tool_result")?.tool_use_id).toBe("c1");
  });
});
