import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Join class names, dropping falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

interface TooltipButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
  ariaLabel?: string;
}

/** Button with a native tooltip + accessible label. */
export const TooltipButton = forwardRef<HTMLButtonElement, TooltipButtonProps>(function TooltipButton(
  { tooltip, ariaLabel, title, ...rest },
  ref,
) {
  return <button ref={ref} type="button" title={title ?? tooltip} aria-label={ariaLabel ?? tooltip} {...rest} />;
});

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} aria-hidden>
      <span />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Anchored popover menu                                               */
/* ------------------------------------------------------------------ */

interface MenuProps {
  open: boolean;
  onClose: () => void;
  trigger: (ref: React.RefObject<HTMLElement | null>) => ReactNode;
  children: ReactNode;
  className?: string;
  menuClassName?: string;
  align?: "start" | "end";
  label?: string;
}

/**
 * Lightweight anchored menu. The trigger renders inline; the floating panel
 * is portalled to the body and positioned under the trigger.
 */
export function Menu({
  open,
  onClose,
  trigger,
  children,
  className,
  menuClassName,
  align = "start",
  label,
}: MenuProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const minWidth = Math.max(r.width, 200);
    const left = align === "end" ? Math.max(8, r.right - minWidth) : Math.min(r.left, window.innerWidth - minWidth - 8);
    setPos({ top: r.bottom + 6, left, minWidth });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  return (
    <span className={cx("menu-anchor", className)}>
      {trigger(triggerRef)}
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              className={cx("menu-panel", menuClassName)}
              role="menu"
              aria-label={label}
              style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  checked?: boolean;
}

export function MenuItem({ icon, hint, danger, checked, className, children, ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx("menu-item", danger && "danger", checked && "checked", className)}
      {...rest}
    >
      {icon ? <span className="menu-item-icon">{icon}</span> : null}
      <span className="menu-item-label">{children}</span>
      {hint ? <span className="menu-item-hint">{hint}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="menu-heading">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Modal dialog                                                        */
/* ------------------------------------------------------------------ */

export function Modal({
  onClose,
  children,
  className,
  label,
  wide,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    const el = panelRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    el?.focus();
  }, []);

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx("modal-panel", wide && "wide", className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
