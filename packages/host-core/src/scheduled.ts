import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ErrorCodes,
  RpcError,
  type ScheduleCadence,
  type ScheduledRun,
  type ScheduledRunStatus,
  type ScheduledTask,
  type ScheduledTaskInput,
} from "@senastr/shared";
import { JsonFileStore } from "./store";

const MAX_RUNS_PER_TASK = 20;
const CADENCES: ScheduleCadence[] = ["manual", "hourly", "daily", "weekly", "cron"];

/**
 * Scheduled headless agent runs. Storage + schedule math live here; the
 * Electron main process owns the ticker that fires due tasks (it owns the
 * agent runtime), then records runs back through this service.
 */
export class ScheduledService {
  private readonly tasks: JsonFileStore<ScheduledTask[]>;
  private readonly runs: JsonFileStore<ScheduledRun[]>;

  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await Promise.all([this.tasks.flush(), this.runs.flush()]);
  }

  constructor(dataDir: string) {
    this.tasks = new JsonFileStore<ScheduledTask[]>(`${dataDir}/scheduled-tasks.json`, []);
    this.runs = new JsonFileStore<ScheduledRun[]>(`${dataDir}/scheduled-runs.json`, []);
  }

  list(): ScheduledTask[] {
    return this.tasks
      .get()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({ ...t }));
  }

  set(input: ScheduledTaskInput): ScheduledTask {
    const title = requireText(input.title, "task.title");
    const prompt = requireText(input.prompt, "task.prompt");
    if (!input.projectPath || typeof input.projectPath !== "string") {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "task.projectPath is required");
    }
    if (typeof input.providerId !== "string" || !input.providerId) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "task.providerId is required");
    }
    if (typeof input.model !== "string" || !input.model) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "task.model is required");
    }
    const cadence: ScheduleCadence = CADENCES.includes(input.cadence as ScheduleCadence)
      ? (input.cadence as ScheduleCadence)
      : "manual";
    let cron: string | undefined;
    if (cadence === "cron") {
      cron = requireText(input.cron, "task.cron");
      assertValidCron(cron);
    }
    const id = input.id?.trim() || randomUUID();
    const now = Date.now();
    const existing = this.tasks.get().find((t) => t.id === id);
    const record: ScheduledTask = {
      id,
      title,
      prompt,
      projectPath: resolve(input.projectPath),
      providerId: input.providerId,
      model: input.model,
      cadence,
      cron,
      enabled: input.enabled ?? existing?.enabled ?? true,
      sessionId: existing?.sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: existing?.lastRunAt,
      lastStatus: existing?.lastStatus,
      nextRunAt: undefined,
    };
    record.nextRunAt = record.enabled ? computeNextRun(record, now) : undefined;
    this.tasks.update((all) => {
      const found = all.findIndex((t) => t.id === id);
      if (found < 0) return [...all, record];
      const next = [...all];
      next[found] = record;
      return next;
    });
    return { ...record };
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask {
    const found = this.tasks.get().find((t) => t.id === id);
    if (!found) throw new RpcError(ErrorCodes.HOST_ERROR, `scheduled task not found: ${id}`);
    const next: ScheduledTask = {
      ...found,
      enabled,
      updatedAt: Date.now(),
      nextRunAt: enabled ? computeNextRun(found, Date.now()) : undefined,
    };
    this.tasks.update((all) => all.map((t) => (t.id === id ? next : t)));
    return { ...next };
  }

  delete(id: string): void {
    this.tasks.update((all) => all.filter((t) => t.id !== id));
    this.runs.update((all) => all.filter((r) => r.taskId !== id));
  }

  /** Main process claims a task before running it (prevents double-fire). */
  claim(id: string, sessionId: string): ScheduledTask {
    const found = this.tasks.get().find((t) => t.id === id);
    if (!found) throw new RpcError(ErrorCodes.HOST_ERROR, `scheduled task not found: ${id}`);
    const next: ScheduledTask = {
      ...found,
      sessionId,
      updatedAt: Date.now(),
      // Push the next slot past now so a concurrent ticker skips it.
      nextRunAt: computeNextRun(found, Date.now() + 60_000),
    };
    this.tasks.update((all) => all.map((t) => (t.id === id ? next : t)));
    return { ...next };
  }

  /** Record a finished run and advance the task's schedule. */
  recordRun(run: Omit<ScheduledRun, "id"> & { id?: string }): ScheduledRun {
    const full: ScheduledRun = { ...run, id: run.id || randomUUID() };
    this.runs.update((all) => {
      // Keep the most recent MAX_RUNS_PER_TASK runs *per task* — history for
      // one task must never evict another task's runs.
      const sameTask = all.filter((r) => r.taskId === full.taskId);
      const others = all.filter((r) => r.taskId !== full.taskId);
      const kept = [...sameTask, full].slice(-MAX_RUNS_PER_TASK);
      return [...others, ...kept];
    });
    const task = this.tasks.get().find((t) => t.id === full.taskId);
    if (task) {
      const now = Date.now();
      const next: ScheduledTask = {
        ...task,
        sessionId: full.sessionId ?? task.sessionId,
        updatedAt: now,
        lastRunAt: full.startedAt,
        lastStatus: full.status,
        nextRunAt: task.enabled ? computeNextRun(task, now) : undefined,
      };
      this.tasks.update((all) => all.map((t) => (t.id === task.id ? next : t)));
    }
    return { ...full };
  }

  runsFor(taskId: string): ScheduledRun[] {
    return this.runs
      .get()
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({ ...r }));
  }
}

/* ------------------------------------------------------------------ */
/* schedule math                                                       */
/* ------------------------------------------------------------------ */

export function computeNextRun(task: Pick<ScheduledTask, "cadence" | "cron">, fromMs: number): number | undefined {
  switch (task.cadence) {
    case "manual":
      return undefined;
    case "hourly": {
      const next = new Date(fromMs);
      next.setSeconds(0, 0);
      next.setMinutes(0);
      next.setHours(next.getHours() + 1);
      return next.getTime();
    }
    case "daily": {
      const next = new Date(fromMs + 24 * 3_600_000);
      next.setSeconds(0, 0);
      return next.getTime();
    }
    case "weekly": {
      const next = new Date(fromMs + 7 * 24 * 3_600_000);
      next.setSeconds(0, 0);
      return next.getTime();
    }
    case "cron": {
      if (!task.cron) return undefined;
      return nextCronRun(task.cron, fromMs);
    }
  }
}

interface CronField {
  values: Set<number>;
}

function parseCronField(raw: string, min: number, max: number, label: string): CronField {
  const values = new Set<number>();
  const add = (v: number) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid cron ${label}: ${raw}`);
    }
    values.add(v);
  };
  for (const part of raw.split(",")) {
    const stepSplit = part.split("/");
    if (stepSplit.length > 2 || (stepSplit.length === 2 && !/^\d+$/.test(stepSplit[1]))) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid cron ${label}: ${raw}`);
    }
    const step = stepSplit.length === 2 ? Number.parseInt(stepSplit[1], 10) : 1;
    if (step < 1) throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid cron ${label}: ${raw}`);
    const range = stepSplit[0];
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const dash = range.split("-");
      if (dash.length > 2 || !dash.every((d) => /^\d+$/.test(d))) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid cron ${label}: ${raw}`);
      }
      lo = Number.parseInt(dash[0], 10);
      hi = dash.length === 2 ? Number.parseInt(dash[1], 10) : lo;
    }
    for (let v = lo; v <= hi; v += step) add(v);
  }
  return { values };
}

export function parseCron(expr: string): CronField[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "cron must have 5 fields: minute hour day month weekday");
  }
  const [minute, hour, dom, month, dow] = parts;
  return [
    parseCronField(minute, 0, 59, "minute"),
    parseCronField(hour, 0, 23, "hour"),
    parseCronField(dom, 1, 31, "day"),
    parseCronField(month, 1, 12, "month"),
    // Sunday = 0 (7 is also accepted and normalized).
    parseCronField(dow.replace(/\b7\b/g, "0"), 0, 6, "weekday"),
  ];
}

export function assertValidCron(expr: string): void {
  parseCron(expr);
}

/** Next matching minute strictly after `fromMs` (local time), or undefined. */
export function nextCronRun(expr: string, fromMs: number): number | undefined {
  const [minute, hour, dom, month, dow] = parseCron(expr);
  const cursor = new Date(fromMs);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  // Scan at most ~366 days out; a valid expression always matches sooner
  // unless it names an impossible date (e.g. Feb 30), in which case there
  // is genuinely no upcoming run.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const matchesDom = dom.values.has(cursor.getDate());
    const matchesDow = dow.values.has(cursor.getDay());
    if (
      minute.values.has(cursor.getMinutes()) &&
      hour.values.has(cursor.getHours()) &&
      month.values.has(cursor.getMonth() + 1) &&
      // Standard cron: day-of-month and day-of-week are OR-ed when both
      // are restricted, otherwise the restricted one (or either) applies.
      (dom.values.size === 31 || dow.values.size === 7
        ? matchesDom && matchesDow
        : matchesDom || matchesDow)
    ) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return undefined;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${label} is required`);
  }
  return value.trim();
}

export type { ScheduledRunStatus };
