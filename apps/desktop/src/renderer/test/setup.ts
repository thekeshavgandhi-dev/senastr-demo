import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom does not implement `scrollIntoView`, which React Testing Library and
// focus management can call. Provide a no-op so tests don't crash.
if (typeof window !== "undefined" && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}
