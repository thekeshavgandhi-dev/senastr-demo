import { useEffect, useRef } from "react";
import type { AppNotification } from "@senastr/shared";
import type { SenastrStore } from "../hooks/useSenastr";
import { IconBell, IconCheck, IconHelp, IconSparkles, IconClock } from "./icons";
import { TooltipButton, cx } from "./ui";

function kindIcon(kind: AppNotification["kind"]) {
  switch (kind) {
    case "ask":
      return <IconHelp size={14} />;
    case "plan":
      return <IconSparkles size={14} />;
    case "scheduled":
      return <IconClock size={14} />;
    case "success":
      return <IconCheck size={14} />;
    default:
      return <IconBell size={14} />;
  }
}

function timeAgo(at: number): string {
  const s = Math.max(1, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleDateString();
}

export function NotificationBell({ store }: { store: SenastrStore }) {
  const unread = store.notifications.filter((n) => !n.read).length;
  return (
    <TooltipButton
      type="button"
      className={cx("icon-btn", "bell-btn", unread > 0 && "has-unread")}
      tooltip={unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
      onClick={() => {
        store.setWorkPanelOpen(true);
        store.setWorkPanelTab("activity");
      }}
    >
      <IconBell size={15} />
      {unread > 0 ? <span className="bell-dot">{unread > 9 ? "9+" : unread}</span> : null}
    </TooltipButton>
  );
}

/** Full notification list, rendered inside the work panel "Activity" tab. */
export function NotificationList({ store }: { store: SenastrStore }) {
  const items = store.notifications;
  if (!items.length) {
    return (
      <div className="wp-empty">
        <IconBell size={22} />
        <p>No notifications yet.</p>
        <small>Questions, plans and scheduled runs will show up here.</small>
      </div>
    );
  }
  return (
    <div className="wp-list">
      <div className="wp-list-actions">
        <button type="button" className="btn xs" onClick={() => void store.markNotificationsRead({ all: true })}>
          Mark all read
        </button>
        <button type="button" className="btn xs ghost-danger" onClick={() => void store.clearNotifications()}>
          Clear
        </button>
      </div>
      {items.map((n) => (
        <button
          key={n.id}
          type="button"
          className={cx("wp-card", "note-card", !n.read && "unread")}
          onClick={() => store.openNotification(n)}
        >
          <span className={cx("note-kind", n.kind)}>{kindIcon(n.kind)}</span>
          <span className="note-body">
            <span className="note-title">{n.title}</span>
            {n.body ? <span className="note-text">{n.body}</span> : null}
            <span className="note-time">{timeAgo(n.createdAt)}</span>
          </span>
          {!n.read ? <span className="note-unread-dot" /> : null}
        </button>
      ))}
    </div>
  );
}

/** Backwards-compatible popover wrapper (unused by default layout). */
export function NotificationPopover({ store, onClose }: { store: SenastrStore; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="note-popover" role="dialog" aria-label="Notifications">
      <NotificationList store={store} />
    </div>
  );
}
