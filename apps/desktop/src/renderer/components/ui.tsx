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

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
  maxHeight: number;
}

const MENU_MARGIN = 8;
const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 340;

/**
 * Lightweight anchored menu. The trigger renders inline; the floating panel
 * is portalled to the body and positioned next to the trigger.
 *
 * Positioning is viewport-aware: when there isn't room below the trigger the
 * panel flips above it, and it is always clamped horizontally and vertically
 * so it can never be clipped off-screen ("hidden"/"cut off" popups).
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
  const [pos, setPos] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = triggerRef.current;
      const panel = panelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const minWidth = Math.max(r.width, 200);

      // Horizontal: align to the trigger edge, then clamp inside the viewport.
      let left = align === "end" ? r.right - minWidth : r.left;
      left = Math.max(MENU_MARGIN, Math.min(left, vw - minWidth - MENU_MARGIN));

      // Vertical: prefer opening below; flip above when it would be clipped.
      const spaceBelow = vh - r.bottom - MENU_GAP;
      const spaceAbove = r.top - MENU_GAP;
      const panelHeight = panel?.offsetHeight || 0;
      // Prefer the side that can hold the whole panel; when the height isn't
      // measurable yet (e.g. jsdom), fall back to the side with more room.
      const fitsBelow = panelHeight > 0 && spaceBelow >= panelHeight;
      const openDown = fitsBelow || spaceBelow >= spaceAbove;

      let top: number | undefined;
      let bottom: number | undefined;
      let maxHeight: number;
      if (openDown) {
        maxHeight = Math.min(MENU_MAX_HEIGHT, Math.max(40, spaceBelow - MENU_MARGIN));
        top = Math.max(MENU_MARGIN, Math.min(r.bottom + MENU_GAP, vh - MENU_MARGIN - maxHeight));
      } else {
        maxHeight = Math.min(MENU_MAX_HEIGHT, Math.max(40, spaceAbove - MENU_MARGIN));
        bottom = Math.max(MENU_MARGIN, vh - r.top + MENU_GAP);
      }
      setPos({ top, bottom, left, minWidth, maxHeight });
    };
    // Re-anchor when the window resizes or any scroll container moves the
    // trigger. Ignore scrolls coming from inside the panel itself (its own
    // overflow) so scrolling menu content never re-triggers placement.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      place();
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
    };
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
        return;
      }
      // Arrow/Home/End move focus between the menu items (Enter/Space already
      // activate a focused <button> natively).
      const panel = panelRef.current;
      if (!panel || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
      if (!items.length) return;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Home") items[0].focus();
      else if (e.key === "End") items[items.length - 1].focus();
      else if (e.key === "ArrowDown") items[(idx + 1) % items.length].focus();
      else items[(idx - 1 + items.length) % items.length].focus();
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
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className={cx("menu-panel", menuClassName)}
              role="menu"
              aria-label={label}
              style={
                pos
                  ? {
                      top: pos.top,
                      bottom: pos.bottom,
                      left: pos.left,
                      minWidth: pos.minWidth,
                      maxHeight: pos.maxHeight,
                    }
                  : { visibility: "hidden", top: 0, left: 0, minWidth: 200 }
              }
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

  // Move focus into the dialog, trap Tab inside it while open, and restore
  // focus to the previously focused element when it closes.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;
    const autofocus = panel.querySelector<HTMLElement>("[data-autofocus]");
    (autofocus ?? panel).focus();

    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx("modal-panel", wide && "wide", className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
