// A small hand-lettered tooltip for icon-only keys. It is drawn by CSS (.tip in
// toolbar.css) on hover and on keyboard focus, so keyboard users see it too. It is
// hidden from screen readers: the key carries the same words as its aria-label.
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Which way it hangs: below the key (the toolbar) or above it (the status bar). */
  side?: "below" | "above";
  /** Which edge of the key it lines up with, so it stays inside the window near an edge. */
  align?: "center" | "end";
}

export function Tip({ children, side = "below", align = "center" }: Props) {
  return (
    <span className={`tip is-${side} is-${align}`} aria-hidden="true">
      {children}
    </span>
  );
}
