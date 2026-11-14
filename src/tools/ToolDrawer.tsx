// The right-hand drawer the toolbar tools open in. It is built like the commit
// "ticket" (band with a title and a close button, scrolling body) so tools and
// commit details look like one family.
import type { ReactElement, ReactNode } from "react";

export type ToolId = "ai" | "reviews" | "people";

interface ToolDrawerProps {
  title: string;
  /** The tool's toolbar icon, repeated in the band so the drawer reads as "that button's" panel. */
  icon?: () => ReactElement;
  onClose(): void;
  children: ReactNode;
}

export function ToolDrawer({ title, icon: Icon, onClose, children }: ToolDrawerProps) {
  return (
    <aside className="ticket tool-drawer" aria-label={title}>
      <div className="ticket-band">
        {/* Keyed by title: switching tools re-inks the heading instead of snapping. */}
        <span key={title} className="tool-drawer-title">
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
