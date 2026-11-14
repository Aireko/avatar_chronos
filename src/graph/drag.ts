/** Track pointer drag until release. Returns whether the pointer moved past `slop` px. */
export function trackDrag(
  e: { clientX: number; clientY: number; button?: number; preventDefault(): void },
  opts: {
    slop?: number;
    onMove(dx: number, dy: number, moved: boolean): void;
    onUp?(moved: boolean): void;
  },
): void {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const slop = opts.slop ?? 4;
  const origin = { x: e.clientX, y: e.clientY };
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - origin.x;
    const dy = ev.clientY - origin.y;
    if (!moved && Math.hypot(dx, dy) >= slop) moved = true;
    opts.onMove(dx, dy, moved);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    opts.onUp?.(moved);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/** True when the user asked the system for less motion: animations snap to their end. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
