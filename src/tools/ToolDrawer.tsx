// The right-hand drawer the toolbar tools open in. It is built like the commit
// "ticket" (band with a title and a close button, scrolling body) so tools and
// commit details look like one family.
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";

export type ToolId = "ai" | "reviews" | "people";

interface ToolDrawerProps {
  title: string;
  /** The tool's toolbar icon, repeated in the band so the drawer reads as "that button's" panel. */
  icon?: () => ReactElement;
  /** Whether the drawer is showing. It stays mounted while closed, so tools keep working. */
  open: boolean;
  /** True when the user switched from another tool: the heading re-inks instead of snapping. */
  swap?: boolean;
  onClose(): void;
  children: ReactNode;
}

export function ToolDrawer({ title, icon: Icon, open, swap = false, onClose, children }: ToolDrawerProps) {
  const sheet = useRef<HTMLElement>(null);

  // Keyboard focus follows the drawer when it opens or switches tools, so the next Tab
  // lands in the tool rather than back at the start of the commit map.
  useEffect(() => {
    if (open) sheet.current?.focus({ preventScroll: true });
  }, [open, title]);

  return (
    <aside ref={sheet} className="ticket tool-drawer" aria-label={title} tabIndex={-1}>
      <div className="ticket-band">
        {/* Keyed by title: switching tools re-inks the heading (only then; see .is-swap). */}
        <span key={title} className={`tool-drawer-title${swap ? " is-swap" : ""}`}>
          {Icon && <Icon />}
          <span className="tool-drawer-name">{title}</span>
        </span>
        <button className="ticket-close" onClick={onClose} aria-label={`Close ${title}`} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="ticket-scroll tool-drawer-body">{children}</div>
    </aside>
  );
}
