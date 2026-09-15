import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, type ChatMessage, type SkillRecord, type TodoItem } from "@senastr/shared";
import {
  BASE_PROTOCOL,
  DELEGATION_REPORT_CONTRACT,
  PLAN_MODE_BLOCK,
  composeSystemPrompt,
  defaultSystemPrompt,
  renderAlwaysSkills,
  renderSkillManifests,
  renderTodos,
  renderWarnings,
} from "../src/index";
import { SUMMARIZE_SYSTEM, renderTranscriptForSummary } from "../src/index";

const skill = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: "s1",
  name: "Skill One",
  description: "Use for one thing",
  content: "BODY",
  enabled: true,
  level: "global",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("renderSkillManifests", () => {
  it("is empty for no skills", () => {
    expect(renderSkillManifests([])).toBe("");
  });

  it("lists id, name and a bounded description", () => {
    const out = renderSkillManifests([skill({ description: "x".repeat(500) })]);
    const line = out.split("\n")[1];
    expect(line).toMatch(/^- s1 \S Skill One/);
    expect(line).toMatch(/Skill One(?: \[[^\]]+\])?: /);
    expect(line).toContain("x".repeat(170));
    expect(line).not.toContain("x".repeat(200));
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(240);
  });

  it("tags non-builtin skills with their origin", () => {
    expect(renderSkillManifests([skill({ source: "project-file" })])).toContain("[project-file]");
    expect(renderSkillManifests([skill({ source: "builtin" })])).not.toContain("[builtin]");
  });

  it("tells the model how to load a body", () => {
    expect(renderSkillManifests([skill()])).toMatch(/use_skill/);
  });
});

describe("renderAlwaysSkills", () => {
  it("inlines only skills marked always", () => {
    const out = renderAlwaysSkills([skill({ always: true, content: "ALWAYS-BODY" }), skill({ id: "s2", content: "NOPE" })]);
    expect(out).toContain("ALWAYS-BODY");
    expect(out).not.toContain("NOPE");
    expect(out).toContain('<always-on-skill id="s1"');
  });

  it("returns empty when nothing is pinned", () => {
    expect(renderAlwaysSkills([skill()])).toBe("");
  });
});

describe("renderTodos / renderWarnings", () => {
  it("renders progress and per-item marks", () => {
    const todos: TodoItem[] = [
      { id: "t1", content: "first", status: "completed" },
      { id: "t2", content: "second", status: "in_progress" },
      { id: "t3", content: "third", status: "pending" },
    ];
    const out = renderTodos(todos);
    expect(out).toContain("Progress: 1/3 completed");
    expect(out).toContain("- [x] t1 first");
    expect(out).toContain("- [>] t2 second");
    expect(out).toContain("- [ ] t3 third");
  });

  it("renders warnings as a delimited block", () => {
    const out = renderWarnings(["careful", "  ", "budget"]);
    expect(out).toBe("<runtime-warnings>\n- careful\n- budget\n</runtime-warnings>");
    expect(renderWarnings([])).toBe("");
  });
});

describe("composeSystemPrompt", () => {
  it("uses the default base when none is given", () => {
    expect(composeSystemPrompt({ projectPath: "/p" })).toContain(BASE_PROTOCOL.split("\n")[2]);
  });

  it("puts the delegation contract in place of the plan-mode rules", () => {
    const delegation = composeSystemPrompt({ projectPath: "/p", delegation: { description: "audit" } });
    expect(delegation).toContain(DELEGATION_REPORT_CONTRACT);
    expect(delegation).not.toContain(PLAN_MODE_BLOCK);

    const plan = composeSystemPrompt({ projectPath: "/p", planMode: true });
    expect(plan).toContain(PLAN_MODE_BLOCK);
    expect(plan).not.toContain(DELEGATION_REPORT_CONTRACT);
  });

  it("hands the subagent its assignment and context", () => {
    const out = composeSystemPrompt({
      projectPath: "/p",
      delegation: { description: "audit auth", context: "SECRET-CONTEXT", readOnly: true },
    });
    expect(out).toContain("Your assignment: audit auth");
    expect(out).toContain("SECRET-CONTEXT");
    expect(out).toContain("READ-ONLY RUN");
  });
});

describe("defaultSystemPrompt", () => {
  it("names the project and states the operating protocol", () => {
    const out = defaultSystemPrompt("/home/me/proj");
    expect(out).toContain("/home/me/proj");
    expect(out).toContain("verify");
    expect(out).toContain("todo_write");
    expect(out).toContain("memory");
  });
});

describe("bundled skill library", () => {
  it("every skill has a description that says when to use it", () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.description?.trim().length ?? 0).toBeGreaterThan(40);
      expect(s.content.trim().length).toBeGreaterThan(200);
    }
  });

  it("has unique ids", () => {
    expect(new Set(BUILTIN_SKILLS.map((s) => s.id)).size).toBe(BUILTIN_SKILLS.length);
  });

  it("covers the capabilities the protocol promises", () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    for (const required of [
      "task-decomposition",
      "verification-loop",
      "systematic-debugging",
      "multi-agent-orchestration",
      "context-economy",
      "memory-discipline",
      "refactoring-playbook",
      "security-audit",
    ]) {
      expect(ids).toContain(required);
    }
  });
});

describe("renderTranscriptForSummary", () => {
  it("labels roles and records tool calls", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "user", content: "fix the parser", createdAt: 1 },
      {
        id: "2",
        role: "assistant",
        content: "looking",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.ts" } }],
        createdAt: 2,
      },
      { id: "3", role: "tool", content: "file body", toolCallId: "c1", toolName: "read_file", createdAt: 3 },
    ];
    const out = renderTranscriptForSummary(messages);
    expect(out).toContain("user: fix the parser");
    expect(out).toContain('assistant called read_file({"path":"a.ts"})');
    expect(out).toContain("tool:read_file: file body");
    expect(out).toContain("Summarise the transcript above.");
  });

  it("stays inside the character budget while keeping the head and tail", () => {
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      role: i === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${i} `.repeat(400),
      createdAt: i,
    }));
    const out = renderTranscriptForSummary(messages, 4_000);
    expect(out.length).toBeLessThan(6_000);
    expect(out).toContain("message 0");
    expect(out).toContain("message 59");
    expect(out).toContain("elided");
  });

  it("returns nothing for an empty transcript", () => {
    expect(renderTranscriptForSummary([])).toBe("");
  });

  it("tells the summariser what the output is for", () => {
    expect(SUMMARIZE_SYSTEM).toMatch(/Files touched/);
    expect(SUMMARIZE_SYSTEM).toMatch(/Under 500 words/);
    expect(SUMMARIZE_SYSTEM).toMatch(/exact identifiers/);
  });
});
