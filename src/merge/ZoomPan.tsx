import { useEffect, useRef, useState, type ReactNode } from "react";

interface T { x: number; y: number; k: number }
const START: T = { x: 0, y: 0, k: 1 };

export function ZoomPan({ children, height = 340 }: { children: ReactNode; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [t, setT] = useState<T>(START);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        setT((p) => {
          const k = Math.min(3, Math.max(0.3, p.k * Math.exp(-e.deltaY * 0.01)));
          const s = k / p.k;
          return { k, x: px - (px - p.x) * s, y: py - (py - p.y) * s };
        });
      } else {
        setT((p) => ({ ...p, x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoom = (f: number) => setT((p) => ({ ...p, k: Math.min(3, Math.max(0.3, p.k * f)) }));

  return (
    <div className="merge-zoom" style={{ height }}>
      <div
        ref={box}
        className="merge-zoom-view"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          drag.current = { x: e.clientX, y: e.clientY };
          setT((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <div className="merge-zoom-inner" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})` }}>
          {children}
        </div>
      </div>
      <div className="merge-zoom-keys">
        <button type="button" className="btn merge-small" aria-label="Zoom in" onClick={() => zoom(1.25)}>+</button>
        <button type="button" className="btn merge-small" aria-label="Zoom out" onClick={() => zoom(0.8)}>−</button>
        <button type="button" className="btn merge-small" onClick={() => setT(START)}>Reset</button>
      </div>
    </div>
  );
}