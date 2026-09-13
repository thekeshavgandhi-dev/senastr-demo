import { afterEach, describe, expect, it } from "vitest";
import {
  KeyPool,
  SlidingWindowRateLimiter,
  postToModel,
  __resetResilientRuntime,
} from "../src/providers/resilient";
import { OpenAICompatibleProvider } from "../src/providers/openai";
import type { ModelSpec } from "../src/types";
import type { ChatMessage, ToolDefinition } from "@senastr/shared";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetResilientRuntime();
});

function makeSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    kind: "openai",
    providerId: "test-provider",
    model: "gpt-test",
    baseUrl: "https://api.test/v1",
    apiKeys: ["key-a", "key-b"],
    ...overrides,
  };
}

function buildFor(spec: ModelSpec) {
  return (apiKey: string | undefined) => ({
    url: "https://api.test/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: spec.model }),
  });
}

function captureFetch(handler: (index: number, init: RequestInit) => Response) {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const initOrEmpty = init ?? {};
    calls.push(initOrEmpty);
    return handler(calls.length - 1, initOrEmpty);
  }) as typeof fetch;
  return calls;
}

function authHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.authorization;
}

describe("postToModel — key pool rotation", () => {
  it("rotates to the next key when one is rate limited (429)", async () => {
    const spec = makeSpec();
    const calls = captureFetch((index) => {
      if (index === 0) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return new Response("{}", { status: 200 });
    });

    const res = await postToModel({ spec, build: buildFor(spec) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(authHeader(calls[0])).toBe("Bearer key-a");
    expect(authHeader(calls[1])).toBe("Bearer key-b");
  });

  it("skips a rejected (401) key for the rest of the session", async () => {
    const spec = makeSpec();
    const calls = captureFetch((index) => {
      if (index === 0) return new Response("unauthorized", { status: 401 });
      return new Response("{}", { status: 200 });
    });

    const first = await postToModel({ spec, build: buildFor(spec) });
    expect(first.status).toBe(200);
    expect(authHeader(calls[1])).toBe("Bearer key-b");

    // key-a is remembered as auth-failed, so the next request starts at key-b.
    const second = await postToModel({ spec, build: buildFor(spec) });
    expect(second.status).toBe(200);
    expect(authHeader(calls[2])).toBe("Bearer key-b");
  });

  it("retries a 5xx once on the same key before rotating", async () => {
    const spec = makeSpec();
    const calls = captureFetch((index) => {
      if (index === 0) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200 });
    });

    const res = await postToModel({ spec, build: buildFor(spec) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(authHeader(calls[0])).toBe("Bearer key-a");
    expect(authHeader(calls[1])).toBe("Bearer key-a"); // same-key in-place retry
  });

  it("passes non-retryable client errors (400) straight to the provider", async () => {
    const spec = makeSpec();
    const calls = captureFetch(() => new Response("bad request", { status: 400 }));
    const res = await postToModel({ spec, build: buildFor(spec) });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("fails fast with a clear error when every key is rejected", async () => {
    const spec = makeSpec();
    captureFetch(() => new Response("nope", { status: 403 }));
    await expect(postToModel({ spec, build: buildFor(spec) })).rejects.toThrow(/failed authentication/);
  });

  it("gives up with a clear error when the only key is cooling down", async () => {
    const spec = makeSpec({ apiKeys: ["only"] });
    captureFetch(() =>
      new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
    );
    await expect(postToModel({ spec, build: buildFor(spec) })).rejects.toThrow(/cooling down/);
  });

  it("makes a single unauthenticated request for keyless local providers", async () => {
    const spec = makeSpec({ apiKeys: [], apiKey: undefined, providerId: "local" });
    const calls = captureFetch(() => new Response("{}", { status: 200 }));
    const res = await postToModel({ spec, build: buildFor(spec) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(authHeader(calls[0])).toBeUndefined();
  });

  it("end-to-end: the streaming provider fails over to the second key on 429", async () => {
    const spec = makeSpec({ apiKeys: ["bad-key", "good-key"] });
    const calls = captureFetch((index) => {
      if (index === 0) {
        return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    const provider = new OpenAICompatibleProvider(spec);
    const events: unknown[] = [];
    for await (const evt of provider.streamChat({
      model: spec.model,
      messages: [] as ChatMessage[],
      tools: [] as ToolDefinition[],
    })) {
      events.push(evt);
    }
    expect(calls).toHaveLength(2);
    expect(authHeader(calls[0])).toBe("Bearer bad-key");
    expect(authHeader(calls[1])).toBe("Bearer good-key");
    expect(events.some((e: any) => e.kind === "text" && e.delta === "Hello")).toBe(true);
  });
});

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("KeyPool", () => {
  it("rotates round-robin, cools keys down and remembers auth failures", () => {
    const pool = new KeyPool(["a", "b"]);
    expect(pool.advanceBase()).toBe(0);
    pool.advanceTo(0);
    expect(pool.advanceBase()).toBe(1);

    pool.markRateLimited("a", 5_000);
    expect(pool.cooldownUntil("a")).toBeGreaterThan(Date.now());
    pool.markRecovered("a");
    expect(pool.cooldownUntil("a")).toBe(0);

    pool.markAuthFailed("b");
    expect(pool.isAuthFailed("b")).toBe(true);

    // updateKeys drops state for removed keys and keeps it for the rest.
    pool.updateKeys(["b", "c"]);
    expect(pool.isAuthFailed("b")).toBe(true);
    expect(pool.cooldownUntil("c")).toBe(0);
  });
});

describe("SlidingWindowRateLimiter", () => {
  it("queues the third request until a slot frees up", async () => {
    const limiter = new SlidingWindowRateLimiter(2, 200);
    await limiter.acquire();
    await limiter.acquire();
    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
  });

  it("allows continuous traffic under the limit", async () => {
    const limiter = new SlidingWindowRateLimiter(50, 200);
    const started = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(Date.now() - started).toBeLessThan(50);
  });
});
