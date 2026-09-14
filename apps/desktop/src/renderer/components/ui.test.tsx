import { useState, type RefObject } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Menu, MenuItem, Modal } from "./ui";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
}

function mockRect(
  el: Element,
  r: { top: number; left: number; width: number; height: number },
) {
  const rect = {
    x: r.left,
    y: r.top,
    top: r.top,
    left: r.left,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
    toJSON: () => ({}),
  } as DOMRect;
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => rect });
}

function MenuHarness({
  align,
  items = ["Item one", "Item two", "Item three"],
}: {
  align?: "start" | "end";
  items?: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label="Test menu"
      align={align}
      open={open}
      onClose={() => setOpen(false)}
      trigger={(ref) => (
        <button ref={ref as RefObject<HTMLButtonElement>} type="button" onClick={() => setOpen((v) => !v)}>
          Open menu
        </button>
      )}
    >
      {items.map((label) => (
        <MenuItem key={label} onClick={() => setOpen(false)}>
          {label}
        </MenuItem>
      ))}
    </Menu>
  );
}

function menuPanel(): HTMLElement {
  const panel = screen.getByRole("menu");
  return panel;
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

describe("Menu", () => {
  it("renders the panel into the document body when opened", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(menuPanel()).toBeInTheDocument();
    expect(menuPanel().parentElement).toBe(document.body);
  });

  it("opens below the trigger when there is room", () => {
    setViewport(1024, 600);
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    mockRect(trigger, { top: 100, left: 300, width: 120, height: 30 });
    fireEvent.click(trigger);
    const panel = menuPanel();
    // trigger bottom (130) + 6px gap
    expect(panel.style.top).toBe("136px");
    expect(panel.style.bottom).toBe("");
  });

  it("flips above the trigger when the trigger sits near the bottom edge", () => {
    setViewport(1024, 600);
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    mockRect(trigger, { top: 560, left: 300, width: 120, height: 30 });
    fireEvent.click(trigger);
    const panel = menuPanel();
    // No top set — the panel is bottom-anchored just above the trigger.
    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe(`${600 - 560 + 6}px`);
  });

  it("clamps the panel inside the viewport horizontally (align=start)", () => {
    setViewport(1024, 600);
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    mockRect(trigger, { top: 100, left: 980, width: 120, height: 30 });
    fireEvent.click(trigger);
    const panel = menuPanel();
    // minWidth is 200 → left must be ≤ 1024 - 200 - 8 = 816
    expect(Number.parseFloat(panel.style.left)).toBeLessThanOrEqual(816);
  });

  it("clamps the panel inside the viewport horizontally (align=end)", () => {
    setViewport(1024, 600);
    render(<MenuHarness align="end" />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    mockRect(trigger, { top: 100, left: 4, width: 40, height: 30 });
    fireEvent.click(trigger);
    const panel = menuPanel();
    // right-aligned at trigger.right (44) would overflow left; clamp to margin.
    expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8);
  });

  it("caps the panel height so it never overflows the viewport", () => {
    setViewport(1024, 300);
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    mockRect(trigger, { top: 120, left: 300, width: 120, height: 30 });
    fireEvent.click(trigger);
    const panel = menuPanel();
    const maxHeight = Number.parseFloat(panel.style.maxHeight);
    expect(maxHeight).toBeGreaterThan(0);
    // trigger bottom 150 + gap 6 → available below is 300-156-8 = 136
    expect(maxHeight).toBeLessThanOrEqual(136);
  });

  it("closes on Escape", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(menuPanel()).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes when clicking outside the panel and trigger", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(menuPanel()).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not close when clicking inside the panel", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.mouseDown(menuPanel());
    expect(menuPanel()).toBeInTheDocument();
  });

  it("moves focus between menu items with the arrow keys", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const [first, second] = screen.getAllByRole("menuitem");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "End" });
    expect(screen.getAllByRole("menuitem").at(-1)).toHaveFocus();
    fireEvent.keyDown(document, { key: "Home" });
    expect(first).toHaveFocus();
  });
});

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

function ModalHarness() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <Modal label="Test dialog" onClose={() => setOpen(false)}>
      <button data-autofocus>First</button>
      <button>Second</button>
      <button>Third</button>
    </Modal>
  );
}

describe("Modal", () => {
  it("renders an accessible dialog", () => {
    render(<ModalHarness />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "Test dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus to the autofocus target on open", () => {
    render(<ModalHarness />);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("closes on Escape", () => {
    render(<ModalHarness />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when clicking the overlay backdrop", () => {
    render(<ModalHarness />);
    // The dialog is portalled to <body>, so query the backdrop there.
    const overlay = document.body.querySelector(".modal-overlay")!;
    fireEvent.mouseDown(overlay);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("traps Tab navigation within the dialog", () => {
    render(<ModalHarness />);
    const first = screen.getByRole("button", { name: "First" });
    const third = screen.getByRole("button", { name: "Third" });
    third.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(third).toHaveFocus();
  });
});
