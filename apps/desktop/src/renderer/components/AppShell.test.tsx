/**
 * Testing-team suite: renders the entire app against a faithful in-memory
 * backend and exercises the chat shell end to end — composer, transcript,
 * sidebar, topbar, search, work panel, and every dialog. Any button that
 * fails to reach the backend (or crashes) fails here.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  FakeBackend,
  nextId,
} from "../test/fake-backend";
import {
  PROJECT,
  assistantMsg,
  clearLocalStorage,
  renderApp,
  seedProvider,
  seedSession,
  stubClipboard,
  userMsg,
} from "../test/app-harness";

/** Sidebar-scoped queries — the topbar repeats the active session title. */
function sidebar(): HTMLElement {
  return document.querySelector(".sidebar") as HTMLElement;
}

function freshBackend(): FakeBackend {
  clearLocalStorage();
  const backend = new FakeBackend();
  seedProvider(backend);
  return backend;
}

async function openSessionMenu(sessionTitle: string) {
  const row = within(sidebar()).getByText(sessionTitle).closest(".sb-row") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Session actions" }));
  return await screen.findByRole("menuitem", { name: "Rename…" });
}

describe("chat shell — composer and turns", () => {
  it("sends a prompt: reaches chat/send, streams the reply, refreshes the session", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Fix bug" });
    await renderApp(backend);

    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "Please fix the bug" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));

    await waitFor(() => expect(backend.chatSends).toHaveLength(1));
    expect(backend.chatSends[0]).toMatchObject({
      sessionId: session.id,
      text: "Please fix the bug",
      modelRef: { providerId: "p1", model: "gpt-test" },
    });

    await backend.runTurn(session.id, "All fixed.");
    await waitFor(() => expect(screen.getByText("All fixed.")).toBeInTheDocument());
    // user message persisted by the backend lands after the turn
    await waitFor(() => expect(screen.getByText("Please fix the bug")).toBeInTheDocument());
    // busy cleared → send button back
    expect(screen.getByRole("button", { name: "Send (Enter)" })).toBeInTheDocument();
  }, 20_000);

  it("blocks sending with no provider configured and offers settings", async () => {
    const backend = freshBackend();
    backend.providers.clear();
    await seedSession(backend, { title: "No model" });
    await renderApp(backend);

    expect(screen.getByText(/Add or enable a model provider/i)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("complementary")).getByText("Settings"));
    await waitFor(() => expect(screen.getByText("Model configuration")).toBeInTheDocument());
  });

  it("queues a prompt while busy and auto-flushes it after the turn ends", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Queue test" });
    await renderApp(backend);

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "first task" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(1));

    // While "busy" (no turn/end yet), a second prompt is queued, not sent.
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "second task" } });
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
    expect(backend.chatSends).toHaveLength(1);
    expect(await screen.findByText(/Queued/)).toBeInTheDocument();

    // Finish the turn → the queued prompt auto-sends.
    await backend.runTurn(session.id, "done with first");
    await waitFor(() => expect(backend.chatSends).toHaveLength(2), { timeout: 4000 });
    expect(backend.chatSends[1].text).toBe("second task");
  }, 25_000);

  it("lets the user remove a queued prompt", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Queue remove" });
    await renderApp(backend);

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "one" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(1));

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "two" } });
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
    await screen.findByText(/Queued/);

    fireEvent.click(screen.getByRole("button", { name: "Remove queued prompt" }));
    await waitFor(() => expect(screen.queryByText(/Queued/)).not.toBeInTheDocument());

    await backend.runTurn(session.id, "finished");
    await waitFor(() => expect(screen.getByText("finished")).toBeInTheDocument());
    // give the flush timer a chance to misbehave
    await new Promise((r) => setTimeout(r, 600));
    expect(backend.chatSends).toHaveLength(1);
  }, 25_000);

  it("stop button calls chat/stop", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend);
    await renderApp(backend);

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "long task" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(backend.stoppedSessions).toEqual([session.id]));
  }, 20_000);

  it("mode chip toggles plan/build and the next send carries the mode", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Modes" });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: /Build: Agent can inspect, edit and run/ }));
    // chip now reads Plan
    await waitFor(() => expect(screen.getByText("Plan")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "plan something" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(1));
    expect(backend.chatSends[0].mode).toBe("plan");
    // backend applied the durable mode
    await waitFor(() => expect(backend.sessions.get(session.id)!.mode).toBe("plan"));
  }, 20_000);

  it("enhance button rewrites the draft via chat/enhance", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Enhance" });
    await renderApp(backend);

    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "make app fast" } });
    fireEvent.click(screen.getByRole("button", { name: "Enhance prompt with AI" }));

    await waitFor(() => expect(backend.enhanceCalls).toHaveLength(1));
    await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("Enhanced: make app fast"));
  }, 20_000);

  it("attaches files via the picker and sends the attachment hint", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Attach" });
    await renderApp(backend);

    backend.filePickResult = ["/workspaces/acme/src/index.ts"];
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(screen.getByText("index.ts")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "review this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(1));
    expect(backend.chatSends[0].text).toContain("[Attached files");
    expect(backend.chatSends[0].text).toContain("/workspaces/acme/src/index.ts");
  }, 20_000);

  it("model menu switches the active model and persists it", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Model pick" });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: /gpt-test/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /gpt-mini/ }));

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("senastr.modelRef")!)).toEqual({
        providerId: "p1",
        model: "gpt-mini",
      }),
    );
  });

  it("permission mode menu switches this session's mode", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Perms" });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: /Permission mode: Approve every privileged tool/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Auto/ }));

    await waitFor(() => {
      const prefs = JSON.parse(window.localStorage.getItem("senastr.sessionPrefs")!);
      expect(prefs[Object.keys(prefs)[0]].permissionMode).toBe("auto");
    });
  });

  it("@ autocomplete lists touched files and applies the pick", async () => {
    const backend = freshBackend();
    await seedSession(backend, {
      title: "Autocomplete",
      messages: [
        userMsg("do things"),
        {
          ...assistantMsg("ok"),
          toolCalls: [{ id: nextId("call"), name: "read_file", arguments: { path: "src/app.ts" } }],
        },
      ],
    });
    await renderApp(backend);

    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "explain @" } });
    input.setSelectionRange(input.value.length, input.value.length);
    const option = await screen.findByRole("option", { name: /src\/app.ts/ });
    fireEvent.mouseDown(option);
    await waitFor(() => expect(input.value).toContain("@src/app.ts"));
    expect((input as HTMLTextAreaElement).value).toContain("@src/app.ts");
  }, 20_000);
});

describe("chat shell — transcript", () => {
  it("renders persisted messages, expandable tool rows and copy buttons", async () => {
    stubClipboard();
    const backend = freshBackend();
    await seedSession(backend, {
      title: "Transcript",
      messages: [
        userMsg("list the files"),
        {
          ...assistantMsg("Here you go."),
          toolCalls: [{ id: "call-1", name: "list_dir", arguments: { path: "." } }],
        },
        { id: nextId("msg"), role: "tool", content: "src/\nREADME.md", createdAt: Date.now(), toolCallId: "call-1", toolName: "list_dir" },
      ],
    });
    await renderApp(backend);

    expect(screen.getByText("list the files")).toBeInTheDocument();
    expect(screen.getByText("Here you go.")).toBeInTheDocument();
    expect(screen.getByText(".")).toBeInTheDocument(); // tool summary

    // tool row expands to args + output
    fireEvent.click(screen.getByText(/done/i).closest(".tool-row")!.querySelector(".tool-row-head")!);
    await waitFor(() => expect(screen.getAllByText(/"path"/).length).toBeGreaterThan(0));
    expect(screen.getByText(/README\.md/)).toBeInTheDocument();

    // copy button hits the clipboard
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith("Here you go."));
  }, 20_000);

  it("shows live tool progress while streaming and finished state after result", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Live tools" });
    await renderApp(backend);

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "write it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(1));

    backend.emit({ type: "turn/start", sessionId: session.id, turnId: "t1" });
    const call = { id: "live-1", name: "write_file", arguments: { path: "a.txt", content: "x" } };
    backend.emit({ type: "tool/call", call });
    expect(await screen.findByText(/running…/)).toBeInTheDocument();
    backend.emit({ type: "tool/result", callId: "live-1", ok: true, result: { ok: true, output: "wrote", durationMs: 5 } });
    await waitFor(() => expect(screen.getByText(/done/)).toBeInTheDocument());
    await backend.runTurn(session.id, "complete");
  }, 20_000);

  it("error turns show the error layer with working Settings / Retry / dismiss", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Errors" });
    await renderApp(backend);

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "trigger error" } });
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(1));

    backend.emit({ type: "turn/start", sessionId: session.id, turnId: "t1" });
    backend.emit({ type: "turn/end", stopReason: "error", usage: {}, error: "provider exploded" });
    await screen.findByText("provider exploded");

    // the layer's Settings shortcut deep-links to the models tab
    fireEvent.click(within(screen.getByRole("complementary")).getByText("Settings"));
    await waitFor(() => expect(screen.getByText("Model configuration")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
    await screen.findByText("provider exploded");

    // Retry resends the same prompt and clears the banner
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(backend.chatSends).toHaveLength(2));
    expect(backend.chatSends[1].text).toBe("trigger error");
    await waitFor(() => expect(screen.queryByText("provider exploded")).not.toBeInTheDocument());
    await backend.runTurn(session.id, "ok now");

    // a fresh failure shows the layer again; dismiss clears it
    backend.emit({ type: "turn/start", sessionId: session.id, turnId: "t2" });
    backend.emit({ type: "turn/end", stopReason: "error", usage: {}, error: "provider exploded" });
    const layer = await screen.findByText("provider exploded");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(layer).not.toBeInTheDocument());
  }, 25_000);
});

describe("chat shell — permission gateway", () => {
  it("shows the dialog, deny reaches permission/respond", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend);
    await renderApp(backend);

    backend.emit({
      kind: "permission/requested",
      request: {
        requestId: "perm-1", sessionId: session.id, tool: "run_command",
        args: { command: "rm -rf /" }, summary: "run_command → rm -rf /", createdAt: Date.now(),
      },
    });

    expect(await screen.findByText("run_command → rm -rf /")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(await screen.findByText(/"command"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(backend.permissionResponses).toEqual([{ requestId: "perm-1", allow: false, remember: null }]),
    );
  }, 20_000);

  it("allow with 'Always' creates a standing grant in the settings list", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend);
    await renderApp(backend);

    backend.emit({
      kind: "permission/requested",
      request: {
        requestId: "perm-2", sessionId: session.id, tool: "run_command",
        args: { command: "ls" }, summary: "run_command → ls", createdAt: Date.now(),
      },
    });
    await screen.findByText("run_command → ls");
    fireEvent.click(screen.getByRole("radio", { name: "Always" }));
    fireEvent.click(screen.getByRole("button", { name: /Allow/ }));

    await waitFor(() => expect(backend.grants).toHaveLength(1));
    expect(backend.grants[0]).toMatchObject({ tool: "run_command", scope: "always", sessionId: null });
  }, 20_000);

  it("queues simultaneous permission requests instead of dropping one", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend);
    await renderApp(backend);

    const mkRequest = (id: string, cmd: string) => ({
      kind: "permission/requested" as const,
      request: {
        requestId: id, sessionId: session.id, tool: "run_command",
        args: { command: cmd }, summary: `run_command → ${cmd}`, createdAt: Date.now(),
      },
    });
    backend.emit(mkRequest("perm-a", "first"));
    backend.emit(mkRequest("perm-b", "second"));

    // First is on screen with a queue badge.
    expect(await screen.findByText("run_command → first")).toBeInTheDocument();
    expect(screen.getByText(/2 waiting/)).toBeInTheDocument();

    // Deciding the first reveals the second.
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByText("run_command → second")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByText(/run_command →/)).not.toBeInTheDocument());
  }, 20_000);

  it("auto mode approves requests without a dialog", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend);
    await renderApp(backend);

    // switch this session to auto
    fireEvent.click(screen.getByRole("button", { name: /Permission mode: Approve every privileged tool/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Auto/ }));

    backend.emit({
      kind: "permission/requested",
      request: { requestId: "perm-auto", sessionId: session.id, tool: "run_command", args: {}, summary: "auto cmd", createdAt: Date.now() },
    });
    await waitFor(() =>
      expect(backend.permissionResponses).toEqual([{ requestId: "perm-auto", allow: true, remember: undefined }]),
    );
    expect(screen.queryByText("auto cmd")).not.toBeInTheDocument();
  }, 20_000);

  it("accept-edits auto-approves writes but still asks for commands", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend);
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: /Permission mode: Approve every privileged tool/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Accept edits/ }));

    backend.emit({
      kind: "permission/requested",
      request: { requestId: "perm-w", sessionId: session.id, tool: "write_file", args: { path: "a" }, summary: "write a", createdAt: Date.now() },
    });
    await waitFor(() => expect(backend.permissionResponses).toContainEqual({ requestId: "perm-w", allow: true, remember: undefined }));

    backend.emit({
      kind: "permission/requested",
      request: { requestId: "perm-c", sessionId: session.id, tool: "run_command", args: {}, summary: "scary cmd", createdAt: Date.now() },
    });
    expect(await screen.findByText("scary cmd")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  }, 20_000);
});

describe("chat shell — ask + plan dialogs", () => {
  it("ask dialog collects answers and resolves the paused turn", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend);
    await renderApp(backend);

    backend.emit({
      type: "ask/request",
      request: {
        requestId: "ask-1", sessionId: session.id, toolCallId: "c1", createdAt: Date.now(),
        questions: [
          { id: "q1", question: "Database?", options: ["Postgres", "SQLite"] },
          { id: "q2", question: "Deadline?" },
        ],
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Question from the agent" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "SQLite" }));
    fireEvent.change(within(dialog).getByLabelText("Answer"), { target: { value: "next week" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send answers" }));

    await waitFor(() => expect(backend.resolvedAsks).toHaveLength(1));
    expect(backend.resolvedAsks[0]).toEqual({ requestId: "ask-1", answers: [["SQLite"], ["next week"]] });
  }, 20_000);

  it("plan proposal: approve switches to build and starts implementation", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Plan", mode: "plan" });
    await renderApp(backend);

    backend.emit({
      type: "plan/proposed",
      sessionId: session.id,
      proposal: { sessionId: session.id, toolCallId: "c9", summary: "Refactor auth", steps: ["step 1", "step 2"], risks: "none", createdAt: Date.now() },
    });

    const dialog = await screen.findByRole("dialog", { name: "Plan ready for review" });
    expect(within(dialog).getByText("Refactor auth")).toBeInTheDocument();
    expect(within(dialog).getByText("step 1")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve & implement" }));
    await waitFor(() => expect(backend.sessions.get(session.id)!.mode).toBe("build"));
    await waitFor(() => expect(backend.chatSends.length).toBeGreaterThanOrEqual(1));
    expect(backend.chatSends.at(-1)!.text).toContain("plan is approved");
  }, 20_000);

  it("plan proposal: request changes sends the feedback in plan mode", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Plan2", mode: "plan" });
    await renderApp(backend);

    backend.emit({
      type: "plan/proposed",
      sessionId: session.id,
      proposal: { sessionId: session.id, toolCallId: "c9", summary: "Plan v1", steps: ["s1"], createdAt: Date.now() },
    });
    const dialog = await screen.findByRole("dialog", { name: "Plan ready for review" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Request changes" }));
    fireEvent.change(await screen.findByPlaceholderText(/What should change\?/), { target: { value: "skip step 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback & revise" }));

    await waitFor(() => expect(backend.chatSends).toHaveLength(1));
    expect(backend.chatSends[0].text).toContain("skip step 1");
    expect(backend.sessions.get(session.id)!.mode).toBe("plan");
  }, 20_000);
});

describe("chat shell — sidebar", () => {
  it("new task creates a session in the current project", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Existing" });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    await waitFor(() => expect(backend.sessions.size).toBe(2));
  });

  it("open project attaches the folder to the active session", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { projectPath: null, title: "No project" });
    await renderApp(backend);

    backend.projectOpenResult = "/workspaces/other";
    fireEvent.click(screen.getByRole("button", { name: "Open project folder…" }));
    await waitFor(() => expect(backend.sessions.get(session.id)!.projectPath).toBe("/workspaces/other"));
  }, 20_000);

  it("session menu: rename via dialog", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Old name" });
    await renderApp(backend);

    await openSessionMenu("Old name");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));

    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    const input = within(dialog).getByPlaceholderText("Session name");
    fireEvent.change(input, { target: { value: "Renamed!" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(backend.sessions.get(session.id)!.title).toBe("Renamed!"));
  }, 20_000);

  it("session menu: pin, fork, archive and restore", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Lifecycle", messages: [userMsg("hi")] });
    await renderApp(backend);

    await openSessionMenu("Lifecycle");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => {
      const prefs = JSON.parse(window.localStorage.getItem("senastr.sessionPrefs")!);
      expect(prefs[session.id].pinned).toBe(true);
    });
    // pinned section appears
    expect(screen.getByText("Pinned")).toBeInTheDocument();

    await openSessionMenu("Lifecycle");
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork session" }));
    await waitFor(() => expect(backend.sessions.size).toBe(2));
    const fork = [...backend.sessions.values()].find((s) => s.id !== session.id)!;
    expect(fork.title).toContain("(fork)");
    expect(fork.messages).toHaveLength(1);

    await openSessionMenu("Lifecycle");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => {
      const prefs = JSON.parse(window.localStorage.getItem("senastr.sessionPrefs")!);
      expect(prefs[session.id].archived).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    expect(within(sidebar()).getByText("Lifecycle")).toBeInTheDocument();

    const archivedRow = within(sidebar()).getByText("Lifecycle").closest(".sb-row") as HTMLElement;
    fireEvent.click(within(archivedRow).getByRole("button", { name: "Session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => {
      const prefs = JSON.parse(window.localStorage.getItem("senastr.sessionPrefs")!);
      expect(prefs[session.id].archived).toBe(false);
    });
  }, 25_000);

  it("session menu: delete removes the session and selects another", async () => {
    const backend = freshBackend();
    const a = await seedSession(backend, { title: "Delete me" });
    await seedSession(backend, { title: "Survivor", messages: [userMsg("x")] });
    await renderApp(backend);

    await openSessionMenu("Delete me");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(backend.sessions.has(a.id)).toBe(false));
    expect(screen.getByText("Session deleted")).toBeInTheDocument();
    // survivor becomes active
    await waitFor(() => expect(within(sidebar()).getByText("Survivor")).toBeInTheDocument());
  }, 20_000);

  it("filter box narrows the list and clears", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Alpha thing" });
    await seedSession(backend, { title: "Beta thing" });
    await renderApp(backend);

    fireEvent.change(screen.getByPlaceholderText("Filter sessions…"), { target: { value: "beta" } });
    await waitFor(() => expect(within(sidebar()).queryByText("Alpha thing")).not.toBeInTheDocument());
    expect(within(sidebar()).getByText("Beta thing")).toBeInTheDocument();

    fireEvent.click(within(sidebar()).getByRole("button", { name: "Clear filter" }));
    await waitFor(() => expect(within(sidebar()).getByText("Alpha thing")).toBeInTheDocument());
  }, 20_000);

  it("sort menu reorders sessions by name", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Zebra" });
    await seedSession(backend, { title: "Apple" });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Sort: Recent" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Name" }));

    const titles = screen.getAllByText(/^(Zebra|Apple)$/).map((el) => el.textContent);
    expect(titles.indexOf("Apple")).toBeLessThan(titles.indexOf("Zebra"));
  }, 20_000);

  it("project menu: new task in project, rename project, pin project", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "In project" });
    await renderApp(backend);

    const groupHead = within(sidebar()).getByText("acme").closest(".sb-group-head") as HTMLElement;
    fireEvent.click(within(groupHead).getByRole("button", { name: "Project actions" }));

    fireEvent.click(await screen.findByRole("menuitem", { name: "New task in project" }));
    await waitFor(() => expect(backend.sessions.size).toBe(2));
    expect([...backend.sessions.values()].every((s) => s.projectPath === PROJECT)).toBe(true);

    fireEvent.click(within(within(sidebar()).getByText("acme").closest(".sb-group-head") as HTMLElement).getByRole("button", { name: "Project actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename project…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename project" });
    fireEvent.change(within(dialog).getByPlaceholderText("Display name"), { target: { value: "Acme Corp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(sidebar()).getByText("Acme Corp")).toBeInTheDocument());

    fireEvent.click(within(within(sidebar()).getByText("Acme Corp").closest(".sb-group-head") as HTMLElement).getByRole("button", { name: "Project actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin project" }));
    await waitFor(() => {
      const meta = JSON.parse(window.localStorage.getItem("senastr.projectMeta")!);
      expect(meta[PROJECT].pinned).toBe(true);
    });
  }, 30_000);

  it("settings button opens the settings view", async () => {
    const backend = freshBackend();
    await seedSession(backend);
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByText("Model configuration")).toBeInTheDocument());
  });
});

describe("chat shell — topbar", () => {
  it("AI title button asks the model and renames the session", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "New session", messages: [userMsg("build a rocket"), assistantMsg("ok")] });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Generate title with AI" }));
    await waitFor(() => expect(backend.suggestTitleCalls).toHaveLength(1));
    await waitFor(() => expect(backend.sessions.get(session.id)!.title).toBe("AI generated title"));
  }, 20_000);

  it("notification bell opens the work panel activity tab", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Bell" });
    await renderApp(backend);

    backend.pushNotification({ kind: "ask", title: "The agent has a question", body: "which db?" });
    await screen.findByRole("button", { name: "1 unread notification" });

    fireEvent.click(screen.getByRole("button", { name: "1 unread notification" }));
    expect(await screen.findByRole("tab", { name: /Activity/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("The agent has a question")).toBeInTheDocument();
  }, 20_000);

  it("work panel toggle button opens and closes the panel", async () => {
    const backend = freshBackend();
    await seedSession(backend);
    await renderApp(backend);

    expect(screen.queryByRole("tab", { name: /Review/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    expect(await screen.findByRole("tab", { name: /Review/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close panel (Ctrl+J)" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /Review/ })).not.toBeInTheDocument());
  }, 20_000);

  it("sidebar collapse and expand", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Collapsible" });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar (Ctrl+B)" }));
    await waitFor(() => expect(screen.queryByLabelText("Sessions")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar (Ctrl+B)" }));
    await waitFor(() => expect(screen.getByLabelText("Sessions")).toBeInTheDocument());
    expect(within(sidebar()).getByText("Collapsible")).toBeInTheDocument();
  }, 20_000);
});

describe("chat shell — search dialog", () => {
  it("opens with Ctrl+K, filters sessions and actions, and runs the top hit", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Findable session" });
    await renderApp(backend);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByPlaceholderText("Search sessions, jump to settings, run actions…");

    const dialog = screen.getByRole("dialog");
    fireEvent.change(box, { target: { value: "findable" } });
    expect(await within(dialog).findByText("Findable session")).toBeInTheDocument();
    expect(within(dialog).queryByText("New task")).not.toBeInTheDocument();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.queryByPlaceholderText(/Search sessions/)).not.toBeInTheDocument());
  }, 20_000);

  it("keyboard navigation reaches the trailing Open settings row (regression)", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Solo" });
    await renderApp(backend);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByPlaceholderText("Search sessions, jump to settings, run actions…");

    // Empty query → 5 actions + 1 session + trailing settings row = 7 slots.
    // Six ArrowDowns land exactly on the trailing "Open settings" row; the
    // old code cycled over rows only and never reached it from the keyboard.
    for (let i = 0; i < 6; i++) fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Model configuration")).toBeInTheDocument());
  }, 20_000);

  it("Escape closes the dialog", async () => {
    const backend = freshBackend();
    await seedSession(backend);
    await renderApp(backend);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByPlaceholderText(/Search sessions/);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText(/Search sessions/)).not.toBeInTheDocument());
  }, 20_000);
});

describe("chat shell — work panel", () => {
  it("review tab: snapshots, expand, two-step rollback", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Review flow" });
    backend.addSnapshot(session.id, {
      sessionId: session.id, path: "src/app.ts", before: "old", after: "new", truncated: false, createdAt: Date.now(),
    });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    const getPanel = () => document.querySelector(".work-panel") as HTMLElement;
    await waitFor(() => expect(getPanel()).toBeTruthy());
    const panel = getPanel();
    expect(within(panel).getByText("app.ts")).toBeInTheDocument();

    fireEvent.click(within(panel).getByText("app.ts"));
    expect(await within(panel).findByText(/\+new/)).toBeInTheDocument();
    expect(within(panel).getByText(/-old/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Rollback" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Confirm rollback" }));
    await waitFor(() => expect(backend.rolledBack).toHaveLength(1));
    expect(backend.rolledBack[0].sessionId).toBe(session.id);
  }, 25_000);

  it("review tab: empty state for sessions without writes", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "No writes" });
    await renderApp(backend);
    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    expect(await screen.findByText("No file writes in this session yet.")).toBeInTheDocument();
  }, 20_000);

  it("git tab: branch info, PR list, open in browser, refresh", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Git tab" });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Git/ }));

    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(await screen.findByText("Add retry logic")).toBeInTheDocument();
    expect(screen.getByText("Draft: docs")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Open in browser" })[0]);
    await waitFor(() => expect(backend.openExternalCalls).toContain("https://github.com/acme/repo/pull/7"));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("Refreshing…")).toBeInTheDocument());
  }, 25_000);

  it("git tab: friendly error without a repo", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "No git", projectPath: "/does/not/exist" });
    await renderApp(backend);
    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Git/ }));
    expect(await screen.findByText("not a git repository")).toBeInTheDocument();
  }, 20_000);

  it("files tab lists read/written files with counts", async () => {
    const backend = freshBackend();
    await seedSession(backend, {
      title: "Files tab",
      messages: [
        userMsg("work"),
        {
          ...assistantMsg(""),
          toolCalls: [
            { id: nextId("call"), name: "read_file", arguments: { path: "a.ts" } },
            { id: nextId("call"), name: "write_file", arguments: { path: "a.ts" } },
            { id: nextId("call"), name: "write_file", arguments: { path: "b.ts" } },
          ],
        },
      ],
    });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Files/ }));

    const panelEl = document.querySelector(".work-panel") as HTMLElement;
    const a = within(panelEl).getByText("a.ts").closest(".wp-file") as HTMLElement;
    expect(within(a).getByText("1w")).toBeInTheDocument();
    expect(within(a).getByText("1r")).toBeInTheDocument();
    const b = within(panelEl).getByText("b.ts").closest(".wp-file") as HTMLElement;
    expect(within(b).getByText("1w")).toBeInTheDocument();
  }, 20_000);

  it("details tab shows session facts with working fork + archive", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Details", messages: [userMsg("hey")] });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Details/ }));

    await waitFor(() => expect(screen.getByText(PROJECT)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Fork session" }));
    await waitFor(() => expect(backend.sessions.size).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    // forking activates the copy, so this Archive stores prefs for the fork
    await waitFor(() => {
      const prefs: Record<string, { archived?: boolean }> = JSON.parse(
        window.localStorage.getItem("senastr.sessionPrefs")!,
      );
      expect(Object.values(prefs).some((p) => p.archived)).toBe(true);
    });
  }, 25_000);

  it("activity tab: delegation cards expand and notifications actions work", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { title: "Activity" });
    await renderApp(backend);

    backend.emitDelegation(session.id, {
      id: "d1", sessionId: session.id, agentName: "explorer", description: "Look around",
      status: "done", startedAt: Date.now(), completedAt: Date.now(), turns: 3, report: "found nothing",
    });
    backend.pushNotification({ kind: "info", title: "First note" });
    backend.pushNotification({ kind: "plan", title: "Second note", sessionId: session.id });

    fireEvent.click(screen.getByRole("button", { name: "Toggle work panel (Ctrl+J)" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Activity/ }));

    expect(await screen.findByText("explorer")).toBeInTheDocument();
    fireEvent.click(screen.getByText("explorer"));
    expect(await screen.findByText("found nothing")).toBeInTheDocument();

    // a notification carrying a taskId deep-links into Settings → Scheduled
    backend.pushNotification({ kind: "scheduled", title: "Task finished", taskId: "task-1" });
    fireEvent.click(await screen.findByText("Task finished"));
    await waitFor(() => expect(screen.getByText("Scheduled tasks")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
    await waitFor(() => expect(screen.queryByText("Scheduled tasks")).not.toBeInTheDocument());

    // mark all read + clear from the activity tab
    fireEvent.click(screen.getByRole("button", { name: /unread notifications?|Notifications/i }));
    fireEvent.click(await screen.findByRole("tab", { name: /Activity/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(backend.notifications.every((n) => n.read)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(backend.notifications).toHaveLength(0));
    expect(await screen.findByText("No notifications yet.")).toBeInTheDocument();
  }, 25_000);
});

describe("chat shell — onboarding + global shortcuts", () => {
  it("onboarding checklist drives open-project and settings steps", async () => {
    const backend = freshBackend();
    const session = await seedSession(backend, { projectPath: null, title: "Onboard" });
    await renderApp(backend);

    const step1 = await screen.findByText("Open a project folder");
    expect(step1).toBeInTheDocument();

    backend.projectOpenResult = "/workspaces/newproj";
    fireEvent.click(screen.getByText("Open a project folder").closest("button")!);
    await waitFor(() => expect(backend.sessions.get(session.id)!.projectPath).toBe("/workspaces/newproj"));

    // provider exists → that step is done; the remaining step is "send your first task"
    await waitFor(() =>
      expect(
        screen.getByText("Connect a model provider").closest("button")!.className,
      ).toContain("done"),
    );
  }, 20_000);

  it("Ctrl+J and Ctrl+, shortcuts work", async () => {
    const backend = freshBackend();
    await seedSession(backend);
    await renderApp(backend);

    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(await screen.findByRole("tab", { name: /Review/ })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("Model configuration")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    await waitFor(() => expect(screen.queryByText("Model configuration")).not.toBeInTheDocument());
  }, 20_000);

  it("Ctrl+Shift+O creates a new task", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Shortcut" });
    await renderApp(backend);

    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(backend.sessions.size).toBe(2));
  }, 20_000);
});

describe("chat shell — settings dead-control regressions", () => {
  it("scheduled segments filter tasks by scope", async () => {
    const backend = freshBackend();
    await seedSession(backend, { title: "Scoped" });
    await backend.scheduled.set({
      title: "Project task", prompt: "p", projectPath: PROJECT, providerId: "p1", model: "gpt-test",
    });
    await backend.scheduled.set({
      title: "Global task", prompt: "p", projectPath: "", providerId: "p1", model: "gpt-test",
    });
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Scheduled" }));
    expect(await screen.findByText("Project task")).toBeInTheDocument();
    expect(screen.getByText("Global task")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Global/ }));
    await waitFor(() => expect(screen.queryByText("Project task")).not.toBeInTheDocument());
    expect(screen.getByText("Global task")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Project/ }));
    await waitFor(() => expect(screen.queryByText("Global task")).not.toBeInTheDocument());
    expect(screen.getByText("Project task")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(screen.getByText("Global task")).toBeInTheDocument());
    expect(screen.getByText("Project task")).toBeInTheDocument();
  }, 20_000);

  it("extensions toolbar shows a static scope label instead of a dead tab", async () => {
    const backend = freshBackend();
    await seedSession(backend);
    await renderApp(backend);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Extensions" }));

    const seg = (await screen.findByText("Installed")).closest(".settings-segments") as HTMLElement;
    expect(seg.querySelector("button")).toBeNull();
    expect(seg.querySelector(".segment-static")).toBeTruthy();
  }, 20_000);
});
