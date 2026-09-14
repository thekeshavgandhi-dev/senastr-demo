/**
 * User-configurable outbound proxy (parity: pi-desktop `shared/network-proxy.ts`).
 *
 * Pure parse/validate helpers shared by the renderer, Electron main and the
 * agent runtime. Applying the proxy to a fetch implementation lives in the
 * process that owns it.
 */

export const NETWORK_PROXY_MODES = ["system", "direct", "custom"] as const;
export type NetworkProxyMode = (typeof NETWORK_PROXY_MODES)[number];

export const NETWORK_PROXY_SCHEMES = ["http", "https", "socks", "socks5", "socks5h"] as const;
export type NetworkProxyScheme = (typeof NETWORK_PROXY_SCHEMES)[number];

export const DEFAULT_NETWORK_PROXY_BYPASS = "localhost,127.0.0.1,::1";

export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export interface NetworkProxySettings {
  mode: NetworkProxyMode;
  /** Required when `mode` is `custom`. Canonical proxy URL. */
  url?: string;
  /** Comma-separated bypass list. Absent uses {@link DEFAULT_NETWORK_PROXY_BYPASS}. */
  bypass?: string;
}

export interface ParsedProxyUrl {
  href: string;
  scheme: NetworkProxyScheme;
  host: string;
  port: number | null;
  username: string;
  password: string;
  isSocks: boolean;
}

const PROXY_URL_MAX_LENGTH = 2048;
const SCHEME_SET = new Set<string>(NETWORK_PROXY_SCHEMES);

export function isNetworkProxyMode(value: unknown): value is NetworkProxyMode {
  return typeof value === "string" && (NETWORK_PROXY_MODES as readonly string[]).includes(value);
}

/**
 * Parse + canonicalise a proxy URL. Returns an error string instead of
 * throwing so the settings UI can render it inline.
 */
export function parseProxyUrl(value: unknown): { ok: true; value: ParsedProxyUrl } | { ok: false; error: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { ok: false, error: "proxy URL is required" };
  if (raw.length > PROXY_URL_MAX_LENGTH) return { ok: false, error: "proxy URL is too long" };
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return { ok: false, error: "proxy URL is not a valid URL" };
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!SCHEME_SET.has(scheme)) {
    return { ok: false, error: `unsupported proxy scheme: ${scheme || "(none)"}` };
  }
  if (!url.hostname) return { ok: false, error: "proxy URL has no host" };
  const explicitPort = url.port ? Number(url.port) : null;
  const port = explicitPort ?? (scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80);
  const parsed: ParsedProxyUrl = {
    href: url.toString(),
    scheme: scheme as NetworkProxyScheme,
    host: url.hostname,
    port,
    username: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    isSocks: scheme.startsWith("socks"),
  };
  return { ok: true, value: parsed };
}

/** Normalise arbitrary stored input into a valid settings object. */
export function normalizeNetworkProxy(value: unknown): NetworkProxySettings {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const mode = isNetworkProxyMode(record?.mode) ? record.mode : "system";
  const settings: NetworkProxySettings = { mode };
  const parsed = record?.url != null ? parseProxyUrl(record.url) : null;
  if (parsed?.ok) settings.url = parsed.value.href;
  const bypass = typeof record?.bypass === "string" ? record.bypass.trim() : "";
  if (bypass) settings.bypass = bypass;
  return settings;
}

/** Bypass list actually used for `mode: custom`. */
export function effectiveBypass(settings: NetworkProxySettings): string {
  return settings.bypass?.trim() || DEFAULT_NETWORK_PROXY_BYPASS;
}

/**
 * Environment overrides that make Node's fetch (undici) honour the proxy.
 * `direct` explicitly clears any inherited proxy variables.
 */
export type EnvironmentLike = Record<string, string | undefined>;

export function proxyEnvironment(
  settings: NetworkProxySettings,
  base: EnvironmentLike = {},
): EnvironmentLike {
  const env: EnvironmentLike = { ...base };
  if (settings.mode === "system") return env;
  for (const key of PROXY_ENV_KEYS) delete env[key];
  if (settings.mode === "direct") return env;
  const parsed = parseProxyUrl(settings.url);
  if (!parsed.ok) return env;
  const { href } = parsed.value;
  return {
    ...env,
    HTTP_PROXY: href,
    HTTPS_PROXY: href,
    ALL_PROXY: href,
    NO_PROXY: effectiveBypass(settings),
  };
}

/** One-line summary for the settings UI / diagnostics. */
export function describeNetworkProxy(settings: NetworkProxySettings): string {
  switch (settings.mode) {
    case "direct":
      return "Direct connection (no proxy)";
    case "custom": {
      const parsed = parseProxyUrl(settings.url);
      return parsed.ok
        ? `Custom proxy via ${parsed.value.scheme}://${parsed.value.host}:${parsed.value.port}`
        : "Custom proxy (not configured)";
    }
    default:
      return "System proxy";
  }
}

/** Validate a candidate settings object; returns an error string or null. */
export function validateNetworkProxy(settings: NetworkProxySettings): string | null {
  if (settings.mode !== "custom") return null;
  const parsed = parseProxyUrl(settings.url);
  return parsed.ok ? null : parsed.error;
}
