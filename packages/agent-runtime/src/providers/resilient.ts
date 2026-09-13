import type { ModelSpec } from "../types";

/**
 * Resilient model HTTP layer: key-pool rotation, per-key cooldowns and an
 * optional client-side per-minute throttle, shared by every provider.
 *
 * Why it exists: hosted models rate limit per key (HTTP 429). A single key
 * therefore stalls the agent exactly when you are mid-task. With a key pool,
 * a 429 (or a rejected 401/403) simply moves the request to the next key,
 * cooling the failed key down for a while. With a per-minute throttle, the
 * client stays under the provider's own limits before they can reject it.
 *
 * State (pools + limiters) lives at module level, keyed by provider, so
 * cooldowns persist across turns and parallel sessions inside the app.
 */

const DEFAULT_COOLDOWN_MS = 30_000;
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
/** Give up waiting for a cooled-down key after this long per request. */
const MAX_WAIT_FOR_COOLDOWN_MS = 60_000;
/** Delay before retrying a 5xx / network blip on the same key. */
const SERVER_RETRY_DELAY_MS = 750;
/** Cap on per-key exponential backoff bursts. */
const MAX_BURST = 4;

function effectiveApiKeys(spec: ModelSpec): string[] {
  if (Array.isArray(spec.apiKeys) && spec.apiKeys.length) return spec.apiKeys;
  return spec.apiKey ? [spec.apiKey] : [];
}

/** Sliding-window request throttle. `acquire` waits until a slot is free. */
export class SlidingWindowRateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.clock();
      while (this.stamps.length > 0 && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      const waitMs = this.stamps[0] + this.windowMs - now + 50;
      await sleep(waitMs, signal);
    }
  }
}

interface KeyState {
  cooldownUntil: number;
  authFailed: boolean;
  burst: number;
}

/** Round-robin pool with per-key cooldowns and auth-failure memory. */
export class KeyPool {
  private states = new Map<string, KeyState>();
  private lastIndex = -1;

  constructor(private keys: string[]) {}

  get size(): number {
    return this.keys.length;
  }

  /** Sync with a spec's current key list (user may add keys while running). */
  updateKeys(keys: string[]): void {
    this.keys = [...new Set(keys)];
    for (const key of [...this.states.keys()]) {
      if (!this.keys.includes(key)) this.states.delete(key);
    }
    if (this.lastIndex >= this.keys.length) this.lastIndex = -1;
  }

  cooldownUntil(key: string): number {
    return this.states.get(key)?.cooldownUntil ?? 0;
  }

  isAuthFailed(key: string): boolean {
    return this.states.get(key)?.authFailed ?? false;
  }

  markRateLimited(key: string, cooldownMs?: number, now: number = Date.now()): void {
    const state = this.state(key);
    state.burst = Math.min(state.burst + 1, MAX_BURST);
    const base = cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const scaled = base * 2 ** (state.burst - 1);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + clampCooldown(scaled));
  }

  markAuthFailed(key: string): void {
    this.state(key).authFailed = true;
  }

  markRecovered(key: string): void {
    const state = this.state(key);
    state.cooldownUntil = 0;
    state.burst = 0;
  }

  /** Round-robin start: the slot after the last one used. */
  advanceBase(): number {
    return this.keys.length ? (this.lastIndex + 1) % this.keys.length : 0;
  }

  /** Remember the key just used so the next pick continues round-robin. */
  advanceTo(index: number): void {
    this.lastIndex = index;
  }

  private state(key: string): KeyState {
    let state = this.states.get(key);
    if (!state) {
      state = { cooldownUntil: 0, authFailed: false, burst: 0 };
      this.states.set(key, state);
    }
    return state;
  }
}

interface ProviderRuntime {
  pool: KeyPool;
  limiter: SlidingWindowRateLimiter | null;
  limit: number;
}

const runtimes = new Map<string, ProviderRuntime>();

function providerBucket(spec: ModelSpec): string {
  return spec.providerId ?? spec.baseUrl ?? "default";
}

export function runtimeFor(spec: ModelSpec): ProviderRuntime {
  const bucket = providerBucket(spec);
  const limit =
    typeof spec.rateLimitPerMin === "number" && Number.isFinite(spec.rateLimitPerMin)
      ? Math.max(0, Math.floor(spec.rateLimitPerMin))
      : 0;
  const existing = runtimes.get(bucket);
  if (existing && existing.limit === limit) {
    existing.pool.updateKeys(effectiveApiKeys(spec));
    return existing;
  }
  const runtime: ProviderRuntime = {
    pool: new KeyPool(effectiveApiKeys(spec)),
    limiter: limit > 0 ? new SlidingWindowRateLimiter(limit) : null,
    limit,
  };
  runtimes.set(bucket, runtime);
  return runtime;
}

/** Test hook: drop all key pools and limiters. */
export function __resetResilientRuntime(): void {
  runtimes.clear();
}

function clampCooldown(ms: number): number {
  return Math.max(MIN_COOLDOWN_MS, Math.min(ms, MAX_COOLDOWN_MS));
}

function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return clampCooldown(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return clampCooldown(Math.max(0, date - now));
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("request aborted");
  err.name = "AbortError";
  return err;
}

async function drainBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "";
  }
}

/** Pick the next key: round-robin, skipping rejected and cooling keys.
 * Waits (bounded) when every candidate is cooling down. */
async function pickKey(
  runtime: ProviderRuntime,
  keys: string[],
  rejected: Set<string>,
  signal?: AbortSignal,
  preferIndex?: number,
): Promise<{ key: string; index: number }> {
  const now = Date.now();
  if (
    preferIndex !== undefined &&
    preferIndex >= 0 &&
    preferIndex < keys.length
  ) {
    const key = keys[preferIndex];
    if (
      !rejected.has(key) &&
      !runtime.pool.isAuthFailed(key) &&
      runtime.pool.cooldownUntil(key) <= now
    ) {
      runtime.pool.advanceTo(preferIndex);
      return { key, index: preferIndex };
    }
  }
  for (let i = 0; i < keys.length; i++) {
    const index = (runtime.pool.advanceBase() + i) % keys.length;
    const key = keys[index];
    if (rejected.has(key) || runtime.pool.isAuthFailed(key)) continue;
    if (runtime.pool.cooldownUntil(key) <= now) {
      runtime.pool.advanceTo(index);
      return { key, index };
    }
  }
  let bestIndex: number | undefined;
  let bestUntil = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const index = (runtime.pool.advanceBase() + i) % keys.length;
    const key = keys[index];
    if (rejected.has(key) || runtime.pool.isAuthFailed(key)) continue;
    const until = runtime.pool.cooldownUntil(key);
    if (until < bestUntil) {
      bestUntil = until;
      bestIndex = index;
    }
  }
  if (bestIndex === undefined) {
    throw new Error(
      "all API keys for this provider failed authentication — fix or remove the bad key(s) in Settings → Models",
    );
  }
  const waitMs = bestUntil - Date.now();
  if (waitMs > MAX_WAIT_FOR_COOLDOWN_MS) {
    throw new Error(
      `all API keys for this provider are cooling down (next slot in ~${Math.ceil(waitMs / 1000)}s) — add more keys in Settings → Models or wait a moment`,
    );
  }
  await sleep(Math.max(waitMs, 0), signal);
  runtime.pool.advanceTo(bestIndex);
  return { key: keys[bestIndex], index: bestIndex };
}

export interface ResilientBuildRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ResilientRequest {
  spec: ModelSpec;
  signal?: AbortSignal;
  /** Build the full request for a given key (undefined = no key, e.g. local). */
  build: (apiKey: string | undefined) => ResilientBuildRequest;
}

/**
 * POST to the model endpoint with resilience:
 *  - waits for the provider's per-minute throttle slot
 *  - 429 → cool the key down (honoring Retry-After), move to the next key
 *  - 401/403 → mark the key rejected for this request + memory, next key
 *  - 5xx / network → retry same key once after a short delay, then rotate
 *  - anything else (incl. 200) → return the response to the provider
 */
export async function postToModel({ spec, signal, build }: ResilientRequest): Promise<Response> {
  const keys = effectiveApiKeys(spec);
  const runtime = runtimeFor(spec);

  if (keys.length === 0) {
    // Keyless (local endpoint): one throttled request, nothing to rotate.
    if (runtime.limiter) await runtime.limiter.acquire(signal);
    const request = build(undefined);
    try {
      return await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`model request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const maxAttempts = Math.max(3, keys.length * 3 + 2);
  const rejected = new Set<string>();
  const retried = new Set<string>();
  let lastError = "no usable API key";
  let retryHere: number | undefined; // index to retry in place (5xx / network)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw abortError();
    const { key, index } = await pickKey(runtime, keys, rejected, signal, retryHere);
    retryHere = undefined;
    if (runtime.limiter) await runtime.limiter.acquire(signal);

    let res: Response;
    try {
      const request = build(key);
      res = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
      if (!retried.has(key)) {
        retried.add(key);
        retryHere = index; // give this key one in-place retry
        await sleep(SERVER_RETRY_DELAY_MS, signal);
        continue;
      }
      continue; // rotate
    }

    if (res.status === 429) {
      const detail = await drainBody(res);
      runtime.pool.markRateLimited(key, parseRetryAfter(res.headers.get("retry-after")));
      lastError = `rate limited (HTTP 429): ${detail || "provider limit reached"}`;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await drainBody(res);
      runtime.pool.markAuthFailed(key);
      rejected.add(key);
      lastError = `authentication failed (HTTP ${res.status}) for one of the keys`;
      continue;
    }
    if (res.status >= 500) {
      await drainBody(res);
      lastError = `provider server error (HTTP ${res.status})`;
      if (!retried.has(key)) {
        retried.add(key);
        retryHere = index; // in-place retry before rotating
        await sleep(SERVER_RETRY_DELAY_MS, signal);
        continue;
      }
      continue; // rotate
    }

    runtime.pool.markRecovered(key);
    return res; // provider reads the body and handles non-ok 4xx itself
  }

  throw new Error(`provider request failed after ${maxAttempts} attempts — ${lastError}`);
}
