import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The renderer must degrade loudly when the preload bridge is missing
 * (plain browser load, broken preload, repaired install): instead of a
 * full UI whose every button fails, show the "backend not connected"
 * screen and reject any stray API access with an actionable message.
 */
describe("app without the preload bridge", () => {
  it("shows the backend-not-connected screen instead of a dead UI", async () => {
    window.localStorage.clear();
    delete (window as unknown as { senastr?: unknown }).senastr;
    vi.resetModules();

    const { default: App } = await import("../App");
    render(<App />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/backend is not connected/i)).toBeInTheDocument();
    // guidance is actionable
    expect(screen.getByText(/pnpm dev/)).toBeInTheDocument();
    // no interactive shell to get stuck in
    expect(screen.queryByTestId("composer-input")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("API access without the bridge rejects with an actionable error", async () => {
    delete (window as unknown as { senastr?: unknown }).senastr;
    vi.resetModules();

    const { api } = await import("../lib/api");
    await expect(api.session.list()).rejects.toThrow(/not connected/);
    await expect(api.chat.send({ sessionId: "s", text: "x", modelRef: { providerId: "p", model: "m" } })).rejects.toThrow(
      /pnpm dev/,
    );
  });
});
