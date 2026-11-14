import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChronosGraph } from "../backend";
import { STATION_R, drawDelay, drawInWindow, type GraphLayout, type GraphNode, type Lane } from "./layout";

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
/** How long a zoom key or button takes to glide to its new zoom. */
const ZOOM_MS = 200;
/** Extra space around the graph so you can drag past the edges. */
const MAP_PAD = 280;
/** More find matches than this are not marked: past that, the marks stop giving an overview. */
const MAX_FIND_MARKS = 600;
/** Stations land a little after their lines; crossing hops land last. */
const STATION_LAG = 320;
const BRIDGE_LAG = 400;

function clampZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

/**
 * The draw-in plan for one opening of the map. Each element present when the map opened
 * keeps the decision made then (a delay, or null: already there), so a later reload or
 * rebase that shifts columns never restarts an old element's animation. Elements that
 * appear afterwards (new commits, replayed lines) draw in at once.
 */
interface Intro {
  repo: string;
  plan: Map<string, number | null>;
}

function planIntro(graph: ChronosGraph, layout: GraphLayout, zoom: number): Intro {
  const lastCol = layout.nodes.length - 1;
  const focus = (graph.head ? layout.byHash.get(graph.head)?.col : undefined) ?? lastCol;
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const win = drawInWindow(focus, lastCol, width, zoom);
  const plan = new Map<string, number | null>();
  for (const n of layout.nodes) plan.set(`n:${n.id}`, drawDelay(win, n.col));
  for (const e of layout.edges) plan.set(`e:${e.key}`, drawDelay(win, e.order));
  for (const b of layout.bridges) plan.set(`b:${b.key}`, drawDelay(win, b.order));
  return { repo: graph.repoPath, plan };
}

/** The draw-in class and delay for one piece of the drawing; null is no animation. */
function draw(delay: number | null, lag = 0) {
  return delay === null ? { cls: "", delay: undefined } : { cls: " draw", delay: `${delay + lag}ms` };
}

interface StationProps {
  node: GraphNode;
  isSelected: boolean;
  isHead: boolean;
  /** Draw-in class (" draw" or "") and its delay. */
  cls: string;
  delay: string | undefined;
  authorId: number | undefined;
  /** `pointer`: a click, which a drag of the map must not count as. */
  onPick: (hash: string, pointer: boolean) => void;
}

/** One commit on the map. Memoised, so a new selection re-renders two stations, not all. */
const Station = memo(function Station({ node, isSelected, isHead, cls, delay, authorId, onPick }: StationProps) {
  return (
    <g
      className={`node${isSelected ? " selected" : ""}${cls}`}
      data-lane={node.lane}
      data-author={authorId}
      style={
        {
          transform: `translate(${node.x}px, ${node.y}px)`,
          "--line": node.color,
          "--d": delay,
        } as CSSProperties
      }
      tabIndex={0}
      role="button"
      aria-label={node.commit.message}
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
          <text style={{ fill: flag.color }}>{flag.name}</text>
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

/** null: no animation. A number: animate after that many ms. */
function entryDelay(intro: Intro, key: string): number | null {
  const planned = intro.plan.get(key);
  return planned === undefined ? 0 : planned;
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
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The zoom currently on screen, which differs from `zoom` while a glide runs. */
  const liveZoom = useRef(zoom);
  const glide = useRef<{ raf: number; target: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const sheetW = layout.width + MAP_PAD * 2;
  const sheetH = layout.height + MAP_PAD * 2;
  const sheetSize = useRef({ w: sheetW, h: sheetH });
  sheetSize.current = { w: sheetW, h: sheetH };

  // A fresh plan for each repository; the component itself remounts when the scope changes.
  const [intro, setIntro] = useState(() => planIntro(graph, layout, 1));
  if (intro.repo !== graph.repoPath) setIntro(planIntro(graph, layout, zoomRef.current));

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

  function stopGlide() {
    if (glide.current) cancelAnimationFrame(glide.current.raf);
    glide.current = null;
  }

  /** Where the zoom is heading: the end of a running glide, or the current zoom. */
  const targetZoom = () => glide.current?.target ?? liveZoom.current;

  function applyZoom(next: number, anchor?: { x: number; y: number }, smooth = false) {
    const el = viewport.current;
    const prev = liveZoom.current;
    const z = clampZoom(next);
    stopGlide();
    setGoal(z);
    if (z === prev) {
      if (z !== zoomRef.current) setZoom(z);
      return;
    }
    if (!el) {
      liveZoom.current = z;
      setZoom(z);
      return;
    }

    const ax = anchor?.x ?? el.clientWidth / 2;
    const ay = anchor?.y ?? el.clientHeight / 2;
    const contentX = (el.scrollLeft + ax) / prev;
    const contentY = (el.scrollTop + ay) / prev;
    const settle = (at: number) => {
      el.scrollLeft = contentX * at - ax;
      el.scrollTop = contentY * at - ay;
    };

    if (!smooth || prefersReducedMotion()) {
      paintZoom(z);
      settle(z);
      setZoom(z);
      return;
    }

    // Glide: scale the sheet frame by frame, keeping the anchor point still, then hand the
    // final zoom to React. The drawing itself is memoised, so only the frame is touched.
    const start = performance.now();
    const step = (now: number) => {
      // A frame's timestamp can be a little older than `start`, so clamp at both ends.
      const t = Math.min(1, Math.max(0, (now - start) / ZOOM_MS));
      const eased = 1 - (1 - t) ** 3;
      const at = prev + (z - prev) * eased;
      paintZoom(at);
      settle(at);
      if (t < 1) {
        glide.current = { raf: requestAnimationFrame(step), target: z };
      } else {
        glide.current = null;
        setZoom(z);
      }
    };
    glide.current = { raf: requestAnimationFrame(step), target: z };
  }

  useEffect(() => stopGlide, []);

  // Trackpad/mouse: free 2D pan. Shift+wheel pans horizontally. Ctrl/Cmd+wheel zooms.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP);
        applyZoom(liveZoom.current * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
        return;
      }
      e.preventDefault();
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

  // +/- on the keyboard zoom the map (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        applyZoom(targetZoom() + ZOOM_STEP, undefined, true);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        applyZoom(targetZoom() - ZOOM_STEP, undefined, true);
      } else if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        applyZoom(1, undefined, true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scrollToPoint(x: number, y: number, behavior: ScrollBehavior = "smooth") {
    const el = viewport.current;
    if (!el) return;
    const z = zoomRef.current;
    el.scrollTo({
      left: (x + MAP_PAD) * z - el.clientWidth / 2,
      top: (y + MAP_PAD) * z - el.clientHeight / 2,
      behavior: prefersReducedMotion() ? "auto" : behavior,
    });
  }

  // A new repository opens at its newest commits. When head moves (after a rebase), follow it.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    if (shownRepo.current !== graph.repoPath) {
      shownRepo.current = graph.repoPath;
      const node = graph.head ? layout.byHash.get(graph.head) : layout.nodes[layout.nodes.length - 1];
      if (node) scrollToPoint(node.x, node.y, "auto");
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

  // Bring the selected commit into view when it is off screen.
  useEffect(() => {
    const el = viewport.current;
    const node = selected ? layout.byHash.get(selected) : undefined;
    if (!el || !node) return;
    const z = zoomRef.current;
    const x = (node.x + MAP_PAD) * z;
    const y = (node.y + MAP_PAD) * z;
    const offX = x < el.scrollLeft + 150 || x > el.scrollLeft + el.clientWidth - 150;
    const offY = y < el.scrollTop + 130 || y > el.scrollTop + el.clientHeight - 80;
    if (offX || offY) scrollToPoint(node.x, node.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, panelOpen, zoom]);

  // Drag anywhere to pan freely (including up/down). A drag never counts as a click.
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    if (e.target === el && (e.nativeEvent.offsetX >= el.clientWidth || e.nativeEvent.offsetY >= el.clientHeight)) return;
    const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    drag.current.moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!drag.current.moved && Math.hypot(dx, dy) < 5) return;
      drag.current.moved = true;
      el.classList.add("dragging");
      el.scrollLeft = start.left - dx;
      el.scrollTop = start.top - dy;
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** The legend points at a branch: pan to its newest commit. */
  function showLane(lane: Lane) {
    const node = layout.byHash.get(lane.tip);
    if (node) scrollToPoint(node.x, node.y);
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
  const findOverlay = useMemo(() => {
    if (!findMarks || findMarks.length === 0) return null;
    const marks: ReactElement[] = [];
    for (const hash of findMarks) {
      if (marks.length >= MAX_FIND_MARKS) break;
      // The selected commit has its own halo.
      if (hash === selected) continue;
      const node = layout.byHash.get(hash);
      if (!node) continue;
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
  }, [findMarks, selected, layout, authorIds]);

  // Stations call back through refs, so this never changes and never re-renders them.
  const pick = useCallback((hash: string, pointer: boolean) => {
    if (!pointer || !drag.current.moved) onSelectRef.current(hash);
  }, []);

  // The lines only change with the history. Zooming, panning, pointing at the legend and
  // moving the selection re-render this component without touching them.
  const lines = useMemo(() => {
    const solid = layout.edges.filter((e) => !e.ghost);
    const ghosts = layout.edges.filter((e) => e.ghost);
    const edgeIn = new Map(layout.edges.map((e) => [e.key, draw(entryDelay(intro, `e:${e.key}`))] as const));

    // Pointing at a branch in the legend fades every other line. One rule per lane, so the
    // highlight is a single attribute change on the <svg>, not a re-render of the drawing.
    const laneCss =
      layout.lanes.length < 2
        ? ""
        : `${layout.lanes
            .map((l) => `.map-svg[data-focus="${l.index}"] [data-lane]:not([data-lane="${l.index}"])`)
            .join(",\n")} { opacity: 0.16; }`;

    // Lines and stations apart, so the find marks can sit between them.
    return (
      <>
        {laneCss && <style>{laneCss}</style>}
        {ghosts.map((edge) => {
          const at = edgeIn.get(edge.key)!;
          return (
            <path
              key={edge.key}
              d={edge.d}
              pathLength={1}
              className={`tube-ghost${at.cls}`}
              data-lane={edge.lane}
              style={{ stroke: edge.color, animationDelay: at.delay }}
            />
          );
        })}
        {/* Paper-coloured casings first, then the pen lines, so joins stay clean. */}
        {solid.map((edge) => {
          const at = edgeIn.get(edge.key)!;
          return (
            <path
              key={`c-${edge.key}`}
              d={edge.d}
              pathLength={1}
              className={`tube-casing${at.cls}`}
              style={{ d: `path("${edge.d}")`, animationDelay: at.delay } as CSSProperties}
            />
          );
        })}
        {solid.map((edge) => {
          const at = edgeIn.get(edge.key)!;
          return (
            <path
              key={`f-${edge.key}`}
              d={edge.d}
              pathLength={1}
              className={`tube${at.cls}`}
              data-lane={edge.lane}
              style={{ d: `path("${edge.d}")`, animationDelay: at.delay, stroke: edge.color } as CSSProperties}
            />
          );
        })}
        {/* Where a line crosses another branch's row, it hops over with a small gap. */}
        {layout.bridges.map((bridge) => {
          const at = draw(entryDelay(intro, `b:${bridge.key}`), BRIDGE_LAG);
          return (
            <g key={bridge.key} className={`bridge${at.cls}`} style={{ animationDelay: at.delay }}>
              <line className="bridge-gap" x1={bridge.x} x2={bridge.x} y1={bridge.y - 9} y2={bridge.y + 9} />
              <line
                className="bridge-line"
                data-lane={bridge.lane}
                x1={bridge.x}
                x2={bridge.x}
                y1={bridge.y - 12}
                y2={bridge.y + 12}
                style={{ stroke: bridge.color }}
              />
            </g>
          );
        })}
      </>
    );
  }, [layout, intro]);

  // The stations follow the selection and head too. Each is memoised, so moving the
  // selection (arrow keys, find) re-renders only the old and the new one.
  const stations = useMemo(
    () =>
      layout.nodes.map((node) => {
        const at = draw(entryDelay(intro, `n:${node.id}`), STATION_LAG);
        return (
          <Station
            key={node.id}
            node={node}
            isSelected={node.commit.hash === selected}
            isHead={node.commit.hash === graph.head}
            cls={at.cls}
            delay={at.delay}
            authorId={authorIds.get(node.commit.author)}
            onPick={pick}
          />
        );
      }),
    [layout, selected, graph.head, intro, authorIds, pick],
  );

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
              data-focus={focusLane ?? undefined}
            >
              {lines}
              {findOverlay}
              {stations}

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
            <div className="legend-roll">
              <ul className="legend-list">
                {layout.lanes.map((lane) => (
                  <li key={lane.index} className="legend-row">
                    <button
                      type="button"
                      className="legend-pick"
                      title={`${lane.isHead ? `${lane.name} (current)` : lane.name}: show on the map`}
                      onClick={() => showLane(lane)}
                      onPointerEnter={() => setFocusLane(lane.index)}
                      onPointerLeave={() => setFocusLane((f) => (f === lane.index ? null : f))}
                      onFocus={() => setFocusLane(lane.index)}
                      onBlur={() => setFocusLane((f) => (f === lane.index ? null : f))}
                    >
                      <span className="legend-swatch" style={{ background: lane.color }} />
                      <span className="legend-name">
                        {lane.name}
                        {lane.isHead ? " · head" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </Presence>
        </div>

        <div className="zoom-controls" role="toolbar" aria-label="Zoom">
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Zoom in"
            title="Zoom in (+)"
            disabled={goal >= ZOOM_MAX}
            onClick={() => applyZoom(targetZoom() + ZOOM_STEP, undefined, true)}
          >
            +
          </button>
          <button
            type="button"
            className="btn zoom-btn"
            aria-label={`Reset zoom, now ${Math.round(goal * 100)}%`}
            title="Reset zoom (⌘0)"
            onClick={() => applyZoom(1, undefined, true)}
          >
            <span key={Math.round(goal * 100)} className="zoom-level">
              {Math.round(goal * 100)}%
            </span>
          </button>
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Zoom out"
            title="Zoom out (−)"
            disabled={goal <= ZOOM_MIN}
            onClick={() => applyZoom(targetZoom() - ZOOM_STEP, undefined, true)}
          >
            −
          </button>
        </div>
      </div>
    </div>
  );
}
