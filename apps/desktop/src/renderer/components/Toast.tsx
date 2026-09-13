import type { Notice } from "../hooks/useSenastr";
import { IconAlert, IconCheck, IconX } from "./icons";
import { TooltipButton } from "./ui";

export function ToastHost({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  if (!notices.length) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast ${n.kind}`}>
          <span className="toast-icon">{n.kind === "error" ? <IconAlert size={15} /> : <IconCheck size={15} />}</span>
          <span className="toast-text" title={n.text}>
            {n.text}
          </span>
          <TooltipButton className="toast-dismiss" tooltip="Dismiss" onClick={() => onDismiss(n.id)}>
            <IconX size={13} />
          </TooltipButton>
        </div>
      ))}
    </div>
  );
}
