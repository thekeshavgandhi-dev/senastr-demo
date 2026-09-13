import type { SenastrApi } from "../types";

/** Typed accessor for the preload bridge. */
export const api: SenastrApi = window.senastr;

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
