import { useEffect, useReducer, useRef, useState } from "react";
import {
  DEFAULT_NETWORK_PROXY_BYPASS,
  NETWORK_PROXY_MODES,
  describeNetworkProxy,
  parseProxyUrl,
  validateNetworkProxy,
  type NetworkProxyMode,
  type NetworkProxySettings,
} from "@senastr/shared";
import type { SenastrStore } from "../../hooks/useSenastr";
import { Field } from "./SettingsPrimitives";
import { cx } from "../ui";

/**
 * Outbound network proxy (parity: pi-desktop `network/testProxy` and
 * `settings.proxy`). The desktop applies a custom proxy to model requests
 * through an undici dispatcher and to every child process through the standard
 * `*_PROXY` environment variables, so this page is the single place that
 * decides what the whole app uses.
 *
 * The URL and bypass fields are uncontrolled: their text lives in refs and is
 * only read when saving or blurring, which keeps typing responsive and lets the
 * host stay the source of truth for the persisted value.
 */
export function NetworkSettings({ store }: { store: SenastrStore }) {
  const stored = store.hostSettings.proxy ?? { mode: "system" as const };
  const signature = `${stored.mode}|${stored.url ?? ""}|${stored.bypass ?? ""}`;

  const urlRef = useRef<HTMLInputElement | null>(null);
  const bypassRef = useRef<HTMLInputElement | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  /** Mode the user just picked, until the host echoes it back. */
  const [pendingMode, setPendingMode] = useState<NetworkProxyMode | null>(null);
  const [saving, setSaving] = useState(false);
  const mode = pendingMode ?? stored.mode;
  const lastSignature = useRef(signature);
  /** Fields the user edited but has not saved yet are never overwritten. */
  const dirty = useRef({ url: false, bypass: false });

  // Follow the stored value (another window, an import, a reset) without
  // clobbering text the user is typing into an unfocused-agnostic field.
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    const apply = (el: HTMLInputElement | null, next: string) => {
      if (!el || el === document.activeElement) return;
      if (el.value !== next) el.value = next;
    };
    if (!dirty.current.url) apply(urlRef.current, stored.url ?? "");
    if (!dirty.current.bypass) apply(bypassRef.current, stored.bypass ?? "");
    bump();
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const url = urlRef.current?.value ?? stored.url ?? "";
  const parsed = url ? parseProxyUrl(url) : null;
  const problem = url ? (parsed && !parsed.ok ? parsed.error : null) : null;

  /** Persist a candidate configuration. Mode switches always apply; a URL is
   *  validated only when one was actually typed. */
  const apply = async (next: NetworkProxySettings) => {
    const hasUrl = Boolean(next.url?.trim());
    if (next.mode === "custom" && hasUrl) {
      const invalid = validateNetworkProxy(next);
      if (invalid) {
        bump();
        return;
      }
    }
    setSaving(true);
    bump();
    try {
      await store.setProxy(next);
      dirty.current = { url: false, bypass: false };
    } finally {
      setSaving(false);
      setPendingMode(null);
      bump();
    }
  };

  /** Build the settings object to persist from the current field text. Empty
   *  fields are omitted so the stored value stays minimal. */
  const candidate = (next: NetworkProxyMode = mode): NetworkProxySettings => {
    const url = (urlRef.current?.value ?? stored.url ?? "").trim();
    const bypass = (bypassRef.current?.value ?? stored.bypass ?? "").trim();
    const settings: NetworkProxySettings = { mode: next };
    if (url) settings.url = url;
    if (bypass) settings.bypass = bypass;
    return settings;
  };

  return (
    <div className="settings-page">
      <Field label="Proxy mode" hint="Applies to model requests, MCP servers and commands started by the agent.">
        <div className="settings-segments" role="radiogroup" aria-label="Proxy mode">
          {NETWORK_PROXY_MODES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              className={cx(mode === option && "active")}
              onClick={() => {
                setPendingMode(option);
                void apply(candidate(option));
              }}
            >
              {option === "system" ? "System" : option === "direct" ? "Direct" : "Custom"}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Custom proxy URL" hint="http, https, socks, socks5h. Credentials in the URL are supported.">
        <div className="field-row">
          <input
            ref={urlRef}
            type="text"
            defaultValue={stored.url ?? ""}
            placeholder="http://127.0.0.1:7890"
            aria-label="Proxy URL"
            aria-disabled={mode !== "custom"}
            onChange={() => {
              dirty.current.url = true;
              bump();
            }}
            onBlur={() => {
              if (mode !== "custom") return;
              void apply(candidate());
            }}
          />
          <button
            type="button"
            className="btn"
            aria-busy={saving}
            onClick={() => void apply(candidate())}
          >
            Save
          </button>
        </div>
        {problem ? <div className="field-error">{problem}</div> : null}
        {parsed?.ok ? (
          <div className="field-hint">
            {parsed.value.scheme}://{parsed.value.host}:{parsed.value.port}
            {parsed.value.username ? " (authenticated)" : ""}
          </div>
        ) : null}
      </Field>

      <Field label="Bypass list" hint={`Comma separated. Defaults to ${DEFAULT_NETWORK_PROXY_BYPASS}.`}>
        <input
          ref={bypassRef}
          type="text"
          defaultValue={stored.bypass ?? ""}
          placeholder={DEFAULT_NETWORK_PROXY_BYPASS}
          aria-label="Proxy bypass list"
          aria-disabled={mode !== "custom"}
          onChange={() => {
            dirty.current.bypass = true;
          }}
          onBlur={() => {
            if (mode !== "custom") return;
            void apply(candidate());
          }}
        />
      </Field>

      <Field label="Effective configuration" hint="What the app is using right now.">
        <div className="settings-readout">
          <code>{describeNetworkProxy(stored)}</code>
        </div>
      </Field>
    </div>
  );
}
