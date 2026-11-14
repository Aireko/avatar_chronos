import { useEffect, useRef, useState, type CSSProperties } from "react";
import { clamp, prefersReducedMotion, trackDrag } from "./drag";
import type { GraphLayout } from "./layout";

interface Props {
  layout: GraphLayout;
  selected: string | null;
  head: string | null;
  onSelect: (hash: string) => void;
}

const SCALE = 0.42;

/** Large pannable commit map for the code editor — does not shrink to fit. */
export function MiniMap({ layout, selected, head, onSelect }: Props) {
  const view = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 520, h: 340 });
  const [pos, setPos] = useState({ right: 16, bottom: 16 });
  const moved = useRef(false);

  useEffect(() => {
    const el = view.current;
    const node = el && (selected ?? head) ? layout.byHash.get(selected ?? head!) : undefined;
    if (!el || !node) return;
    el.scrollTo({
      left: node.x * SCALE - el.clientWidth / 2,
      top: node.y * SCALE - el.clientHeight / 2,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [selected, head, layout, size]);

  return (
    <div className="mini-map" aria-label="Commit map" style={{ width: size.w, height: size.h, ...pos }}>
      <div
        className="mini-map-resize"
        aria-label="Resize map"
        onPointerDown={(e) => {
          const start = { ...size };
          trackDrag(e, {
            onMove: (dx, dy) =>
              setSize({
                w: clamp(start.w - dx, 320, 900),
                h: clamp(start.h - dy, 200, 640),
              }),
          });
        }}
      />
      <div
        className="mini-map-bar"
        onPointerDown={(e) => {
          const start = { ...pos };
          trackDrag(e, {
            onMove: (dx, dy) =>
              setPos({
                right: Math.max(8, start.right - dx),
                bottom: Math.max(8, start.bottom - dy),
              }),
          });
        }}
      >
        <span>Map</span>
        <span className="mini-map-hint">drag · pan · top-left resize</span>
      </div>
      <div
        ref={view}
        className="mini-map-view"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          const start = { left: el.scrollLeft, top: el.scrollTop };
          moved.current = false;
          trackDrag(e, {
            onMove: (dx, dy, did) => {
              moved.current = did;
              if (did) el.classList.add("dragging");
              el.scrollLeft = start.left - dx;
              el.scrollTop = start.top - dy;
            },
            onUp: () => el.classList.remove("dragging"),
          });
        }}
      >
        <div
          className="mini-map-sheet"
          style={{
            width: Math.max(layout.width * SCALE, size.w),
            height: Math.max(layout.height * SCALE, size.h),
          }}
        >
          <svg
            className="mini-map-svg"
            width={layout.width * SCALE}
            height={layout.height * SCALE}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            {layout.edges.map((edge) => (
              <path
                key={edge.key}
                d={edge.d}
                className={edge.ghost ? "mini-ghost" : "mini-tube"}
                stroke={edge.color}
              />
            ))}
            {layout.nodes.map((node) => (
              <g
                key={node.id}
                className={`mini-node${node.commit.hash === selected ? " selected" : ""}${
                  node.commit.hash === head ? " head" : ""
                }`}
                style={{ transform: `translate(${node.x}px, ${node.y}px)`, "--line": node.color } as CSSProperties}
                role="button"
                tabIndex={0}
                aria-label={node.commit.message}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!moved.current) onSelect(node.commit.hash);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(node.commit.hash);
                  }
                }}
              >
                <circle className="mini-hit" r={28} />
                <circle className="mini-halo" r={27} />
                {node.commit.hash === head && <circle className="mini-head" r={22} />}
                <circle className="mini-ball" r={14} />
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}
