import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/**
 * One shared block of ink under a group of `.scope-tab`s (the Project / File / Function
 * tabs in the toolbar, the History / Calls switch on the stage), laid under whichever
 * tab is `.on`. Changing tab glides it across; the first placement and re-measures (the
 * hand font arriving and changing the tab widths) jump straight there, so it never
 * sweeps in from the left edge.
 */
export function useSlidingInk(bar: RefObject<HTMLDivElement | null>, ink: RefObject<HTMLSpanElement | null>, active: string) {
  const placed = useRef(false);

  function place(glide: boolean) {
    const box = bar.current;
    const mark = ink.current;
    if (!box || !mark) return;
    const on = box.querySelector<HTMLElement>(".scope-tab.on");
    if (!on) {
      mark.hidden = true;
      placed.current = false;
      return;
    }
    // Sub-pixel positions, relative to the bar's padding edge (where `left: 0` is).
    const outer = box.getBoundingClientRect();
    const tab = on.getBoundingClientRect();
    // Screen boxes include the ancestors' transforms: the stage switch is first measured
    // while its pop-in still holds it at 96%, and nothing re-measures once that ends
    // (a transform resizes nothing), which left the ink 4% short of the tab. So the scale
    // is undone, and the ink is laid out in the bar's own pixels, like the tabs.
    const ratio = box.offsetWidth > 0 ? outer.width / box.offsetWidth : 1;
    const scale = Math.abs(ratio - 1) < 0.005 ? 1 : ratio;
    const x = (tab.left - outer.left) / scale - box.clientLeft;
    // Turning the glide off in the same frame as the move makes the move instant.
    mark.classList.toggle("is-gliding", glide && placed.current);
    mark.hidden = false;
    mark.style.width = `${tab.width / scale}px`;
    mark.style.transform = `translateX(${x}px)`;
    placed.current = true;
  }

  // Before paint, so the ink is never a frame behind the tab's own colour change.
  useLayoutEffect(() => place(true), [active]);

  useEffect(() => {
    const box = bar.current;
    if (!box) return;
    let stale = false;
    const remeasure = () => {
      if (!stale) place(false);
    };
    // The ink is placed relative to the bar, so only the tabs' own sizes matter: they
    // change when "Patrick Hand" finishes loading (or the zoom level changes).
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(remeasure) : null;
    if (watch) {
      watch.observe(box);
      box.querySelectorAll(".scope-tab").forEach((tab) => watch.observe(tab));
    }
    void document.fonts?.ready.then(remeasure, () => {});
    return () => {
      stale = true;
      watch?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
