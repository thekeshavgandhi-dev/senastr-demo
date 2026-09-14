import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionMeta } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { SearchDialog } from "./SearchDialog";

function makeStore(overrides: Partial<SenastrStore> = {}) {
  const base: Partial<SenastrStore> = {
    searchOpen: true,
    setSearchOpen: vi.fn(),
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
    workPanelOpen: false,
    setWorkPanelOpen: vi.fn(),
    theme: "dark",
    setTheme: vi.fn(),
    openSettings: vi.fn(),
    newSession: vi.fn(),
    openProject: vi.fn(),
    setView: vi.fn(),
    selectSession: vi.fn(),
    sessions: [],
    sessionPrefs: {},
    activeSession: null,
  };
  return { ...base, ...overrides } as unknown as SenastrStore;
}

const sampleSession: SessionMeta = {
  id: "sess-1",
  title: "Fix login bug",
  projectPath: "/home/user/app",
  mode: "build",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 7,
};

describe("SearchDialog", () => {
  it("renders actions and the matching session", () => {
    render(<SearchDialog store={makeStore({ sessions: [sampleSession] })} />);
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
    expect(screen.getByText("Open settings")).toBeInTheDocument();
  });

  it("filters actions by fuzzy query", () => {
    render(<SearchDialog store={makeStore()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: "theme" } });
    expect(screen.getByRole("button", { name: /Toggle theme/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New task/ })).not.toBeInTheDocument();
  });

  it("runs the highlighted action on Enter", () => {
    const store = makeStore();
    render(<SearchDialog store={store} />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: "theme" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/Search sessions/), { key: "Enter" });
    expect(store.setSearchOpen).toHaveBeenCalledWith(false);
    expect(store.setTheme).toHaveBeenCalledWith("light");
  });

  it("opens the matching session on Enter", () => {
    const store = makeStore({ sessions: [sampleSession] });
    render(<SearchDialog store={store} />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: "login" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/Search sessions/), { key: "Enter" });
    expect(store.selectSession).toHaveBeenCalledWith("sess-1");
  });

  it("closes when the user presses Escape", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      const store = makeStore({ searchOpen: open, setSearchOpen: setOpen });
      return <SearchDialog store={store} />;
    }
    render(<Harness />);
    expect(screen.getByPlaceholderText(/Search sessions/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/Search sessions/)).not.toBeInTheDocument();
  });
});
