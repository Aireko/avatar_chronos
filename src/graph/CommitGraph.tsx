import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import type { ChronosGraph } from "../backend";
import {
  STATION_R,
  cameraAt,
  NO_DRAW,
  cullLayout,
  drawDelay,
  drawInWindow,
  entrances,
  fitAxis,
  fitZoom,
  glideMs,
  legendRows,
  sameRange,
  scribbleLoop,
  visibleColumns,
  wheelZoomFactor,
  withPinned,
  type CameraShot,
  type ColumnRange,
  type DrawAttr,
  type GraphLayout,
  type GraphNode,
  type Lane,
} from "./layout";
import { scopeNoun, type Scope } from "./scope";
import { Presence } from "../tools/Presence";
import { prefersReducedMotion } from "./drag";

export type PanelMode = "details" | "diff" | "rebase";

interface Props {
  graph: ChronosGraph;
  layout: GraphLayout;
  selected: string | null;
  panelOpen: boolean;
  onSelect: (hash: string | null) => void;
  onAction: (mode: PanelMode) => void;
  scope: Scope;
  gone: Set<string>;
  currentBranch: string | null;
  /** Fade every commit not by this author (exactly as the graph data names them). */
  highlightAuthor?: string | null;
  /** Commits the find bar matched; they get a light highlighter mark. */
  findMarks?: readonly string[];
}

const R = STATION_R;
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 2.4;
const ZOOM_STEP = 0.12;
/** How long a zoom key or button takes to glide to its new zoom; long pans take up to PAN_MS. */
const ZOOM_MS = 200;
const PAN_MS = 280;
/** Room kept clear around the history when fitting it all in. */
const FIT_MARGIN = 24;
/** Extra space around the graph so you can drag past the edges. */
const MAP_PAD = 280;
/** More find matches than this are not marked: past that, the marks stop giving an overview. */
const MAX_FIND_MARKS = 600;
/** Stations land a little after their lines; crossing hops land last. */
const STATION_LAG = 320;
const BRIDGE_LAG = 400;
/** The marker loop round a commit the map just flew to: drawn, held, then faded (see .landing). */
const LANDING_MS = 1100;
const LANDING_R = 30;

/** Keeps a zoom in range, rounded to a whole percent unless `exact` (pinch and wheel steps). */
function clampZoom(z: number, exact = false) {
  const kept = exact ? Math.round(z * 10000) / 10000 : Math.round(z * 100) / 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, kept));
}

/**
 * The draw-in for one opening of the map, on the performance.now() clock. When a map opens,
 * the columns around head get staggered start times; everything else is simply there. An
 * element that appears later (a new commit, a replayed line) starts drawing the moment its
 * layout arrives. Nothing else ever animates in, so a reload or rebase that shifts columns
 * never restarts an old element's animation, and a line that is culled and drawn again
 * (panned away and back) mid-intro picks up where it was instead of starting over.
 */
interface Intro {
  repo: string;
  /** When each element's draw-in starts, keyed "n:id", "e:key" or "b:key". Only a few are here. */
  born: Map<string, number>;
  seenNodes: Set<string>;
  seenEdges: Set<string>;
  seenBridges: Set<string>;
}

/** Starts the draw-in for a newly opened repository. */
function openIntro(graph: ChronosGraph, layout: GraphLayout, zoom: number, now: number): Intro {
  const lastCol = layout.nodes.length - 1;
  const focus = (graph.head ? layout.byHash.get(graph.head)?.col : undefined) ?? lastCol;
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const win = drawInWindow(focus, lastCol, width, zoom);
  const born = new Map<string, number>();
  for (const n of layout.nodes.slice(Math.max(0, win.from), win.to + 1)) {
    const d = drawDelay(win, n.col);
    if (d !== null) born.set(`n:${n.id}`, now + d);
  }
  for (const e of layout.edges) {
    const d = drawDelay(win, e.order);
    if (d !== null) born.set(`e:${e.key}`, now + d);
  }
  for (const b of layout.bridges) {
    const d = drawDelay(win, b.order);
    if (d !== null) born.set(`b:${b.key}`, now + d);
  }
  return {
    repo: graph.repoPath,
    born,
    seenNodes: new Set(layout.nodes.map((n) => n.id)),
    seenEdges: new Set(layout.edges.map((e) => e.key)),
    seenBridges: new Set(layout.bridges.map((b) => b.key)),
  };
}

/** A new layout of the same repository: whatever was not there before draws in now. */
function updateIntro(intro: Intro, layout: GraphLayout, now: number) {
  for (const [key, start] of intro.born) if (start < now - 5000) intro.born.delete(key);
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const bridges = new Set<string>();
  for (const n of layout.nodes) {
    nodes.add(n.id);
    if (!intro.seenNodes.has(n.id) && !intro.born.has(`n:${n.id}`)) intro.born.set(`n:${n.id}`, now);
  }
  for (const e of layout.edges) {
    edges.add(e.key);
    if (!intro.seenEdges.has(e.key) && !intro.born.has(`e:${e.key}`)) intro.born.set(`e:${e.key}`, now);
  }
  for (const b of layout.bridges) {
    bridges.add(b.key);
    if (!intro.seenBridges.has(b.key) && !intro.born.has(`b:${b.key}`)) intro.born.set(`b:${b.key}`, now);
  }
  intro.seenNodes = nodes;
  intro.seenEdges = edges;
  intro.seenBridges = bridges;
}

/** A function whose identity never changes but which always runs the latest `fn`. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useState(() => (...args: A) => ref.current(...args))[0];
}

export function CommitGraph({
  graph,
  layout,
  selected,
  panelOpen,
  scope,
  gone,
  currentBranch,
  highlightAuthor = null,
  findMarks,
  onSelect,
  onAction,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const sheetEl = useRef<HTMLDivElement>(null);
  const zoomEl = useRef<HTMLDivElement>(null);
  const drag = useRef({ moved: false });
  const shownRepo = useRef<string | null>(null);
  // `zoom` is what React last drew; `goal` is where a gliding zoom is heading (shown on the keys).
  const [zoom, setZoom] = useState(1);
  const [goal, setGoal] = useState(1);
  const [legendOpen, setLegendOpen] = useState(true);
  const [focusLane, setFocusLane] = useState<number | null>(null);
  // The commit holding keyboard focus, kept drawn even when panned off screen.
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  // The commit the map just flew to (legend, head key), ringed for a moment. `n` restarts the ink.
  const [landing, setLanding] = useState<{ hash: string; n: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The zoom currently on screen, which differs from `zoom` while a glide runs. */
  const liveZoom = useRef(zoom);
  /** The running glide and where it will end (zoom and scroll), so new moves can chain onto it. */
  const cam = useRef<{ raf: number; zoom: number; left: number; top: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // The window listeners are set up once, so they read the latest props through this.
  const latest = useRef({ layout, selected });
  latest.current = { layout, selected };
  const sheetW = layout.width + MAP_PAD * 2;
  const sheetH = layout.height + MAP_PAD * 2;
  const sheetSize = useRef({ w: sheetW, h: sheetH });
  sheetSize.current = { w: sheetW, h: sheetH };

  // A fresh draw-in for each repository (the component itself remounts when the scope
  // changes); each later layout of it only draws in what is new. Re-running this for the same
  // layout changes nothing, so it is safe in a memo.
  const intro = useRef<Intro | null>(null);
  // How each drawn line and commit enters, kept while it stays drawn (see `lineAttrs` below).
  const lineCache = useRef(new Map<string, DrawAttr>());
  const nodeCache = useRef(new Map<string, DrawAttr>());
  useMemo(() => {
    const now = performance.now();
    if (!intro.current || intro.current.repo !== graph.repoPath) {
      intro.current = openIntro(graph, layout, zoomRef.current, now);
      // Another repository (a clone or worktree can share commits): forget the old entrances.
      lineCache.current = new Map();
      nodeCache.current = new Map();
    } else {
      updateIntro(intro.current, layout, now);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, graph.repoPath]);

  // Only the columns on screen (plus a block either side) are drawn, so a history of tens of
  // thousands of commits costs about as much as one screenful. The range moves a block at a time.
  const lastCol = layout.nodes.length - 1;
  const [range, setRange] = useState<ColumnRange>(() => {
    const node = (graph.head ? layout.byHash.get(graph.head) : undefined) ?? layout.nodes[lastCol];
    const w = typeof window === "undefined" ? 1280 : window.innerWidth;
    const left = node ? Math.max(0, node.x + MAP_PAD - w / 2) : 0;
    return visibleColumns(left, w, 1, MAP_PAD, lastCol);
  });
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const lastColRef = useRef(lastCol);
  lastColRef.current = lastCol;

  /** Re-reads which columns are on screen; renders only when that moves to another block. */
  function syncRange() {
    const el = viewport.current;
    if (!el) return;
    const next = visibleColumns(el.scrollLeft, el.clientWidth, liveZoom.current, MAP_PAD, lastColRef.current);
    if (!sameRange(next, rangeRef.current)) {
      rangeRef.current = next;
      setRange(next);
    }
  }

  /** Draws the map at zoom `z` straight onto the DOM, without a React render. */
  function paintZoom(z: number) {
    liveZoom.current = z;
    const { w, h } = sheetSize.current;
    if (sheetEl.current) {
      sheetEl.current.style.width = `${w * z}px`;
      sheetEl.current.style.height = `${h * z}px`;
    }
    if (zoomEl.current) zoomEl.current.style.transform = `scale(${z})`;
  }

  function cancelFrame() {
    if (cam.current) cancelAnimationFrame(cam.current.raf);
    cam.current = null;
  }

  /** Stops a glide where it is (the user took hold of the map) and hands its zoom to React. */
  function stopCamera() {
    if (!cam.current) return;
    cancelFrame();
    const z = liveZoom.current;
    if (z !== zoomRef.current) setZoom(z);
    setGoal(z);
  }

  /** Where the map is heading: the end of a running glide, or where it is now. */
  function dest() {
    if (cam.current) return cam.current;
    const el = viewport.current;
    return { zoom: liveZoom.current, left: el?.scrollLeft ?? 0, top: el?.scrollTop ?? 0 };
  }

  /**
   * Glides the map so content point (to.x, to.y), in unzoomed sheet pixels, ends at screen
   * point `anchor` (default: the middle of the view) at zoom `to.zoom`. There is only ever one
   * glide: a new move starts from wherever the running one has got to, so a pan that begins
   * during a zoom (or the other way round) carries on smoothly instead of being overwritten.
   */
  function flyTo(
    to: CameraShot,
    opts: { anchor?: { x: number; y: number }; instant?: boolean; onLand?: () => void } = {},
  ) {
    const el = viewport.current;
    cancelFrame();
    setGoal(to.zoom);
    if (!el) {
      liveZoom.current = to.zoom;
      setZoom(to.zoom);
      opts.onLand?.();
      return;
    }
    const ax = opts.anchor?.x ?? el.clientWidth / 2;
    const ay = opts.anchor?.y ?? el.clientHeight / 2;
    // End where the browser can actually scroll to, so the glide never runs into an edge.
    const { w, h } = sheetSize.current;
    const left = Math.min(Math.max(0, w * to.zoom - el.clientWidth), Math.max(0, to.x * to.zoom - ax));
    const top = Math.min(Math.max(0, h * to.zoom - el.clientHeight), Math.max(0, to.y * to.zoom - ay));
    const end: CameraShot = { zoom: to.zoom, x: (left + ax) / to.zoom, y: (top + ay) / to.zoom };
    const z0 = liveZoom.current;
    const from: CameraShot = { zoom: z0, x: (el.scrollLeft + ax) / z0, y: (el.scrollTop + ay) / z0 };

    const place = (shot: CameraShot) => {
      if (shot.zoom !== liveZoom.current) paintZoom(shot.zoom);
      el.scrollLeft = shot.x * shot.zoom - ax;
      el.scrollTop = shot.y * shot.zoom - ay;
      // A zoom with the scroll pinned at 0 fires no scroll event, so check the range here too.
      syncRange();
    };
    const land = () => {
      cam.current = null;
      place(end);
      if (end.zoom !== zoomRef.current) setZoom(end.zoom);
      opts.onLand?.();
    };
    if (opts.instant || prefersReducedMotion()) {
      land();
      return;
    }

    // Scale and scroll frame by frame, then hand the final zoom to React. The drawing itself
    // is memoised, so only the sheet's frame is touched while the glide runs.
    const ms = glideMs(from, end, ZOOM_MS, PAN_MS);
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / ms;
      if (t >= 1) {
        land();
        return;
      }
      place(cameraAt(from, end, t));
      cam.current = { raf: requestAnimationFrame(step), zoom: end.zoom, left, top };
    };
    cam.current = { raf: requestAnimationFrame(step), zoom: end.zoom, left, top };
  }

  /** Where the zoom is heading: the end of a running glide, or the current zoom. */
  const targetZoom = () => dest().zoom;

  /** Zoom keys hold the chosen commit still when it is on screen, else the middle of the view. */
  function keyAnchor(): { x: number; y: number } | undefined {
    const el = viewport.current;
    const { layout: now, selected: picked } = latest.current;
    const node = el && picked ? now.byHash.get(picked) : undefined;
    if (!el || !node) return undefined;
    const d = dest();
    const x = (node.x + MAP_PAD) * d.zoom - d.left;
    const y = (node.y + MAP_PAD) * d.zoom - d.top;
    return x > 0 && x < el.clientWidth && y > 0 && y < el.clientHeight ? { x, y } : undefined;
  }

  /**
   * Zooms to `next`, keeping `anchor` (a point in the view) still. `exact` keeps the zoom as
   * given instead of rounding it to a whole percent, so many small pinch steps add up.
   */
  function applyZoom(next: number, anchor?: { x: number; y: number }, opts: { smooth?: boolean; exact?: boolean } = {}) {
    const el = viewport.current;
    const z = clampZoom(next, opts.exact);
    const d = dest();
    if (z === d.zoom) {
      if (!cam.current && z !== zoomRef.current) setZoom(z);
      setGoal(z);
      return;
    }
    if (!el) {
      flyTo({ zoom: z, x: 0, y: 0 });
      return;
    }
    const a = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    // The content under the anchor where the map is heading, so a zoom during a pan chains onto it.
    flyTo({ zoom: z, x: (d.left + a.x) / d.zoom, y: (d.top + a.y) / d.zoom }, { anchor: a, instant: !opts.smooth });
  }

  useEffect(() => cancelFrame, []);

  // Panning, resizing and new layouts move the drawn range.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    el.addEventListener("scroll", syncRange, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => syncRange());
    resize?.observe(el);
    return () => {
      el.removeEventListener("scroll", syncRange);
      resize?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    syncRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Trackpad/mouse: free 2D pan. Shift+wheel pans horizontally. Ctrl/Cmd+wheel (and pinch)
  // glides the zoom about the cursor; each event retargets the glide, so a burst stays smooth.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        applyZoom(
          targetZoom() * wheelZoomFactor(e.deltaY, e.deltaMode),
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          { smooth: true, exact: true },
        );
        return;
      }
      stopCamera();
      if (e.shiftKey) {
        el.scrollLeft += e.deltaY || e.deltaX;
      } else {
        el.scrollLeft += e.deltaX;
        el.scrollTop += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // +/- on the keyboard zoom the map: not while typing, and not from a drawer, the terminal,
  // the scope picker or a dialog, whose keys belong to them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (e.defaultPrevented || e.altKey) return;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      if (t instanceof Element && t.closest('.slide-panel, .dock-panel, .scope-pop, [role="dialog"]')) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        applyZoom(targetZoom() + ZOOM_STEP, keyAnchor(), { smooth: true });
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        applyZoom(targetZoom() - ZOOM_STEP, keyAnchor(), { smooth: true });
      } else if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        applyZoom(1, keyAnchor(), { smooth: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Pans (at the zoom the map is heading for) so the map point (x, y) sits mid-view. */
  function scrollToPoint(x: number, y: number, opts: { instant?: boolean; onLand?: () => void } = {}) {
    flyTo({ zoom: targetZoom(), x: x + MAP_PAD, y: y + MAP_PAD }, opts);
  }

  // Ring a commit once the map has flown to it, so the eye finds where it landed.
  const ring = (hash: string) => setLanding((prev) => ({ hash, n: (prev?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!landing) return;
    const timer = window.setTimeout(() => setLanding(null), LANDING_MS);
    return () => window.clearTimeout(timer);
  }, [landing]);

  // A new repository opens at its newest commits. When head moves (after a rebase), follow it.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    if (shownRepo.current !== graph.repoPath) {
      shownRepo.current = graph.repoPath;
      const node = graph.head ? layout.byHash.get(graph.head) : layout.nodes[layout.nodes.length - 1];
      if (node) scrollToPoint(node.x, node.y, { instant: true });
      else {
        el.scrollLeft = el.scrollWidth;
        el.scrollTop = MAP_PAD * zoomRef.current;
      }
      return;
    }
    const node = graph.head ? layout.byHash.get(graph.head) : undefined;
    if (node) scrollToPoint(node.x, node.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.repoPath, graph.head]);

  // Bring the selected commit into view when it is off screen (judged by where the map is heading).
  useEffect(() => {
    const el = viewport.current;
    const node = selected ? layout.byHash.get(selected) : undefined;
    if (!el || !node) return;
    const d = dest();
    const x = (node.x + MAP_PAD) * d.zoom;
    const y = (node.y + MAP_PAD) * d.zoom;
    const offX = x < d.left + 150 || x > d.left + el.clientWidth - 150;
    const offY = y < d.top + 130 || y > d.top + el.clientHeight - 80;
    if (offX || offY) scrollToPoint(node.x, node.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, panelOpen]);

  // Drag anywhere to pan freely (including up/down). A drag never counts as a click.
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    if (e.target === el && (e.nativeEvent.offsetX >= el.clientWidth || e.nativeEvent.offsetY >= el.clientHeight)) {
      // A scrollbar: let it take over from any glide.
      stopCamera();
      return;
    }
    const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    drag.current.moved = false;
    const move = (ev: PointerEvent) => {
      if (!drag.current.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      // Holding the map stops a glide where it is (including one that began mid-drag, such as a
      // head-follow), and the drag carries on from there instead of fighting it frame by frame.
      if (cam.current) {
        stopCamera();
        start.x = ev.clientX;
        start.y = ev.clientY;
        start.left = el.scrollLeft;
        start.top = el.scrollTop;
      }
      drag.current.moved = true;
      el.classList.add("dragging");
      el.scrollLeft = start.left - (ev.clientX - start.x);
      el.scrollTop = start.top - (ev.clientY - start.y);
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** The legend points at a branch: glide to its newest commit and ring it. */
  const showLane = useStable((lane: Lane) => {
    const node = layout.byHash.get(lane.tip);
    if (node) scrollToPoint(node.x, node.y, { onLand: () => ring(node.commit.hash) });
  });

  /** Head, or the newest commit when head is not on this map. */
  const homeNode = (graph.head ? layout.byHash.get(graph.head) : undefined) ?? layout.nodes[layout.nodes.length - 1];
  const homeIsHead = !!homeNode && homeNode.commit.hash === graph.head;

  function goHome() {
    if (homeNode) scrollToPoint(homeNode.x, homeNode.y, { onLand: () => ring(homeNode.commit.hash) });
  }

  // One small number per author, written on each commit as data-author. Highlighting an
  // author is then one generated CSS rule, never a re-render of thousands of circles.
  const authorIds = useMemo(() => {
    const ids = new Map<string, number>();
    for (const n of layout.nodes) if (!ids.has(n.commit.author)) ids.set(n.commit.author, ids.size);
    return ids;
  }, [layout]);

  const focusCss = useMemo(() => {
    const rules: string[] = [];
    if (highlightAuthor !== null) {
      // An author with no commits in view fades everything (-1 is on no commit).
      const id = authorIds.get(highlightAuthor) ?? -1;
      // Find marks under another author's commits fade with them.
      rules.push(
        `.map-svg .node:not([data-author="${id}"]):not(.selected), .map-svg .find-marks .find-mark:not([data-author="${id}"]) { opacity: 0.18; }`,
      );
      // The lines stay, a little lighter (dotted ghost lines start at 0.55).
      rules.push(".map-svg .tube, .map-svg .bridge-line { opacity: 0.6; }");
      rules.push(".map-svg .tube-ghost { opacity: 0.33; }");
    }
    return rules.join("\n");
  }, [highlightAuthor, authorIds]);

  // Find matches: a highlighter blob under each one (find.css), drawn as its own small
  // overlay between the lines and the stations. New matches re-render only these few
  // hundred paths, never the drawing, and no stylesheet is matched against every commit.
  // Like the stations, only matches in the drawn column range (or the focused commit,
  // which stays drawn) get a mark, so the cap counts what is on screen.
  const findOverlay = useMemo(() => {
    if (!findMarks || findMarks.length === 0) return null;
    const marks: ReactElement[] = [];
    for (const hash of findMarks) {
      if (marks.length >= MAX_FIND_MARKS) break;
      // The selected commit has its own halo.
      if (hash === selected) continue;
      const node = layout.byHash.get(hash);
      if (!node) continue;
      if ((node.col < range.from || node.col > range.to) && hash !== focusedHash) continue;
      marks.push(
        <path
          key={node.id}
          className="find-mark"
          d={node.halo}
          data-lane={node.lane}
          data-author={authorIds.get(node.commit.author)}
          // Same glide as the stations when the layout changes.
          style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
        />,
      );
    }
    return (
      <g className="find-marks" aria-hidden="true">
        {marks}
      </g>
    );
  }, [findMarks, selected, layout, authorIds, range, focusedHash]);

  /** Zoom out (never in past 100%) until the whole history fits, or as far out as the map goes. */
  function fitAll() {
    const el = viewport.current;
    if (!el || layout.nodes.length === 0) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const z = fitZoom(layout.width, layout.height, vw, vh, FIT_MARGIN, ZOOM_MIN, 1);
    const d = dest();
    flyTo({
      zoom: z,
      x: fitAxis(MAP_PAD, MAP_PAD + layout.width, vw, FIT_MARGIN, z, (d.left + vw / 2) / d.zoom),
      y: fitAxis(MAP_PAD, MAP_PAD + layout.height, vh, FIT_MARGIN, z, (d.top + vh / 2) / d.zoom),
    });
  }

  // What is drawn: the nodes in the column range and the lines and hops that reach into it.
  const view = useMemo(() => cullLayout(layout, range), [layout, range]);

  // The chosen commit and the one holding keyboard focus stay drawn (and focusable) when they
  // are off screen, so a wheel pan never drops focus onto the page (see withPinned).
  const selectedNode = selected ? layout.byHash.get(selected) : undefined;
  const focusedNode = focusedHash ? layout.byHash.get(focusedHash) : undefined;
  const pinned = withPinned(view.nodes, range, [selectedNode, focusedNode]);
  const drawnNodes = pinned.nodes;
  const pinnedKey = pinned.outside.map((n) => n.id).join(" ");

  // How each drawn element enters. Worked out once when it is first drawn and then kept for
  // as long as it stays drawn, so a later render never changes a running animation's delay.
  // Lines and commits keep separate books, so pinning a commit never rebuilds the lines.
  const lineAttrs = useMemo(() => {
    const take = entrances(lineCache.current, intro.current?.born);
    for (const e of view.edges) take(`e:${e.key}`);
    for (const b of view.bridges) take(`b:${b.key}`, BRIDGE_LAG);
    lineCache.current = take.kept;
    return take.kept;
  }, [view]);
  const nodeAttrs = useMemo(() => {
    const take = entrances(nodeCache.current, intro.current?.born);
    // A pinned commit outside the range is booked too, so it does not replay its draw-in
    // when a pan brings it back into the range.
    for (const n of drawnNodes) take(`n:${n.id}`, STATION_LAG);
    nodeCache.current = take.kept;
    return take.kept;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, pinnedKey]);

  // The lines only change with the history and the drawn range. Selecting, zooming, panning
  // within a block and pointing at the legend re-render this component without touching them.
  const lines = useMemo(() => {
    const solid = view.edges.filter((e) => !e.ghost);
    const ghosts = view.edges.filter((e) => e.ghost);
    const at = (key: string) => lineAttrs.get(key) ?? NO_DRAW;
    return (
      <>
        {ghosts.map((edge) => {
          const a = at(`e:${edge.key}`);
          return (
            <path
              key={edge.key}
              d={edge.d}
              pathLength={1}
              className={`tube-ghost${a.cls}`}
              data-lane={edge.lane}
              style={{ d: `path("${edge.d}")`, stroke: edge.color, animationDelay: a.delay } as CSSProperties}
            />
          );
        })}
        {/* Paper-coloured casings first, then the pen lines, so joins stay clean. */}
        {solid.map((edge) => {
          const a = at(`e:${edge.key}`);
          return (
            <path
              key={`c-${edge.key}`}
              d={edge.d}
              pathLength={1}
              className={`tube-casing${a.cls}`}
              style={{ d: `path("${edge.d}")`, animationDelay: a.delay } as CSSProperties}
            />
          );
        })}
        {solid.map((edge) => {
          const a = at(`e:${edge.key}`);
          return (
            <path
              key={`f-${edge.key}`}
              d={edge.d}
              pathLength={1}
              className={`tube${a.cls}`}
              data-lane={edge.lane}
              style={{ d: `path("${edge.d}")`, animationDelay: a.delay, stroke: edge.color } as CSSProperties}
            />
          );
        })}
        {/* Where a line crosses another branch's row, it hops over with a small gap. The hop is
            placed by a transform, so it glides with its line when a rebase moves it. */}
        {view.bridges.map((bridge) => {
          const a = at(`b:${bridge.key}`);
          return (
            <g
              key={bridge.key}
              className={`bridge${a.cls}`}
              style={{ transform: `translate(${bridge.x}px, ${bridge.y}px)`, animationDelay: a.delay }}
            >
              <line className="bridge-gap" x1={0} x2={0} y1={-9} y2={9} />
              <line
                className="bridge-line"
                data-lane={bridge.lane}
                x1={0}
                x2={0}
                y1={-12}
                y2={12}
                style={{ stroke: bridge.color }}
              />
            </g>
          );
        })}
      </>
    );
  }, [view, lineAttrs]);

  // One Tab stop for the whole map (a roving tabindex): the chosen commit, else head, else the
  // commit in the middle of what is drawn. Arrow keys (in App) move the choice, and focus follows.
  const headNode = graph.head ? layout.byHash.get(graph.head) : undefined;
  const tabHash =
    selectedNode?.commit.hash ??
    focusedNode?.commit.hash ??
    (headNode && headNode.col >= range.from && headNode.col <= range.to ? headNode.commit.hash : undefined) ??
    view.nodes[Math.floor(view.nodes.length / 2)]?.commit.hash;

  const pickStation = useStable((hash: string, click: boolean) => {
    if (click && drag.current.moved) return;
    onSelectRef.current(hash);
  });

  // When the selection moves while focus is on the map (arrow keys, or Enter on a commit),
  // focus moves with it, so the focus ring, Enter and screen readers all follow the halo.
  // Read during render: by the effect, a re-keyed action bar may already have dropped focus.
  const prevSelected = useRef(selected);
  const focusWasInMap = useRef(false);
  if (prevSelected.current !== selected) {
    prevSelected.current = selected;
    const active = typeof document === "undefined" ? null : document.activeElement;
    focusWasInMap.current = !!active && !!viewport.current?.contains(active);
  }
  useEffect(() => {
    const was = focusWasInMap.current;
    focusWasInMap.current = false;
    if (!was || !selected) return;
    const active = document.activeElement;
    // Focus left on the page body only counts when it was dropped from the map just now.
    if (active && active !== document.body && !viewport.current?.contains(active)) return;
    focusStation(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  /** Puts keyboard focus on a commit's station; true when focus moved there. */
  function focusStation(hash: string): boolean {
    const el = viewport.current?.querySelector<SVGGElement>(`.node[data-hash="${hash}"]`);
    if (!el || el === document.activeElement) return false;
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  }

  const landingNode = landing ? layout.byHash.get(landing.hash) : undefined;
  const menuNode = selected && !panelOpen ? layout.byHash.get(selected) : undefined;
  const menuIsHead = menuNode?.commit.hash === graph.head;
  const scoped = scope.kind !== "project";
  const noun = scopeNoun(scope);
  const menuGone = !!menuNode && gone.has(menuNode.commit.hash);
  const menu: { mode: PanelMode; label: string; disabled: boolean; hint: string }[] = [
    { mode: "details", label: "Details", disabled: false, hint: "Author, date and changed files" },
    {
      mode: "diff",
      label: "Diff",
      disabled: menuIsHead,
      hint: menuIsHead
        ? "Nothing newer to compare"
        : scoped
          ? `What this ${noun} changed since this commit`
          : "What your branch changed since this commit",
    },
    {
      mode: "rebase",
      label: "Rebase",
      disabled: menuIsHead || (scoped ? menuGone : !currentBranch),
      hint: menuIsHead
        ? scoped
          ? "This is already the latest version"
          : "You are already on this commit"
        : scoped
          ? menuGone
            ? "It was deleted here"
            : `Rebase only this ${noun} onto this commit`
          : currentBranch
            ? `Rebase ${currentBranch} onto this commit`
            : "Check out a branch first",
    },
  ];

  return (
    <div className="map-wrap">
      {/* Author highlight: a few generated rules over the static drawing. */}
      {focusCss && <style>{focusCss}</style>}
      <div
        ref={viewport}
        className="map"
        onPointerDown={onPointerDown}
        onClick={() => {
          if (!drag.current.moved) onSelect(null);
        }}
      >
        <div ref={sheetEl} className="map-sheet" style={{ width: sheetW * zoom, height: sheetH * zoom }}>
          <div ref={zoomEl} className="map-zoom" style={{ width: sheetW, height: sheetH, transform: `scale(${zoom})` }}>
            <svg
              className="map-svg"
              width={layout.width}
              height={layout.height}
              style={{ left: MAP_PAD, top: MAP_PAD }}
              role="group"
              aria-label="Commit map"
              onFocus={(e) => setFocusedHash((e.target as Element).getAttribute("data-hash"))}
              onBlur={() => setFocusedHash(null)}
            >
              {/* Pointing at a branch in the legend fades every other line: one rule, for that lane only. */}
              {focusLane !== null && (
                <style>{`.map-svg [data-lane]:not([data-lane="${focusLane}"]) { opacity: 0.16; }`}</style>
              )}
              {lines}
              {findOverlay}
              {drawnNodes.map((node) => (
                <Station
                  key={node.id}
                  node={node}
                  selected={node === selectedNode}
                  tabbable={node.commit.hash === tabHash}
                  isHead={node.commit.hash === graph.head}
                  authorId={authorIds.get(node.commit.author)}
                  at={nodeAttrs.get(`n:${node.id}`) ?? NO_DRAW}
                  onPick={pickStation}
                />
              ))}
              {landingNode && (
                <g
                  key={landing!.n}
                  className="landing"
                  aria-hidden="true"
                  style={{ transform: `translate(${landingNode.x}px, ${landingNode.y}px)`, "--line": landingNode.color } as CSSProperties}
                >
                  <path className="landing-loop" d={scribbleLoop(LANDING_R, landingNode.id)} pathLength={1} />
                </g>
              )}
            </svg>

            {/* The action bar pops up from the chosen commit and drops away when it closes. */}
            <Presence show={!!menuNode} className="menu-layer" exitMs={120}>
              {menuNode && (
                <div
                  key={menuNode.id}
                  className="menu"
                  style={{
                    left: menuNode.x + MAP_PAD,
                    top: menuNode.y + MAP_PAD - (R + 34) - menuNode.flags.length * 25 - (menuIsHead ? 32 : 0),
                  }}
                  role="toolbar"
                  aria-label="Commit actions"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // Escape steps back to the commit (it stays chosen) instead of dropping the
                    // choice. Only when that actually moved focus is the key used up; otherwise
                    // App's Escape handling (closing a tool, the terminal, the choice) still runs.
                    if (e.key === "Escape" && focusStation(menuNode.commit.hash)) e.stopPropagation();
                  }}
                >
                  {menu.map((item) => (
                    <button key={item.mode} disabled={item.disabled} title={item.hint} onClick={() => onAction(item.mode)}>
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </Presence>
          </div>
        </div>
      </div>

      <div className="map-chrome">
        <div className={`branch-legend${legendOpen ? "" : " collapsed"}`} aria-label="Branch colors">
          <button
            type="button"
            className="legend-toggle"
            aria-expanded={legendOpen}
            onClick={() => {
              setFocusLane(null);
              setLegendOpen((v) => !v);
            }}
          >
            <span>Branches</span>
            <span className="legend-caret" aria-hidden="true">▾</span>
          </button>
          <Presence show={legendOpen} className="legend-drawer">
            <LegendList lanes={layout.lanes} onShow={showLane} onFocusLane={setFocusLane} />
          </Presence>
        </div>

        <div className="zoom-controls" role="toolbar" aria-orientation="vertical" aria-label="Map view">
          <button
            type="button"
            className="btn zoom-btn zoom-glyph"
            aria-label="Fit the whole history"
            title="Fit the whole history"
            disabled={layout.nodes.length === 0}
            onClick={fitAll}
          >
            <FitIcon />
          </button>
          <button
            type="button"
            className="btn zoom-btn zoom-glyph"
            aria-label={homeIsHead ? "Go to head" : "Go to the newest commit"}
            title={homeIsHead ? "Go to head" : "Go to the newest commit"}
            disabled={!homeNode}
            onClick={goHome}
          >
            <HeadIcon />
          </button>
          <span className="zoom-sep" aria-hidden="true" />
          {/* At either end of the range the key says so with aria-disabled rather than
              `disabled`, so a keyboard user pressing it to the limit keeps focus on it. */}
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Zoom in"
            title="Zoom in (+)"
            aria-disabled={goal >= ZOOM_MAX || undefined}
            onClick={() => {
              if (goal < ZOOM_MAX) applyZoom(targetZoom() + ZOOM_STEP, keyAnchor(), { smooth: true });
            }}
          >
            +
          </button>
          <button
            type="button"
            className="btn zoom-btn zoom-reset"
            aria-label={`Reset zoom, now ${Math.round(goal * 100)}%`}
            title="Reset zoom (Ctrl+0)"
            onClick={() => applyZoom(1, keyAnchor(), { smooth: true })}
          >
            {/* Ticks over once per 10% band: every 12% key step crosses one, but a pinch (many
                ~1% steps) does not restart the fade-in on each event and leave the readout dim. */}
            <span key={Math.floor(goal * 10 + 1e-6)} className="zoom-level">
              {Math.round(goal * 100)}%
            </span>
          </button>
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Zoom out"
            title="Zoom out (−)"
            aria-disabled={goal <= ZOOM_MIN || undefined}
            onClick={() => {
              if (goal > ZOOM_MIN) applyZoom(targetZoom() - ZOOM_STEP, keyAnchor(), { smooth: true });
            }}
          >
            −
          </button>
        </div>
      </div>
    </div>
  );
}

interface StationProps {
  node: GraphNode;
  selected: boolean;
  /** The map's one Tab stop (roving tabindex); every other commit is reached with the arrow keys. */
  tabbable: boolean;
  isHead: boolean;
  at: DrawAttr;
  /** Small per-author number written as data-author; the author highlight is one CSS rule on it. */
  authorId: number | undefined;
  onPick: (hash: string, click: boolean) => void;
}

/**
 * One commit on the map. Memoised with stable props, so choosing a commit re-renders only the
 * old and the new choice, not every station on screen.
 */
const Station = memo(function Station({ node, selected, tabbable, isHead, at, authorId, onPick }: StationProps) {
  return (
    <g
      className={`node${selected ? " selected" : ""}${at.cls}`}
      data-lane={node.lane}
      data-hash={node.commit.hash}
      data-author={authorId}
      style={
        {
          transform: `translate(${node.x}px, ${node.y}px)`,
          "--line": node.color,
          "--d": at.delay,
        } as CSSProperties
      }
      tabIndex={tabbable ? 0 : -1}
      role="button"
      aria-pressed={selected}
      aria-label={isHead ? `${node.commit.message} (head)` : node.commit.message}
      onClick={(e) => {
        e.stopPropagation();
        onPick(node.commit.hash, true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(node.commit.hash, false);
        }
      }}
    >
      <title>{node.commit.message}</title>
      <circle className="node-hit" r={26} />
      <path className="halo" d={node.halo} />
      <g className="station">
        <path className="ring" d={node.shape} />
        {node.kind === "interchange" && <circle className="ring-core" r={3.6} />}
      </g>

      {isHead && (
        <g className="head-note">
          <text y={-(R + 24)}>head</text>
          <path d={`M 1 ${-(R + 19)} q 3 5 -1 11 m -5 -5 q 3 4 5 6 q 3 -3 5 -7`} pathLength={1} />
        </g>
      )}

      {node.flags.map((flag) => (
        <g key={flag.name} className="flag" transform={`translate(0 ${flag.dy})`}>
          {/* Lettered in the lane's text pen (a shade deeper on paper); the underline keeps the line's pen. */}
          <text style={{ fill: flag.text }}>{flag.name}</text>
          {flag.isCurrent && (
            <path
              className="flag-underline"
              d={`M ${-flag.w / 2} 5 q ${flag.w / 4} 3.5 ${flag.w / 2} 0.5 t ${flag.w / 2} -0.5`}
              pathLength={1}
              style={{ stroke: flag.color }}
            />
          )}
        </g>
      ))}

      <text className="map-label" y={R + 24}>
        {node.label.map((line, i) => (
          <tspan key={i} x={0} dy={i === 0 ? 0 : 18}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
});

/** How many more merged lines each press of "+N merged lines" lists. */
const MERGED_PAGE = 40;

interface LegendListProps {
  lanes: Lane[];
  onShow: (lane: Lane) => void;
  onFocusLane: Dispatch<SetStateAction<number | null>>;
}

/**
 * The branch key. Memoised on the lanes, so zooming and pointing at it never rebuild it. On a
 * big history, lines from merged, deleted branches (often thousands) fold behind one row.
 */
const LegendList = memo(function LegendList({ lanes, onShow, onFocusLane }: LegendListProps) {
  const [shownMerged, setShownMerged] = useState(0);
  const { rows, hidden } = legendRows(lanes, shownMerged);
  return (
    <div className="legend-roll">
      <ul className="legend-list">
        {rows.map((lane) => (
          <li key={lane.index} className="legend-row">
            <button
              type="button"
              className="legend-pick"
              title={`${lane.isHead ? `${lane.name} (current)` : lane.name}: show on the map`}
              onClick={() => onShow(lane)}
              onPointerEnter={() => onFocusLane(lane.index)}
              onPointerLeave={() => onFocusLane((f) => (f === lane.index ? null : f))}
              onFocus={() => onFocusLane(lane.index)}
              onBlur={() => onFocusLane((f) => (f === lane.index ? null : f))}
            >
              <span className="legend-swatch" style={{ background: lane.color }} />
              <span className="legend-name">
                {lane.name}
                {lane.isHead ? " · head" : ""}
              </span>
            </button>
          </li>
        ))}
        {hidden > 0 && (
          <li className="legend-row">
            <button
              type="button"
              className="legend-pick legend-more"
              title="List more lines from branches that were merged and deleted"
              onClick={() => setShownMerged((n) => n + MERGED_PAGE)}
            >
              <span className="legend-more-mark" aria-hidden="true">+</span>
              <span className="legend-name">
                {hidden.toLocaleString()} merged {hidden === 1 ? "line" : "lines"}
              </span>
            </button>
          </li>
        )}
      </ul>
    </div>
  );
});

/** Four pen-drawn corners round a dot: show everything. */
function FitIcon() {
  return (
    <svg className="zoom-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.6 7.6 Q2.4 3.1 7.2 2.7 M12.7 2.5 Q17.3 2.6 17.5 7.3 M17.6 12.5 Q17.5 17.4 12.6 17.6 M7.4 17.5 Q2.5 17.6 2.4 12.7" />
      <path d="M10.1 7.6 Q12.6 7.9 12.4 10.2 Q12.1 12.6 9.8 12.4 Q7.5 12.1 7.7 9.8 Q8 7.7 10.4 7.7" />
    </svg>
  );
}

/** A station with the "head" arrow pointing down at it, like the note on the map. */
function HeadIcon() {
  return (
    <svg className="zoom-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10.3 1.8 Q11.4 4.6 9.9 8.2 M7.2 6.1 Q8.8 7.1 9.9 8.4 Q11.4 7.2 12.9 5.5" />
      <path d="M10.2 11.2 Q14 11.4 13.8 14.6 Q13.5 18 9.9 17.8 Q6.3 17.5 6.5 14.4 Q6.8 11.3 10.6 11.4" />
    </svg>
  );
}
