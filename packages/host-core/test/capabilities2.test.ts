import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeNextRun, nextCronRun, parseCron } from "../src/index";
import { InstructionService } from "../src/index";
import { ReviewStore } from "../src/index";
import { ScheduledService } from "../src/index";
import { SubagentService } from "../src/index";

const tmpDirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("cron", () => {
  it("parses 5-field expressions and rejects junk", () => {
    expect(parseCron("0 9 * * *")).toBeTruthy();
    expect(parseCron("*/15 9-17 * * 1-5")).toBeTruthy();
    expect(() => parseCron("0 9 * *")).toThrow();
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * * *")).toThrow();
  });

  it("finds the next run after a fixed instant", () => {
    // Monday 2026-01-05 08:00 UTC.
    const from = Date.UTC(2026, 0, 5, 8, 0, 0);
    const next = nextCronRun("30 9 * * *", from);
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 30, 0));
    // Same-day slot already passed → tomorrow.
    const late = nextCronRun("30 9 * * *", Date.UTC(2026, 0, 5, 10, 0, 0));
    expect(late).toBe(Date.UTC(2026, 0, 6, 9, 30, 0));
  });

  it("supports weekday restriction", () => {
    // Monday 2026-01-05 10:00 UTC; weekdays at 09:00 already passed today.
    const next = nextCronRun("0 9 * * 1-5", Date.UTC(2026, 0, 5, 10, 0, 0));
    expect(next).toBe(Date.UTC(2026, 0, 6, 9, 0, 0)); // Tuesday
  });

  it("returns null for impossible dates", () => {
    expect(nextCronRun("0 0 30 2 *", Date.UTC(2026, 0, 1))).toBeUndefined();
  });
});

describe("ScheduledService", () => {
  const base = {
    title: "nightly",
    prompt: "run tests",
    projectPath: temp("senastr-sched-proj-"),
    providerId: "p",
    model: "m",
  };

  it("computes nextRunAt per cadence", () => {
    const svc = new ScheduledService(temp("senastr-sched-"));
    const hourly = svc.set({ ...base, cadence: "hourly" });
    const daily = svc.set({ ...base, title: "d", cadence: "daily" });
    const manual = svc.set({ ...base, title: "manual", cadence: "manual" });
    const now = Date.now();
    expect(hourly.nextRunAt).toBeGreaterThan(now);
    expect(hourly.nextRunAt!).toBeLessThanOrEqual(now + 3_600_000);
    expect(daily.nextRunAt).toBeGreaterThan(now);
    expect(daily.nextRunAt!).toBeLessThanOrEqual(now + 24 * 3_600_000);
    expect(manual.nextRunAt).toBeUndefined();
    expect(computeNextRun({ ...manual, cadence: "cron", cron: "0 9 * * *" }, now)).toBeGreaterThan(now);
  });

  it("claim pins the session and recordRun advances the schedule", () => {
    const svc = new ScheduledService(temp("senastr-sched-"));
    const task = svc.set({ ...base, cadence: "hourly" });
    const claimed = svc.claim(task.id, "sess-1");
    expect(claimed.sessionId).toBe("sess-1");
    expect(claimed.nextRunAt).toBeGreaterThan(Date.now());
    const run = svc.recordRun({
      taskId: task.id,
      sessionId: "sess-1",
      status: "done",
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      summary: "ok",
    });
    expect(run.id).toBeTruthy();
    expect(svc.runsFor(task.id)).toHaveLength(1);
    const after = svc.list().find((t) => t.id === task.id)!;
    expect(after.lastStatus).toBe("done");
    expect(after.lastRunAt).toBeTypeOf("number");
  });

  it("disabling clears nextRunAt; delete drops tasks and runs", () => {
    const svc = new ScheduledService(temp("senastr-sched-"));
    const task = svc.set({ ...base, cadence: "hourly" });
    expect(svc.setEnabled(task.id, false).nextRunAt).toBeUndefined();
    expect(svc.setEnabled(task.id, true).nextRunAt).toBeGreaterThan(Date.now());
    svc.recordRun({ taskId: task.id, status: "done", startedAt: Date.now() });
    expect(svc.runsFor(task.id)).toHaveLength(1);
    svc.delete(task.id);
    expect(svc.list()).toHaveLength(0);
    expect(svc.runsFor(task.id)).toHaveLength(0);
  });
});

describe("SubagentService", () => {
  it("scopes global vs project records and filters active", () => {
    const svc = new SubagentService(temp("senastr-sub-"));
    const project = temp("senastr-sub-proj-");
    svc.set({ name: "explorer", systemPrompt: "explore", level: "global" });
    svc.set({ name: "local", systemPrompt: "x", level: "project", projectPath: project });
    expect(svc.list()).toHaveLength(1); // project records need their scope
    expect(svc.list({ projectPath: project })).toHaveLength(2);
    expect(svc.list({ level: "global" })).toHaveLength(1);
    expect(svc.active(project)).toHaveLength(2);
    expect(svc.active(temp("senastr-other-"))).toHaveLength(1);
    const [g] = svc.list({ level: "global" });
    svc.setEnabled(g.id, false, { level: "global" });
    expect(svc.active(project)).toHaveLength(1);
    svc.delete(g.id, { level: "global" });
    expect(svc.list({ projectPath: project })).toHaveLength(1);
  });
});

describe("InstructionService", () => {
  it("stores global and per-project layers independently", () => {
    const svc = new InstructionService(temp("senastr-instr-"));
    const project = temp("senastr-instr-proj-");
    expect(svc.get(null)).toMatchObject({ instructions: "", memory: "" });
    svc.set(null, "global rules", "global facts");
    svc.set(project, "project rules", "");
    expect(svc.get(null).instructions).toBe("global rules");
    expect(svc.get(project).instructions).toBe("project rules");
    expect(svc.get(project).memory).toBe("");
    expect(svc.get(temp("senastr-other-")).instructions).toBe("");
    expect(() => svc.set(null, "x".repeat(65_000), "")).toThrow();
  });
});

describe("ReviewStore", () => {
  it("appends, lists, gets latest and purges per session", () => {
    const store = new ReviewStore(join(temp("senastr-review-"), "review"));
    const first = store.append("s1", "a.txt", null, "hello");
    store.append("s1", "a.txt", "hello", "hello world");
    expect(store.list("s1")).toHaveLength(2);
    expect(store.list("other")).toHaveLength(0);
    expect(store.get("s1", first.id).after).toBe("hello");
    expect(() => store.get("s1", "missing")).toThrow();
    expect(store.latestForPath("s1", "a.txt")?.after).toBe("hello world");
    store.purge("s1");
    expect(store.list("s1")).toHaveLength(0);
  });

  it("caps huge snapshots and marks them truncated", () => {
    const store = new ReviewStore(join(temp("senastr-review-"), "review"));
    const big = "z".repeat(250_000);
    const snap = store.append("s9", "big.txt", null, big);
    expect(snap.truncated).toBe(true);
    expect(snap.after.length).toBeLessThanOrEqual(200_000);
  });
});
