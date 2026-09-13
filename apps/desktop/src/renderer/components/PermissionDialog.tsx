import { useState } from "react";
import type { GrantScope, PermissionRequest } from "@senastr/shared";
import { IconFile, IconPlug, IconServer, IconShield, IconTerminal } from "./icons";
import { Modal, cx } from "./ui";

function toolIcon(tool: string) {
  if (tool === "run_command") return <IconTerminal size={18} />;
  if (tool === "write_file" || tool === "read_file" || tool === "list_dir") return <IconFile size={18} />;
  if (tool.startsWith("mcp_")) return <IconServer size={18} />;
  return <IconPlug size={18} />;
}

export function PermissionDialog({
  request,
  sessionTitle,
  onDecide,
}: {
  request: PermissionRequest;
  sessionTitle?: string;
  onDecide: (allow: boolean, remember: GrantScope | null) => void;
}) {
  const [remember, setRemember] = useState<GrantScope | null>(null);
  const [showArgs, setShowArgs] = useState(false);

  return (
    <Modal label="Permission requested" onClose={() => onDecide(false, null)} className="perm-modal">
      <div className="perm-head">
        <span className="perm-icon">{toolIcon(request.tool)}</span>
        <div>
          <div className="perm-title">Permission requested</div>
          {sessionTitle ? <div className="perm-session">{sessionTitle}</div> : null}
        </div>
        <span className="perm-tool-chip">{request.tool}</span>
      </div>

      <p className="perm-summary">{request.summary}</p>

      <button type="button" className="perm-args-toggle" onClick={() => setShowArgs((v) => !v)}>
        {showArgs ? "Hide details" : "Show details"}
      </button>
      {showArgs && <pre className="perm-args">{JSON.stringify(request.args ?? {}, null, 2)}</pre>}

      <div className="perm-remember" role="radiogroup" aria-label="Remember decision">
        {(
          [
            [null, "Just once"],
            ["session", "This session"],
            ["always", "Always"],
          ] as Array<[GrantScope | null, string]>
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={remember === value}
            className={cx("perm-scope", remember === value && "active")}
            onClick={() => setRemember(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="perm-actions">
        <button type="button" data-autofocus className="btn" onClick={() => onDecide(false, null)}>
          Deny
        </button>
        <button type="button" className="btn primary" onClick={() => onDecide(true, remember)}>
          <IconShield size={13} />
          Allow{remember ? ` · ${remember === "always" ? "always" : "session"}` : ""}
        </button>
      </div>
      <div className="perm-note">Unanswered requests are denied automatically after 120 seconds.</div>
    </Modal>
  );
}
