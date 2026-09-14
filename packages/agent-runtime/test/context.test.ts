import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@senastr/shared";
import { MAX_MESSAGE_CHARS, compactHistory } from "../src/context";

let seq = 0;
function msg(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return { id: `m${seq}`, role, content, createdAt: seq, ...extra };
}

describe("compactHistory", () => {
  it("passes a short transcript through untouched", () => {
    const history = [msg("user", "hello"), msg("assistant", "hi"), msg("user", "again")];
    const result = compactHistory(history, 10_000);
    expect(result.dropped).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.messages).toEqual(history);
  });

  it("keeps the task anchor and the newest turns, dropping the middle", () => {
    const history = [msg("user", "TASK ANCHOR"), ...Array.from({ length: 40 }, (_, i) => msg("user", `turn ${i} ${"x".repeat(200)}`))];
    const result = compactHistory(history, 2_000);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages[0].content).toBe("TASK ANCHOR");
    expect(result.messages[1].content).toContain("context checkpoint");
    expect(result.messages.at(-1)?.content).toContain("turn 39");
  });

  it("never starts the window with an orphan tool result", () => {
    const history = [
      msg("user", "task"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] }),
      msg("tool", "file body 1".repeat(100), { toolCallId: "c1", toolName: "read_file" }),
      msg("assistant", "analysis"),
      msg("user", "next"),
      msg("assistant", "", { toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "b" } }] }),
      msg("tool", "file body 2".repeat(100), { toolCallId: "c2", toolName: "read_file" }),
    ];
    const result = compactHistory(history, 600);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(false);
    expect(result.messages.filter((m) => m.role === "tool").every((m) => m.toolCallId === "c2")).toBe(true);
  });

  it("never ends on an assistant turn whose tool results were dropped", () => {
    const history = [
      msg("user", "task"),
      msg("assistant", "", { toolCalls: [{ id: "c9", name: "grep", arguments: { pattern: "x" } }] }),
      msg("user", "more"),
    ];
    const result = compactHistory(history, 400);
    const last = result.messages.at(-1);
    expect(last?.role === "assistant" && (last.toolCalls?.length ?? 0) > 0).toBe(false);
  });

  it("trims one oversized tool dump instead of evicting the conversation", () => {
    const history = [
      msg("user", "task"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "cat big" } }] }),
      msg("tool", "y".repeat(MAX_MESSAGE_CHARS * 2), { toolCallId: "c1" }),
    ];
    const result = compactHistory(history, 50_000);
    expect(result.truncated).toBe(true);
    expect(result.dropped).toBe(0);
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage!.content.length).toBeLessThan(MAX_MESSAGE_CHARS + 200);
    expect(toolMessage!.content).toContain("trimmed");
  });

  it("handles empty transcripts", () => {
    expect(compactHistory([]).messages).toEqual([]);
  });

  it("keeps growing sessions under the budget", () => {
    const history: ChatMessage[] = [msg("user", "task")];
    for (let i = 0; i < 500; i++) {
      history.push(msg("assistant", `step ${i} ${"z".repeat(300)}`));
      history.push(msg("user", `reply ${i}`));
    }
    const budget = 20_000;
    const result = compactHistory(history, budget);
    const size = result.messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(size).toBeLessThanOrEqual(budget + MAX_MESSAGE_CHARS);
    expect(result.dropped).toBeGreaterThan(400);
  });
});
