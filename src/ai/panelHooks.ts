// Hooks shared by the tool panels (AI, PR Bug Check, People). The tool drawer
// keeps every opened panel mounted and hides the inactive ones (display: none),
// so a panel must cope with being hidden and shown again while its work goes on.
import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * Reports busy/idle transitions once each: never the same value twice in a row,
 * and never an opening `false` (idle is where everything starts).
 */
export interface BusyLatch {
  set(busy: boolean): void;
  /** Reports `false` if `true` was the last thing reported (used on unmount). */
  release(): void;
}

export function createBusyLatch(emit: (busy: boolean) => void): BusyLatch {
  let current = false;
  const set = (busy: boolean) => {
    if (busy === current) return;
    current = busy;
    emit(busy);
  };
  return { set, release: () => set(false) };
}

/**
 * Calls `onBusyChange(true)` when `busy` turns on, `(false)` when it turns off,
 * and `(false)` on unmount if it was still on. The latest callback is always
 * used, so the parent may pass a new function on every render.
 */
export function useBusySignal(busy: boolean, onBusyChange?: (busy: boolean) => void) {
  const callback = useRef(onBusyChange);
  useEffect(() => {
    callback.current = onBusyChange;
  });
  const [latch] = useState(() => createBusyLatch((next) => callback.current?.(next)));
  useEffect(() => latch.set(busy), [latch, busy]);
  useEffect(() => () => latch.release(), [latch]);
}

/** How long entrance animations stay settled after a panel comes back: past the longest staggered one. */
const RETURN_SETTLE_MS = 700;

/**
 * For a panel inside a pane that is hidden and shown again (the tool drawer):
 *
 * - Showing an element that was display: none restarts every CSS animation in it,
 *   so all the panel's "arriving" motion would replay each time the user switches
 *   back. While `data-pane-return` is set on the root, the panel CSS collapses
 *   those entrance animations to their end state.
 * - The scroll offsets of scrolling boxes inside the panel (answer, code blocks)
 *   are remembered while visible and put back when the panel returns.
 * - `onReturn` runs after that, e.g. to re-pin a streaming answer to its end.
 *
 * It needs no layout reads while hidden, so nothing is measured as 0.
 */
export function usePaneReturn(ref: RefObject<HTMLElement | null>, onReturn?: () => void) {
  const callback = useRef(onReturn);
  useEffect(() => {
    callback.current = onReturn;
  });

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return;

    const offsets = new Map<Element, { top: number; left: number }>();
    // Scroll events don't bubble, but a capturing listener on the root sees them all.
    const onScroll = (event: Event) => {
      const el = event.target;
      // A box that is hidden reads 0: never remember that.
      if (!(el instanceof Element) || el.clientHeight === 0) return;
      offsets.set(el, { top: el.scrollTop, left: el.scrollLeft });
    };
    root.addEventListener("scroll", onScroll, true);

    let seen = false;
    let hidden = true;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      const visible = root.getClientRects().length > 0;
      if (!visible) {
        hidden = true;
        return;
      }
      if (!hidden) return;
      hidden = false;
      if (!seen) {
        seen = true;
        return;
      }
      root.setAttribute("data-pane-return", "");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => root.removeAttribute("data-pane-return"), RETURN_SETTLE_MS);
      for (const [el, at] of offsets) {
        if (!el.isConnected) {
          offsets.delete(el);
          continue;
        }
        if (el.scrollTop !== at.top) el.scrollTop = at.top;
        if (el.scrollLeft !== at.left) el.scrollLeft = at.left;
      }
      callback.current?.();
    });
    observer.observe(root);

    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", onScroll, true);
      window.clearTimeout(timer);
      root.removeAttribute("data-pane-return");
    };
  }, [ref]);
}
