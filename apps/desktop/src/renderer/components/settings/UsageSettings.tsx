import { useEffect, useMemo, useState } from "react";
import type { SenastrStore } from "../../hooks/useSenastr";
import { translator } from "../../lib/i18n";
import { Field } from "./SettingsPrimitives";
import { cx } from "../ui";

type Bucket = "day" | "week" | "month";

/**
 * Token usage history (parity: pi-desktop's stats page backed by
 * `stats/getTokenUsageHistory`). The host records one row per completed turn.
 */
export function UsageSettings({ store }: { store: SenastrStore }) {
  const t = translator(store.language);
  const [bucket, setBucket] = useState<Bucket>("day");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void store.refreshUsage({ bucket }).finally(() => setLoading(false));
  }, [bucket]); // eslint-disable-line react-hooks/exhaustive-deps

  const history = store.usageHistory;
  const max = useMemo(
    () => Math.max(1, ...(history?.buckets ?? []).map((row) => row.inputTokens + row.outputTokens)),
    [history],
  );
  const rows = useMemo(() => (history?.buckets ?? []).slice(-30), [history]);
  const last7 = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return (history?.buckets ?? []).filter((row) => {
      const parsed = row.bucket.includes("-W")
        ? Date.parse(`${row.bucket.slice(0, 4)}-01-04`)
        : row.bucket.length === 7
          ? Date.parse(`${row.bucket}-01`)
          : Date.parse(row.bucket);
      return Number.isFinite(parsed) ? parsed >= cutoff : true;
    });
  }, [history]);

  const weekTotals = last7.reduce(
    (acc, row) => ({
      input: acc.input + row.inputTokens,
      output: acc.output + row.outputTokens,
      turns: acc.turns + row.turns,
    }),
    { input: 0, output: 0, turns: 0 },
  );

  return (
    <div className="settings-page">
      <Field label={t("usage.title")} hint="Recorded by the host for every completed turn. Local only.">
        <div className="usage-cards">
          <div className="usage-card">
            <span>{t("usage.today")}</span>
            <strong>{(history?.totals.inputTokens ?? 0).toLocaleString()}</strong>
            <small>input tokens · last 30 days</small>
          </div>
          <div className="usage-card">
            <span>Output tokens</span>
            <strong>{(history?.totals.outputTokens ?? 0).toLocaleString()}</strong>
            <small>generated tokens</small>
          </div>
          <div className="usage-card">
            <span>{t("usage.turns")}</span>
            <strong>{(history?.totals.turns ?? 0).toLocaleString()}</strong>
            <small>{weekTotals.turns} in the last 7 buckets</small>
          </div>
        </div>
      </Field>

      <Field label="Bucket" hint="Day, ISO week or calendar month.">
        <div className="settings-segments" role="radiogroup" aria-label="Usage bucket">
          {(["day", "week", "month"] as Bucket[]).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={bucket === option}
              className={cx(bucket === option && "active")}
              onClick={() => setBucket(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </Field>

      <Field label="History" hint={loading ? "Loading…" : `${rows.length} buckets`}>
        {rows.length === 0 ? (
          <div className="usage-empty">{t("usage.empty")}</div>
        ) : (
          <div className="usage-chart" role="img" aria-label="Token usage per bucket">
            {rows.map((row) => {
              const total = row.inputTokens + row.outputTokens;
              return (
                <div className="usage-bar-wrap" key={row.bucket} title={`${row.bucket}: ${total.toLocaleString()} tokens · ${row.turns} turns`}>
                  <div className="usage-bar" style={{ height: `${Math.max(3, (total / max) * 100)}%` }}>
                    <span className="usage-bar-input" style={{ flexGrow: row.inputTokens || 1 }} />
                    <span className="usage-bar-output" style={{ flexGrow: row.outputTokens || 1 }} />
                  </div>
                  <span className="usage-bar-label">{row.bucket.slice(-5)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Field>
    </div>
  );
}
