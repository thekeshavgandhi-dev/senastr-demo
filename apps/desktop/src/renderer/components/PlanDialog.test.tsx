import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PlanProposal } from "@senastr/shared";
import { PlanDialog } from "./PlanDialog";

const proposal: PlanProposal = {
  sessionId: "sess-1",
  toolCallId: "call-1",
  summary: "Add a login form with validation.",
  steps: ["Create the form component", "Add validation", "Write tests"],
  risks: "Password rules may need product confirmation.",
  createdAt: Date.now(),
};

function renderDialog(overrides: Partial<Parameters<typeof PlanDialog>[0]> = {}) {
  const props = {
    proposal,
    sessionTitle: "Auth work",
    busy: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  return { ...render(<PlanDialog {...props} />), props };
}

describe("PlanDialog", () => {
  it("renders the summary, steps and risks", () => {
    renderDialog();
    expect(screen.getByText(proposal.summary)).toBeInTheDocument();
    expect(screen.getByText(/Create the form component/)).toBeInTheDocument();
    expect(screen.getByText(/Password rules/)).toBeInTheDocument();
  });

  it("approves and switches to implement", () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
    expect(props.onApprove).toHaveBeenCalledTimes(1);
  });

  it("dismisses from the review step", () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("request-changes mode reveals a feedback field and submits feedback", () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));

    const feedback = screen.getByPlaceholderText(/What should change/);
    expect(feedback).toBeInTheDocument();
    // The newly revealed field receives focus.
    expect(feedback).toHaveFocus();

    fireEvent.change(feedback, { target: { value: "Use SQLite instead." } });
    fireEvent.click(screen.getByRole("button", { name: /Send feedback & revise/ }));
    expect(props.onReject).toHaveBeenCalledWith("Use SQLite instead.");
  });

  it("returns to review mode with Back without submitting", () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Approve & implement" })).toBeInTheDocument();
    expect(props.onReject).not.toHaveBeenCalled();
  });
});
