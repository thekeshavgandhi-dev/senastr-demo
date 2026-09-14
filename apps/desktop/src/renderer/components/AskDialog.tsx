import { useMemo, useState } from "react";
import type { AskAnswers, AskRequest } from "@senastr/shared";
import { IconHelp, IconX } from "./icons";
import { Modal, cx } from "./ui";

/**
 * Renders a paused turn's ask_user request: up to 4 questions, each either
 * option chips (single/multi select) or a free-text field. Answers are
 * positional; a question can be skipped (null) — except the turn only
 * resumes once the user submits the whole form.
 */
export function AskDialog({
  request,
  sessionTitle,
  onSubmit,
}: {
  request: AskRequest;
  sessionTitle?: string;
  onSubmit: (requestId: string, answers: AskAnswers) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const answers: AskAnswers = useMemo(
    () =>
      request.questions.map((q) => {
        if (skipped[q.id]) return null;
        const extra = (custom[q.id] ?? "").trim();
        const base = picked[q.id] ?? [];
        const merged = extra ? [...base, extra] : base;
        if (!q.options?.length) return merged.length ? merged : null;
        return merged;
      }),
    [request.questions, picked, custom, skipped],
  );

  const toggleOption = (qid: string, option: string, multi: boolean) => {
    setSkipped((s) => ({ ...s, [qid]: false }));
    setPicked((p) => {
      const cur = p[qid] ?? [];
      if (multi) {
        return { ...p, [qid]: cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option] };
      }
      return { ...p, [qid]: cur.includes(option) ? [] : [option] };
    });
  };

  const submit = () => {
    if (submitting) return;
    setSubmitting(true);
    onSubmit(request.requestId, answers);
  };

  return (
    <Modal label="Question from the agent" onClose={() => undefined} className="ask-modal">
      <div className="perm-head">
        <span className="perm-icon ask">
          <IconHelp size={18} />
        </span>
        <div>
          <div className="perm-title">The agent needs your input</div>
          {sessionTitle ? <div className="perm-session">{sessionTitle}</div> : null}
        </div>
        <span className="perm-tool-chip">ask_user</span>
      </div>

      <div className="ask-list">
        {request.questions.map((q) => {
          const isSkipped = !!skipped[q.id];
          return (
            <fieldset key={q.id} className={cx("ask-q", isSkipped && "skipped")} aria-disabled={isSkipped}>
              <div className="ask-q-head">
                <div>
                  {q.header ? <legend className="ask-q-header">{q.header}</legend> : null}
                  <p className="ask-q-text">{q.question}</p>
                </div>
                <button
                  type="button"
                  className={cx("ask-skip", isSkipped && "active")}
                  title={isSkipped ? "Unskip question" : "Skip question"}
                  onClick={() => setSkipped((s) => ({ ...s, [q.id]: !s[q.id] }))}
                >
                  <IconX size={12} />
                  {isSkipped ? "Skipped" : "Skip"}
                </button>
              </div>
              {!isSkipped && q.options?.length ? (
                <div className="ask-options" role={q.multiSelect ? "group" : "radiogroup"}>
                  {q.options.map((opt) => {
                    const on = (picked[q.id] ?? []).includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        role={q.multiSelect ? "checkbox" : "radio"}
                        aria-checked={on}
                        className={cx("ask-opt", on && "active")}
                        onClick={() => toggleOption(q.id, opt, q.multiSelect === true)}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {!isSkipped && (
                <input
                  className="ask-custom"
                  value={custom[q.id] ?? ""}
                  placeholder={q.options?.length ? "Or type your own answer…" : "Type your answer…"}
                  aria-label={q.options?.length ? "Custom answer" : "Answer"}
                  onChange={(e) => setCustom((c) => ({ ...c, [q.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              )}
            </fieldset>
          );
        })}
      </div>

      <div className="perm-actions ask-actions">
        <span className="ask-hint">The turn is paused until you answer.</span>
        <button type="button" className="btn primary" disabled={submitting} onClick={submit}>
          {submitting ? "Sending…" : "Send answers"}
        </button>
      </div>
    </Modal>
  );
}
