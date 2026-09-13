import { useEffect, type ReactNode } from "react";
import { SettingsIcon, type SettingsIconName } from "./SettingsIcons";

export function Toggle({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-switch ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

export function IconButton({ icon, label, danger, active, disabled, onClick }: {
  icon: SettingsIconName;
  label: string;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-icon-btn ${danger ? "danger" : ""} ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <SettingsIcon name={icon} size={15} />
    </button>
  );
}

export function Modal({ title, subtitle, wide, children, footer, onClose }: {
  title: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="settings-modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`settings-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="settings-modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="settings-modal-body">{children}</div>
        {footer ? <footer className="settings-modal-footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

export type KeyValuePair = { id: string; key: string; value: string };

export function recordToPairs(value?: Record<string, string>): KeyValuePair[] {
  return Object.entries(value ?? {}).map(([key, item]) => ({ id: makeId(), key, value: item }));
}

export function pairsToRecord(pairs: KeyValuePair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    const value = pair.value.trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function KeyValueEditor({ pairs, onChange, addLabel = "Add row", keyPlaceholder = "Name", valuePlaceholder = "Value", secret = false }: {
  pairs: KeyValuePair[];
  onChange: (pairs: KeyValuePair[]) => void;
  addLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  secret?: boolean;
}) {
  const patch = (id: string, field: "key" | "value", value: string) =>
    onChange(pairs.map((pair) => (pair.id === id ? { ...pair, [field]: value } : pair)));
  return (
    <div className="kv-editor">
      {pairs.map((pair) => (
        <div className="kv-row" key={pair.id}>
          <input value={pair.key} placeholder={keyPlaceholder} onChange={(event) => patch(pair.id, "key", event.target.value)} />
          <input
            type={secret && pair.value !== "••••••" ? "password" : "text"}
            value={pair.value}
            placeholder={valuePlaceholder}
            onChange={(event) => patch(pair.id, "value", event.target.value)}
          />
          <IconButton icon="x" label="Remove row" onClick={() => onChange(pairs.filter((item) => item.id !== pair.id))} />
        </div>
      ))}
      <button type="button" className="settings-text-btn" onClick={() => onChange([...pairs, { id: makeId(), key: "", value: "" }])}>
        <SettingsIcon name="plus" size={13} /> {addLabel}
      </button>
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: {
  icon: SettingsIconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="settings-empty-state">
      <span className="settings-empty-icon"><SettingsIcon name={icon} size={20} /></span>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function Field({ label, hint, children, wide }: {
  label: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`settings-field ${wide ? "wide" : ""}`}>
      <span className="settings-field-label">{label}{hint ? <small>{hint}</small> : null}</span>
      {children}
    </label>
  );
}

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}
