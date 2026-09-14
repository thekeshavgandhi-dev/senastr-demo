import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AskRequest } from "@senastr/shared";
import { AskDialog } from "./AskDialog";

const request: AskRequest = {
  requestId: "req-1",
  sessionId: "sess-1",
  toolCallId: "call-1",
  createdAt: Date.now(),
  questions: [
    { id: "q1", question: "Which language?", options: ["TypeScript", "Python"], multiSelect: false },
    { id: "q2", header: "Identity", question: "What is your name?" },
  ],
};

function renderDialog(onSubmit = vi.fn()) {
  return render(<AskDialog request={request} sessionTitle="Demo session" onSubmit={onSubmit} />);
}

describe("AskDialog", () => {
  it("renders every question with its options", () => {
    renderDialog();
    expect(screen.getByText("Which language?")).toBeInTheDocument();
    expect(screen.getByText("What is your name?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "TypeScript" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Python" })).toBeInTheDocument();
  });

  it("lets the user skip a question and then un-skip it", () => {
    renderDialog();
    const skipButtons = screen.getAllByRole("button", { name: "Skip" });
    // Two questions → two skip buttons.
    expect(skipButtons).toHaveLength(2);

    fireEvent.click(skipButtons[0]);
    // Options for q1 disappear and the button reads "Skipped".
    expect(screen.queryByRole("radio", { name: "TypeScript" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skipped" })).toBeInTheDocument();

    // The skip control must stay clickable so the user can un-skip.
    fireEvent.click(screen.getByRole("button", { name: "Skipped" }));
    expect(screen.getByRole("radio", { name: "TypeScript" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skipped" })).not.toBeInTheDocument();
  });

  it("submits the chosen option and the free-text answer positionally", () => {
    const onSubmit = vi.fn();
    renderDialog(onSubmit);

    fireEvent.click(screen.getByRole("radio", { name: "TypeScript" }));
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));

    expect(onSubmit).toHaveBeenCalledWith("req-1", [["TypeScript"], ["Ada"]]);
  });

  it("reports skipped questions as null in the submitted answers", () => {
    const onSubmit = vi.fn();
    renderDialog(onSubmit);

    fireEvent.click(screen.getByRole("radio", { name: "Python" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Skip" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));

    expect(onSubmit).toHaveBeenCalledWith("req-1", [["Python"], null]);
  });

  it("submits when Enter is pressed in a text field", () => {
    const onSubmit = vi.fn();
    renderDialog(onSubmit);

    fireEvent.click(screen.getByRole("radio", { name: "TypeScript" }));
    const nameInput = screen.getByLabelText("Answer");
    fireEvent.change(nameInput, { target: { value: "Grace" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("req-1", [["TypeScript"], ["Grace"]]);
  });
});
