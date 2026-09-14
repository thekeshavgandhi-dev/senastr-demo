import { render, waitFor, type RenderResult } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { ChatMessage, ProviderConfig, Session } from "@senastr/shared";
import type { SenastrApi } from "../types";
import { FakeBackend, nextId } from "./fake-backend";

/**
 * The renderer captures `window.senastr` once at module load (`lib/api.ts`).
 * Tests swap backends per test, so the bridge is a stable proxy that
 * forwards every property access to the currently active FakeBackend.
 */
let current: FakeBackend | undefined;

const bridge = new Proxy({} as SenastrApi, {
  get(_, prop) {
    const backend = current as unknown as Record<string | symbol, unknown>;
    const value = backend?.[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(current) : value;
  },
  has(_, prop) {
    return prop in (current as unknown as object);
  },
});

(window as { senastr?: unknown }).senastr = bridge;

/** Point the bridge at a backend and import-app modules lazily. */
export function activateBackend(backend: FakeBackend): void {
  current = backend;
}

/** Render the whole app against the given backend and wait for boot. */
export async function renderApp(backend: FakeBackend): Promise<RenderResult> {
  activateBackend(backend);
  const AppModule = await import("../App");
  const App = AppModule.default;
  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container.querySelector(".app")).toBeTruthy();
  });
  return utils;
}

export function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

export function clearLocalStorage(): void {
  window.localStorage.clear();
}

export const PROJECT = "/workspaces/acme";

/** A provider the model menus can pick. */
export function seedProvider(backend: FakeBackend, patch: Partial<ProviderConfig> = {}): ProviderConfig {
  const cfg: ProviderConfig = {
    id: "p1",
    kind: "openai",
    vendorKey: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeys: ["sk-test"],
    apiStyle: "chat_completions",
    models: ["gpt-test", "gpt-mini"],
    defaultModel: "gpt-test",
    enabled: true,
    ...patch,
  };
  backend.providers.set(cfg.id, cfg);
  return cfg;
}

export async function seedSession(
  backend: FakeBackend,
  patch: { title?: string; projectPath?: string | null; messages?: ChatMessage[]; mode?: Session["mode"] } = {},
): Promise<Session> {
  const now = Date.now();
  const session: Session = {
    id: nextId("sess"),
    title: patch.title ?? "New session",
    projectPath: patch.projectPath === undefined ? PROJECT : patch.projectPath,
    mode: patch.mode ?? "build",
    createdAt: now,
    updatedAt: now,
    messageCount: patch.messages?.length ?? 0,
    messages: [...(patch.messages ?? [])],
  };
  backend.sessions.set(session.id, session);
  return session;
}

export function userMsg(text: string): ChatMessage {
  return { id: nextId("msg"), role: "user", content: text, createdAt: Date.now() - 60_000 };
}

export function assistantMsg(text: string): ChatMessage {
  return { id: nextId("msg"), role: "assistant", content: text, createdAt: Date.now() - 30_000 };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
