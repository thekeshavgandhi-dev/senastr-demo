import { useEffect, useRef, useState } from "react";
import type { ProviderSummary } from "@senastr/shared";
import type { SenastrModelRef } from "../types";

export interface ModelOption {
  value: string; // "providerId:model"
  label: string;
}

export function modelOptions(providers: ProviderSummary[]): ModelOption[] {
  return providers.filter((provider) => provider.enabled).flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.id}:${m}`,
      label: `${p.label} · ${m}`,
    })),
  );
}

interface Props {
  busy: boolean;
  canSend: boolean;
  hint?: string;
  options: ModelOption[];
  value: SenastrModelRef | null;
  onChange: (ref: SenastrModelRef | null) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer(p: Props) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const selectedValue = p.value ? `${p.value.providerId}:${p.value.model}` : "";
  const effective = p.options.find((o) => o.value === selectedValue) ?? p.options[0];

  const submit = () => {
    if (!p.canSend || !text.trim()) return;
    p.onSend(text.trim());
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (p.hint && !p.busy) {
    return (
      <div className="composer-hint">{p.hint}</div>
    );
  }

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        rows={1}
        placeholder="Ask senastr to work on this project…  (Enter to send, Shift+Enter for a new line)"
        value={p.busy ? "" : text}
        disabled={p.busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-row">
        <select
          className="model-select"
          value={effective?.value ?? ""}
          disabled={p.busy || p.options.length === 0}
          onChange={(e) => {
            const [providerId, ...rest] = e.target.value.split(":");
            p.onChange({ providerId, model: rest.join(":") });
          }}
        >
          {p.options.length === 0 && <option value="">no models</option>}
          {p.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {p.busy ? (
          <button className="btn danger" onClick={p.onStop}>
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={submit} disabled={!p.canSend || !text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
