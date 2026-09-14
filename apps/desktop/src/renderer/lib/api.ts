import type { SenastrApi } from "../types";

/**
 * True when the preload bridge exposed the backend API. When false, the app
 * renders the "backend not connected" screen instead of a UI whose every
 * control would silently fail.
 */
export function hasBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.senastr);
}

/**
 * Rejecting stand-in for the bridge, used only if some code path reaches the
 * API without the bridge (prevents opaque `TypeError: Cannot read properties
 * of undefined` and surfaces a clear, actionable message instead).
 */
function missingBridgeApi(): SenastrApi {
  const reject = (path: string) => () =>
    Promise.reject(
      new Error(`senastr backend is not connected (${path}) — launch the desktop app with \`pnpm dev\` so the preload bridge and host-core sidecar are running`),
    );
  const namespace = new Proxy({}, {
    get: (_ns, group) => {
      if (typeof group === "symbol" || group === "then") return undefined;
      return reject(`api.${String(group)}.*`);
    },
  });
  return new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : (namespace as never)) }) as SenastrApi;
}

/** Typed accessor for the preload bridge. */
export const api: SenastrApi = hasBridge() ? (window.senastr as SenastrApi) : missingBridgeApi();

/**
 * Main-process invoke rejections arrive as `Error invoking remote method
 * 'x': Error: rpc -32005: message`. Unwrap to the useful part.
 */
export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/rpc (-?\d+): (.+)$/);
  if (m) return m[2];
  const m2 = raw.match(/Error invoking remote method '[^']+': (.+)$/);
  if (m2) return m2[1];
  return raw;
}

const MODEL_REF_KEY = "senastr.modelRef";

export interface StoredModelRef {
  providerId: string;
  model: string;
}

export function readStoredModelRef(): StoredModelRef | null {
  try {
    const raw = localStorage.getItem(MODEL_REF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredModelRef;
    if (parsed?.providerId && parsed?.model) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function storeModelRef(ref: StoredModelRef | null): void {
  try {
    if (ref) localStorage.setItem(MODEL_REF_KEY, JSON.stringify(ref));
    else localStorage.removeItem(MODEL_REF_KEY);
  } catch {
    /* non-fatal */
  }
}
