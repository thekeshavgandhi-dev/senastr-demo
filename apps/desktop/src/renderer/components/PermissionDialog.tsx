import type { GrantScope, PermissionRequest } from "@senastr/shared";

interface Props {
  request: PermissionRequest;
  onDecide: (allow: boolean, remember: GrantScope | null) => void;
}

export function PermissionDialog({ request, onDecide }: Props) {
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="dialog">
        <div className="dialog-title">
          <span className="dialog-badge">{request.tool}</span> wants to run
        </div>
        <div className="dialog-summary">{request.summary}</div>
        <pre className="dialog-args">{JSON.stringify(request.args, null, 2)}</pre>
        <div className="dialog-note">
          senastr only acts inside the project folder. “Allow in this session” remembers the choice for this
          session; commands that look risky will always ask.
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => onDecide(false, null)}>
            Deny
          </button>
          <button className="btn" onClick={() => onDecide(true, null)}>
            Allow once
          </button>
          <button className="btn primary" onClick={() => onDecide(true, "session")}>
            Allow in this session
          </button>
        </div>
      </div>
    </div>
  );
}
