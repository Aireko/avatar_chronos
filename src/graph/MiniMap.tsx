import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clamp, prefersReducedMotion, trackDrag } from "./drag";
import { laneSpans, scrollForWindow, visibleWindow, type GraphLayout } from "./layout";

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

  // The whole-history strip: each branch row squeezed to one stroke, with a window showing
  // the part the map above has on screen. Only shown when the map does not fit.
  const strip = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const windowEl = useRef<HTMLDivElement>(null);
  const spans = useMemo(() => laneSpans(layout.nodes), [layout]);
  const overflows = layout.width * SCALE > size.w - 8 || layout.height * SCALE > size.h - 80;
  const selectedNode = selected ? layout.byHash.get(selected) : undefined;
  const headNode = head ? layout.byHash.get(head) : undefined;

  /** Moves the window to match the map's scroll position. Straight to the DOM: scrolling never re-renders. */
  function syncWindow() {
    const el = view.current;
    const win = windowEl.current;
    if (!el || !win) return;
    const x = visibleWindow(el.scrollLeft, el.clientWidth, el.scrollWidth);
    const y = visibleWindow(el.scrollTop, el.clientHeight, el.scrollHeight);
    win.style.left = `${x.start * 100}%`;
    win.style.width = `${x.size * 100}%`;
    win.style.top = `${y.start * 100}%`;
    win.style.height = `${y.size * 100}%`;
    strip.current?.setAttribute("aria-valuenow", String(x.size >= 1 ? 0 : Math.round((x.start / (1 - x.size)) * 100)));
  }

  useLayoutEffect(syncWindow, [layout, size, overflows]);

  /** Click the strip to glide the window there; drag (the window or anywhere) to pan along. */
  function onStripDown(e: ReactPointerEvent<HTMLDivElement>) {
    const el = view.current;
    if (!el || !track.current || e.button !== 0) return;
    const box = track.current.getBoundingClientRect();
    const fx = (e.clientX - box.left) / box.width;
    const fy = (e.clientY - box.top) / box.height;
    const x = visibleWindow(el.scrollLeft, el.clientWidth, el.scrollWidth);
    const y = visibleWindow(el.scrollTop, el.clientHeight, el.scrollHeight);
    const inside = fx >= x.start && fx <= x.start + x.size && fy >= y.start && fy <= y.start + y.size;
    // Grabbing the window keeps the pointer where it took hold; elsewhere centres the window on it.
    const off = inside ? { x: fx - x.start, y: fy - y.start } : { x: x.size / 2, y: y.size / 2 };
    const go = (px: number, py: number, behavior: ScrollBehavior) =>
      el.scrollTo({
        left: scrollForWindow(px - off.x, el.clientWidth, el.scrollWidth),
        top: scrollForWindow(py - off.y, el.clientHeight, el.scrollHeight),
        behavior,
      });
    if (!inside) go(fx, fy, prefersReducedMotion() ? "auto" : "smooth");
    const bar = e.currentTarget;
    bar.focus({ preventScroll: true });
    trackDrag(e, {
      slop: 2,
      onMove: (dx, dy, did) => {
        if (!did) return;
        bar.classList.add("dragging");
        go(fx + dx / box.width, fy + dy / box.height, "auto");
      },
      onUp: () => bar.classList.remove("dragging"),
    });
  }

  /** Arrow keys pan by half a view, Page keys by a whole one, Home/End jump to either end. */
  function onStripKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const el = view.current;
    if (!el) return;
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    const half = { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const moves: Record<string, () => void> = {
      ArrowLeft: () => el.scrollBy({ left: -half.x, behavior }),
      ArrowRight: () => el.scrollBy({ left: half.x, behavior }),
      ArrowUp: () => el.scrollBy({ top: -half.y, behavior }),
      ArrowDown: () => el.scrollBy({ top: half.y, behavior }),
      PageUp: () => el.scrollBy({ left: -el.clientWidth, behavior }),
      PageDown: () => el.scrollBy({ left: el.clientWidth, behavior }),
      Home: () => el.scrollTo({ left: 0, behavior }),
      End: () => el.scrollTo({ left: el.scrollWidth, behavior }),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    move();
  }

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
        onScroll={syncWindow}
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
        {/* At least as big as the view (CSS), and no bigger than the drawing, so the overview
            strip's window matches what is really scrollable. */}
        <div className="mini-map-sheet" style={{ width: layout.width * SCALE, height: layout.height * SCALE }}>
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
      {overflows && (
        <div
          ref={strip}
          className="mini-strip"
          role="slider"
          tabIndex={0}
          aria-label="Position in history"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          title="Click or drag to move around the history"
          onPointerDown={onStripDown}
          onKeyDown={onStripKey}
        >
          <div ref={track} className="mini-strip-track">
            <svg
              className="mini-strip-svg"
              viewBox={`0 0 ${Math.max(1, layout.width)} ${Math.max(1, layout.height)}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {spans.map((span) => (
                <line
                  key={span.key}
                  className="mini-strip-lane"
                  x1={span.x1}
                  x2={span.x2}
                  y1={span.y}
                  y2={span.y}
                  stroke={span.color}
                />
              ))}
              {headNode && (
                <line className="mini-strip-head" x1={headNode.x} x2={headNode.x} y1={0} y2={layout.height} />
              )}
              {selectedNode && (
                <line className="mini-strip-pick" x1={selectedNode.x} x2={selectedNode.x} y1={0} y2={layout.height} />
              )}
            </svg>
            <div ref={windowEl} className="mini-strip-window" />
          </div>
        </div>
      )}
    </div>
  );
}
