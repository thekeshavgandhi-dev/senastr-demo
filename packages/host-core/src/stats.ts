import { randomUUID } from "node:crypto";
import type { TokenUsageBucket, TokenUsageHistory, UsageRecord } from "@senastr/shared";
import { JsonFileStore } from "./store";

interface UsageState {
  records: UsageRecord[];
}

const MAX_RECORDS = 20_000;

/**
 * Token usage history (parity: pi-desktop `stats/getTokenUsageHistory`).
 *
 * The agent runtime records one row per completed turn; the UI aggregates it
 * into day/week/month buckets. Records are capped so the file cannot grow
 * without bound: the oldest rows fall off first.
 */
export class StatsService {
  private readonly store: JsonFileStore<UsageState>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore<UsageState>(`${dataDir}/usage.json`, { records: [] });
    this.store.update((state) => ({
      records: Array.isArray(state?.records) ? state.records.filter(isRecord) : [],
    }));
  }

  record(input: {
    id?: string;
    sessionId: string;
    at?: number;
    providerId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    stopReason?: UsageRecord["stopReason"];
  }): UsageRecord {
    const record: UsageRecord = {
      id: input.id ?? randomUUID(),
      sessionId: String(input.sessionId ?? ""),
      at: typeof input.at === "number" ? input.at : Date.now(),
      providerId: input.providerId,
      model: input.model,
      inputTokens: numberOrZero(input.inputTokens),
      outputTokens: numberOrZero(input.outputTokens),
      stopReason: input.stopReason,
    };
    this.store.update((state) => {
      const records = [...state.records, record];
      return { records: records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records };
    });
    return record;
  }

  history(query: { startDate?: number; endDate?: number; bucket?: "day" | "week" | "month"; sessionId?: string } = {}): TokenUsageHistory {
    const bucketKind = query.bucket === "week" || query.bucket === "month" ? query.bucket : "day";
    const start = typeof query.startDate === "number" ? query.startDate : Date.now() - 30 * 24 * 60 * 60 * 1000;
    const end = typeof query.endDate === "number" ? query.endDate : Date.now() + 60_000;
    const buckets = new Map<string, TokenUsageBucket>();
    const totals = { inputTokens: 0, outputTokens: 0, turns: 0 };
    for (const record of this.store.get().records) {
      if (record.at < start || record.at > end) continue;
      if (query.sessionId && record.sessionId !== query.sessionId) continue;
      const key = bucketKey(record.at, bucketKind);
      const bucket = buckets.get(key) ?? { bucket: key, inputTokens: 0, outputTokens: 0, turns: 0 };
      bucket.inputTokens += record.inputTokens;
      bucket.outputTokens += record.outputTokens;
      bucket.turns += 1;
      buckets.set(key, bucket);
      totals.inputTokens += record.inputTokens;
      totals.outputTokens += record.outputTokens;
      totals.turns += 1;
    }
    return {
      buckets: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
      totals,
    };
  }

  /** Records for one session, newest first (session detail view). */
  forSession(sessionId: string, limit = 100): UsageRecord[] {
    return this.store
      .get()
      .records.filter((r) => r.sessionId === sessionId)
      .slice(-Math.max(1, Math.min(limit, 1000)))
      .reverse();
  }

  /** Drop every record belonging to a deleted session. */
  purgeSession(sessionId: string): number {
    let removed = 0;
    this.store.update((state) => {
      const records = state.records.filter((r) => {
        if (r.sessionId === sessionId) {
          removed += 1;
          return false;
        }
        return true;
      });
      return { records };
    });
    return removed;
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}

function bucketKey(at: number, kind: "day" | "week" | "month"): string {
  const date = new Date(at);
  if (kind === "month") return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  if (kind === "week") {
    // ISO week: Thursday-anchored.
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNumber = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNumber + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week =
      1 +
      Math.round(
        ((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
      );
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function isRecord(value: unknown): value is UsageRecord {
  return Boolean(value) && typeof (value as UsageRecord).sessionId === "string" && typeof (value as UsageRecord).at === "number";
}
