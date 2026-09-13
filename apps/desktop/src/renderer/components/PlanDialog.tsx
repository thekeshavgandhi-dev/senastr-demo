import { useState } from "react";
import type { PlanProposal } from "@senastr/shared";
import { IconCheck, IconSparkles, IconX } from "./icons";
import { Modal, cx } from "./ui";

/**
 * Approval gate for plan mode: the turn ended with stopReason "plan" and the
 * proposal is shown here. Approve → build mode + implement; request changes
 * → stays in plan mode with the feedback as the next user message.
 */
export function PlanDialog({
  proposal,
  sessionTitle,
  busy,
  onApprove,
  onReject,
  onDismiss,
}: {
  proposal: PlanProposal;
  sessionTitle?: string;
  busy: boolean;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onDismiss: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [mode, setMode] = useState<"review" | "revise">("review");

  return (
    <Modal label="Plan ready for review" onClose={onDismiss} className="plan-modal" wide>
      <div className="perm-head">
        <span className="perm-icon plan">
          <IconSparkles size={18} />
        </span>
        <div>
          <div className="perm-title">Plan ready for review</div>
          {sessionTitle ? <div className="perm-session">{sessionTitle}</div> : null}
        </div>
        <span className="perm-tool-chip">submit_plan</span>
      </div>

      <p className="perm-summary plan-summary">{proposal.summary}</p>

      <ol className="plan-steps">
        {proposal.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>

      {proposal.risks ? (
        <div className="plan-risks">
          <strong>Risks & open questions</strong>
          <p>{proposal.risks}</p>
        </div>
      ) : null}

      {mode === "revise" && (
        <textarea
          className="plan-feedback"
          data-autofocus
          rows={3}
          value={feedback}
          placeholder="What should change? (e.g. “use SQLite instead of Postgres, and skip step 4”)"
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}

      <div className="perm-actions plan-actions">
        {mode === "review" ? (
          <>
            <button type="button" className="btn" onClick={onDismiss}>
              Later
            </button>
            <span className="plan-spacer" />
            <button type="button" className="btn" onClick={() => setMode("revise")}>
              <IconX size={13} />
              Request changes
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={onApprove}>
              <IconCheck size={13} />
              Approve & implement
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setMode("review")}>
              Back
            </button>
            <span className="plan-spacer" />
            <button
              type="button"
              className={cx("btn", "danger")}
              disabled={busy}
              onClick={() => onReject(feedback)}
            >
              Send feedback & revise
            </button>
          </>
        )}
      </div>
      <p className="plan-footnote">
        Approving switches this session back to build mode and starts implementation.
      </p>
    </Modal>
  );
}
