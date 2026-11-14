import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clamp, prefersReducedMotion, trackDrag } from "./drag";
import {
  cullLayout,
  laneSpans,
  sameRange,
  scrollForWindow,
  visibleColumns,
  visibleWindow,
  withPinned,
  type ColumnRange,
  type GraphLayout,
  type GraphNode,
} from "./layout";
import "./details.css";

interface Props {
  layout: GraphLayout;
  selected: string | null;
  head: string | null;
  /** Keep this stable: the map is memoised and re-renders only when the graph or selection changes. */
  onSelect: (hash: string) => void;
}

const SCALE = 0.42;

/** Where the floating map sits (distance from the editor's right and bottom edges) and its size. */
export interface MapBox {
  right: number;
  bottom: number;
  w: number;
  h: number;
}

export const MAP_MIN = { w: 320, h: 200 };
export const MAP_MAX = { w: 900, h: 640 };
const EDGE = 8;

/**
 * Keeps the map within its size limits and inside the editor (`room`, the editor's
 * size): at least EDGE px from each side where there is space. `shownH` is the height
 * it really takes up, when that differs from `box.h` (folded down to its bar).
 */
export function fitMapBox(box: MapBox, room: { w: number; h: number } | null, shownH?: number): MapBox {
  const w = clamp(box.w, MAP_MIN.w, MAP_MAX.w);
  const h = clamp(box.h, MAP_MIN.h, MAP_MAX.h);
  const maxRight = room ? Math.max(EDGE, room.w - w - EDGE) : Infinity;
  const maxBottom = room ? Math.max(EDGE, room.h - (shownH ?? h) - EDGE) : Infinity;
  return { w, h, right: clamp(box.right, EDGE, maxRight), bottom: clamp(box.bottom, EDGE, maxBottom) };
}

/**
 * The map's box after a key on its move handle: arrows move it by `step`, Shift+arrows
 * resize it (Right and Up grow it, as the bottom-right corner stays put). Null for
 * any other key.
 */
export function nudgeMapBox(
  box: MapBox,
  key: string,
  shift: boolean,
  room: { w: number; h: number } | null,
  shownH?: number,
  step = 16,
): MapBox | null {
  const dirs: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const dir = dirs[key];
  if (!dir) return null;
  const [dx, dy] = dir;
  const next = shift
    ? { ...box, w: box.w + dx * step, h: box.h - dy * step }
    : { ...box, right: box.right - dx * step, bottom: box.bottom - dy * step };
  return fitMapBox(next, room, shift ? undefined : shownH);
}

/** The columns worth drawing when the map is scrolled `left` px across a `viewW`-px view. */
export function miniColumns(left: number, viewW: number, lastCol: number): ColumnRange {
  return visibleColumns(left, viewW, SCALE, 0, lastCol);
}

type NavNode = Pick<GraphNode, "col" | "x" | "y">;

/**
 * Where a key on a commit in the map moves the keyboard: Left and Right one column older
 * or newer, Up and Down to the nearest commit drawn above or below, Home and End to the
 * oldest and newest. `nodes` are in column order. Null for other keys and past either end.
 */
export function stepMapFocus<N extends NavNode>(nodes: readonly N[], from: N, key: string): N | null {
  const at = nodes[from.col] === from ? from.col : nodes.indexOf(from);
  if (at === -1) return null;
  const pick = (i: number) => (i >= 0 && i < nodes.length && i !== at ? nodes[i] : null);
  if (key === "ArrowLeft") return pick(at - 1);
  if (key === "ArrowRight") return pick(at + 1);
  if (key === "Home") return pick(0);
  if (key === "End") return pick(nodes.length - 1);
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  const up = key === "ArrowUp";
  let best: N | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const dy = n.y - from.y;
    if (up ? dy >= 0 : dy <= 0) continue;
    // Nearest on the page; a tie goes to the closer row.
    const d = (n.x - from.x) ** 2 + dy ** 2;
    if (d < bestD || (d === bestD && best && Math.abs(dy) < Math.abs(best.y - from.y))) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/** Large pannable commit map for the code editor — does not shrink to fit. */
export const MiniMap = memo(function MiniMap({ layout, selected, head, onSelect }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<MapBox>({ right: 16, bottom: 16, w: 520, h: 340 });
  const [folded, setFolded] = useState(false);
  const moved = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const keysHint = useId();
  const navHint = useId();

  /* ---------- keeping the chosen commit in view ---------- */
  const glide = useRef(0);
  // False until the view has been placed once (on open, and again after unfolding).
  const placed = useRef(false);
  const target = selected ?? head;
  const targetNode = target ? layout.byHash.get(target) : undefined;

  function stopGlide() {
    cancelAnimationFrame(glide.current);
    glide.current = 0;
  }

  /** Eases the view to a scroll position in 240ms, like the big map's glide. */
  function glideTo(el: HTMLElement, left: number, top: number) {
    stopGlide();
    const from = { left: el.scrollLeft, top: el.scrollTop };
    const to = {
      left: clamp(left, 0, Math.max(0, el.scrollWidth - el.clientWidth)),
      top: clamp(top, 0, Math.max(0, el.scrollHeight - el.clientHeight)),
    };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 240);
      const eased = 1 - (1 - t) ** 3;
      el.scrollLeft = from.left + (to.left - from.left) * eased;
      el.scrollTop = from.top + (to.top - from.top) * eased;
      glide.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    glide.current = requestAnimationFrame(step);
  }

  // Recentre only when the commit to show (or where it is drawn) changes, or the map is
  // unfolded; never while it is moved or resized. A commit already in view stays put,
  // so panning around is not undone by an unrelated graph refresh.
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    if (!targetNode) return syncRange();
    const x = targetNode.x * SCALE;
    const y = targetNode.y * SCALE;
    const left = x - el.clientWidth / 2;
    const top = y - el.clientHeight / 2;
    if (!placed.current || prefersReducedMotion()) {
      placed.current = true;
      stopGlide();
      el.scrollTo({ left, top, behavior: "auto" });
      // Drawn for where the view now is, even when that scroll fired no event (it was there).
      syncRange();
      return;
    }
    if (!inView(el, x, y)) glideTo(el, left, top);
  }, [target, targetNode?.x, targetNode?.y, folded]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Whether a point on the drawing (in map pixels) is comfortably inside the view. */
  function inView(el: HTMLElement, x: number, y: number) {
    const margin = 24;
    return (
      x >= el.scrollLeft + margin &&
      x <= el.scrollLeft + el.clientWidth - margin &&
      y >= el.scrollTop + margin &&
      y <= el.scrollTop + el.clientHeight - margin
    );
  }

  /** Brings a commit the keyboard moved to into view, centred, if it is not already. */
  function reveal(node: GraphNode) {
    const el = view.current;
    if (!el) return;
    const x = node.x * SCALE;
    const y = node.y * SCALE;
    if (inView(el, x, y)) return;
    const left = x - el.clientWidth / 2;
    const top = y - el.clientHeight / 2;
    if (prefersReducedMotion()) {
      stopGlide();
      el.scrollTo({ left, top, behavior: "auto" });
    } else glideTo(el, left, top);
  }

  useEffect(() => stopGlide, []);

  /* ---------- drawing only what is in view ----------
     Only the columns in view (plus a block either side) are drawn, as on the big map, so a
     history of tens of thousands of commits costs about one screenful. The range moves a
     block at a time, so panning re-renders only every few hundred pixels. */
  const lastCol = layout.nodes.length - 1;
  const [range, setRange] = useState<ColumnRange>(() =>
    miniColumns(targetNode ? Math.max(0, targetNode.x * SCALE - box.w / 2) : 0, box.w, lastCol),
  );
  const rangeRef = useRef(range);
  rangeRef.current = range;

  /** Re-reads which columns are in view; renders only when that moves to another block. */
  function syncRange() {
    const el = view.current;
    if (!el) return;
    const next = miniColumns(el.scrollLeft, el.clientWidth, layoutRef.current.nodes.length - 1);
    if (!sameRange(next, rangeRef.current)) {
      rangeRef.current = next;
      setRange(next);
    }
  }

  // A new graph or a resize; until the view is placed (just opened or unfolded), the range
  // was worked out for where it will be placed instead.
  // With no commit to place the view at, it is never "placed", so it syncs straight away.
  useLayoutEffect(() => {
    if (placed.current || !targetNode) syncRange();
  }, [layout, box.w, folded]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(
    () => cullLayout({ nodes: layout.nodes, edges: layout.edges, bridges: [] }, range),
    [layout, range],
  );

  /* ---------- one Tab stop (a roving tabindex) ----------
     The map is one stop: the commit the arrow keys last moved to, else the chosen one, else
     head (when drawn), else the middle of what is drawn. The arrows move the keyboard, not
     the choice (picking compares or reloads in the editor); Enter or Space picks. */
  const selectedNode = selected ? layout.byHash.get(selected) : undefined;
  const headNode = head ? layout.byHash.get(head) : undefined;
  const [rover, setRover] = useState<string | null>(null);
  // A new choice takes the stop back.
  const [roverFor, setRoverFor] = useState(selected);
  if (roverFor !== selected) {
    setRoverFor(selected);
    setRover(null);
  }
  const roverNode = rover ? layout.byHash.get(rover) : undefined;
  const tabNode =
    roverNode ??
    selectedNode ??
    (headNode && headNode.col >= range.from && headNode.col <= range.to ? headNode : undefined) ??
    shown.nodes[Math.floor(shown.nodes.length / 2)];
  const tabHash = tabNode?.commit.hash;
  // The commit to give focus to once it is drawn (set by the arrow keys).
  const focusTo = useRef<string | null>(null);

  useEffect(() => {
    const hash = focusTo.current;
    if (!hash) return;
    focusTo.current = null;
    const el = view.current?.querySelector<SVGGElement>(`.mini-node[data-hash="${hash}"]`);
    if (el && el !== document.activeElement) el.focus({ preventScroll: true });
    const node = layoutRef.current.byHash.get(hash);
    if (node) reveal(node);
  });

  /* ---------- the whole-history strip ----------
     Each branch row squeezed to one stroke, with a window showing the part the map
     above has on screen. Only shown when the map does not fit. */
  const strip = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const windowEl = useRef<HTMLDivElement>(null);
  const spans = useMemo(() => laneSpans(layout.nodes), [layout]);
  const overflows = layout.width * SCALE > box.w - 8 || layout.height * SCALE > box.h - 80;

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

  useLayoutEffect(syncWindow, [layout, box.w, box.h, overflows, folded]);

  /** Click the strip to glide the window there; drag (the window or anywhere) to pan along. */
  function onStripDown(e: ReactPointerEvent<HTMLDivElement>) {
    const el = view.current;
    if (!el || !track.current || e.button !== 0) return;
    stopGlide();
    const tb = track.current.getBoundingClientRect();
    const fx = (e.clientX - tb.left) / tb.width;
    const fy = (e.clientY - tb.top) / tb.height;
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
        go(fx + dx / tb.width, fy + dy / tb.height, "auto");
        syncRange();
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
    stopGlide();
    move();
  }

  /* ---------- moving and resizing ---------- */

  /** The editor's size, which the map has to stay inside. */
  function room() {
    const parent = root.current?.offsetParent as HTMLElement | null | undefined;
    return parent ? { w: parent.clientWidth, h: parent.clientHeight } : null;
  }

  /** The height the map takes up when folded down to its bar (otherwise its box height is used). */
  function shownHeight() {
    return folded ? root.current?.offsetHeight : undefined;
  }

  /**
   * Drags write the box straight to the element, so a pointermove never re-renders,
   * and commit it to state on release.
   */
  function dragBox(e: ReactPointerEvent, change: (start: MapBox, dx: number, dy: number) => MapBox) {
    const el = root.current;
    if (!el) return;
    const start = box;
    const bounds = room();
    const shownH = shownHeight();
    let last = start;
    trackDrag(e, {
      onMove: (dx, dy) => {
        last = fitMapBox(change(start, dx, dy), bounds, shownH);
        el.style.right = `${last.right}px`;
        el.style.bottom = `${last.bottom}px`;
        el.style.width = `${last.w}px`;
        if (!folded) el.style.height = `${last.h}px`;
        syncWindow();
        syncRange();
      },
      onUp: () => setBox(last),
    });
  }

  function onGripKey(e: ReactKeyboardEvent<HTMLElement>) {
    const { key, shiftKey } = e;
    const bounds = room();
    const shownH = shownHeight();
    if (!nudgeMapBox(box, key, shiftKey, bounds, shownH)) return;
    e.preventDefault();
    // From the latest box, so held-down (repeating) keys each take a step.
    setBox((b) => nudgeMapBox(b, key, shiftKey, bounds, shownH) ?? b);
  }

  /* ---------- picking commits: one handler for the whole drawing ---------- */

  function nodeHash(e: { target: EventTarget }) {
    return (e.target as Element).closest?.("[data-hash]")?.getAttribute("data-hash") ?? null;
  }

  function onDrawingClick(e: ReactMouseEvent<SVGSVGElement>) {
    const hash = nodeHash(e);
    if (!hash) return;
    e.stopPropagation();
    if (moved.current) return;
    setRover(hash);
    onSelectRef.current(hash);
  }

  // A commit Tabbed to becomes the Tab stop, so it stays drawn (and focused) when the map
  // is panned away from it, instead of being culled out from under the keyboard.
  function onDrawingFocus(e: ReactFocusEvent<SVGSVGElement>) {
    const hash = nodeHash(e);
    if (hash) setRover((prev) => (prev === hash ? prev : hash));
  }

  function onDrawingKey(e: ReactKeyboardEvent<SVGSVGElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const hash = nodeHash(e);
    if (!hash) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setRover(hash);
      onSelectRef.current(hash);
      return;
    }
    const nav = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!nav.includes(e.key)) return;
    // Handled even at either end, so the keys never scroll the view instead.
    e.preventDefault();
    const { nodes, byHash } = layoutRef.current;
    const from = byHash.get(hash);
    const next = from && stepMapFocus(nodes, from, e.key);
    if (!next) return;
    focusTo.current = next.commit.hash;
    setRover(next.commit.hash);
  }

  // Built only when the graph, the drawn columns, the selection or the Tab stop change,
  // so moving or resizing the map, or typing in the editor, never touches it.
  const drawing = useMemo(
    () => (
      <svg
        className="mini-map-svg"
        width={layout.width * SCALE}
        height={layout.height * SCALE}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label="Commits"
        aria-describedby={navHint}
        onClick={onDrawingClick}
        onKeyDown={onDrawingKey}
        onFocus={onDrawingFocus}
      >
        {shown.edges.map((edge) => (
          <path key={edge.key} d={edge.d} className={edge.ghost ? "mini-ghost" : "mini-tube"} stroke={edge.color} />
        ))}
        {/* The chosen commit and the Tab stop stay drawn when out of view, so focus never drops. */}
        {withPinned(shown.nodes, range, [selectedNode, tabNode]).nodes.map((node) => {
          const hash = node.commit.hash;
          return (
            <g
              key={node.id}
              data-hash={hash}
              className={`mini-node${hash === selected ? " selected" : ""}${hash === head ? " head" : ""}`}
              style={{ transform: `translate(${node.x}px, ${node.y}px)`, "--line": node.color } as CSSProperties}
              role="button"
              tabIndex={hash === tabHash ? 0 : -1}
              aria-pressed={hash === selected}
              aria-label={`${node.commit.message} (${node.commit.shortHash}${hash === head ? ", head" : ""})`}
            >
              <circle className="mini-hit" r={28} />
              <circle className="mini-halo" r={27} />
              {hash === head && <circle className="mini-head" r={22} />}
              <circle className="mini-ball" r={14} />
            </g>
          );
        })}
      </svg>
    ),
    // The handlers only read refs, so they need not rebuild the drawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, shown, range, selectedNode, tabNode, selected, head],
  );

  return (
    <div
      ref={root}
      className={`mini-map${folded ? " is-folded" : ""}`}
      role="region"
      aria-label="Commit map"
      style={{ width: box.w, height: folded ? undefined : box.h, right: box.right, bottom: box.bottom }}
    >
      <span id={navHint} className="details-sr-only">
        Arrow keys move between commits, Home and End go to either end, Enter picks one.
      </span>
      {!folded && (
        <div
          className="mini-map-resize"
          aria-hidden="true"
          onPointerDown={(e) => dragBox(e, (s, dx, dy) => ({ ...s, w: s.w - dx, h: s.h - dy }))}
        />
      )}
      <div
        className="mini-map-bar"
        onPointerDown={(e) => dragBox(e, (s, dx, dy) => ({ ...s, right: s.right - dx, bottom: s.bottom - dy }))}
      >
        <span
          className="mini-map-grip"
          role="button"
          aria-roledescription="move handle"
          aria-label="Move commit map"
          aria-describedby={keysHint}
          tabIndex={0}
          onKeyDown={onGripKey}
        >
          Map
        </span>
        <span className="mini-map-hint">
          <span className="mini-map-hint-pointer">drag · pan · top-left resize</span>
          <span className="mini-map-hint-keys" id={keysHint}>
            arrows move · shift+arrows resize
          </span>
        </span>
        <button
          type="button"
          className="mini-map-fold"
          aria-expanded={!folded}
          aria-label="Commit map"
          title={folded ? "Unfold the map" : "Fold the map down to this bar"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            // Unfolding places the view on the chosen commit again, without a glide.
            if (!folded) placed.current = false;
            else {
              // A bar moved up near the top while folded would put the unfolded map's bar
              // (its only drag handle) above the editor; fit the full height back in.
              const bounds = room();
              setBox((b) => fitMapBox(b, bounds));
            }
            setFolded(!folded);
          }}
        >
          <span aria-hidden="true">{folded ? "+" : "–"}</span>
        </button>
      </div>
      {!folded && (
        <div
          ref={view}
          className="mini-map-view"
          onScroll={() => {
            syncWindow();
            syncRange();
          }}
          onWheel={stopGlide}
          onPointerDown={(e) => {
            stopGlide();
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
            {drawing}
          </div>
        </div>
      )}
      {!folded && overflows && (
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
});
