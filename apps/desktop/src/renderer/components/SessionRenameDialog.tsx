import { useState } from "react";
import { Modal } from "./ui";

function RenameForm({
  initial,
  sub,
  placeholder,
  saveLabel,
  onClose,
  onSave,
}: {
  initial: string;
  sub?: string;
  placeholder: string;
  saveLabel: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    if (!value.trim()) return;
    onSave(value.trim());
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {sub ? <div className="rename-sub" title={sub}>{sub}</div> : null}
      <input
        data-autofocus
        className="rename-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <div className="rename-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!value.trim()}>
          {saveLabel}
        </button>
      </div>
    </form>
  );
}

export function SessionRenameDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  return (
    <Modal label="Rename session" onClose={onClose}>
      <div className="rename-title">Rename session</div>
      <RenameForm
        initial={initial}
        placeholder="Session name"
        saveLabel="Rename"
        onClose={onClose}
        onSave={onSave}
      />
    </Modal>
  );
}

export function ProjectRenameDialog({
  initial,
  path,
  onClose,
  onSave,
}: {
  initial: string;
  path: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  return (
    <Modal label="Rename project" onClose={onClose}>
      <div className="rename-title">Rename project</div>
      <RenameForm
        initial={initial}
        sub={path}
        placeholder="Display name"
        saveLabel="Save"
        onClose={onClose}
        onSave={onSave}
      />
    </Modal>
  );
}
