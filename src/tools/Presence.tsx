// Keeps a panel on screen while it animates out. React removes elements as soon
// as they stop rendering, so a closing drawer would just vanish; <Presence>
// keeps the last content mounted with an "is-leaving" class until the exit
// animation has had time to play, then unmounts it.
//
// With `keepMounted`, the content is not unmounted after the exit: it is parked
// (hidden, inert, "is-parked") so work inside it carries on, e.g. a model download
// in a closed tool drawer or a command running in a closed terminal. The parent
// keeps rendering the children in that case.
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

interface PresenceProps {
  show: boolean;
  /** Classes for the wrapper; its CSS defines the enter/leave animations. */
  className: string;
  /** How long the exit animation runs. Keep in sync with the CSS. */
  exitMs?: number;
  /** Park the content after it closes instead of unmounting it (see above). */
  keepMounted?: boolean;
  children: ReactNode;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function Presence({ show, className, exitMs = 180, keepMounted = false, children }: PresenceProps) {
  // `mounted` stays true while the exit animation plays. Whether we are leaving is
  // derived from `show` during render (not set in an effect), so a panel that reopens
  // mid-exit is interactive in its very first render and can take focus on mount.
  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true);
  // Kept-mounted content is only created the first time it is shown.
  const [visited, setVisited] = useState(show);
  if (show && !visited) setVisited(true);
  const leaving = !show;
  // While leaving, the parent usually renders nothing, so remember what was last shown.
  const last = useRef<ReactNode>(children);
  if (show) last.current = children;
  // Each opening gets fresh content, even when it reopens before the exit finished,
  // so components behave as on a normal open (e.g. a panel focuses itself on mount).
  // (React's "adjust state when a prop changes" pattern: safe under StrictMode.)
  const [opens, setOpens] = useState(0);
  const [prevShow, setPrevShow] = useState(show);
  if (show !== prevShow) {
    setPrevShow(show);
    if (show) setOpens((n) => n + 1);
  }

  // After the exit animation, unmount (or park). Reopening before then cancels the timer.
  useEffect(() => {
    if (show || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : exitMs);
    return () => window.clearTimeout(timer);
  }, [show, mounted, exitMs]);

  const parked = !show && !mounted;
  if (parked && !(keepMounted && visited)) return null;
  const state = parked ? "is-parked" : leaving ? "is-leaving" : "is-entering";
  return (
    <div
      className={`${className} ${state}`}
      // A closing (or parked) panel can't be focused or clicked, and screen readers skip it.
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
      hidden={parked || undefined}
      // Wrapper classes usually set `display`, which would beat the hidden attribute.
      style={parked ? { display: "none" } : undefined}
    >
      {/* Kept-mounted content keeps one identity for its whole life, so its work survives. */}
      {keepMounted ? children : <Fragment key={opens}>{show ? children : last.current}</Fragment>}
    </div>
  );
}
