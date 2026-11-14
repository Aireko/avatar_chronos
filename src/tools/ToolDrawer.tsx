// The right-hand drawer the toolbar tools open in. It is built like the commit
// "ticket" (band with a title and a close button, scrolling body) so tools and
// commit details look like one family.
import type { ReactNode } from "react";

export type ToolId = "ai" | "reviews" | "people";

interface ToolDrawerProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

export function ToolDrawer({ title, onClose, children }: ToolDrawerProps) {
  return (
    <aside className="ticket tool-drawer" aria-label={title}>
      <div className="ticket-band">
        <span className="tool-drawer-title">{title}</span>
        <button className="ticket-close" onClick={onClose} aria-label={`Close ${title}`} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="ticket-scroll tool-drawer-body">{children}</div>
    </aside>
  );
}
