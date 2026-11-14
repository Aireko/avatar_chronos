import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChronosGraph } from "../backend";
import { STATION_R, drawDelay, drawInWindow, type GraphLayout, type Lane } from "./layout";
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
}

const R = STATION_R;
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 2.4;
const ZOOM_STEP = 0.12;
/** How long a zoom key or button takes to glide to its new zoom. */
const ZOOM_MS = 200;
/** Extra space around the graph so you can drag past the edges. */
const MAP_PAD = 280;
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

/** null: no animation. A number: animate after that many ms. */
function entryDelay(intro: Intro, key: string): number | null {
  const planned = intro.plan.get(key);
  return planned === undefined ? 0 : planned;
}

export function CommitGraph({ graph, layout, selected, panelOpen, scope, gone, currentBranch, onSelect, onAction }: Props) {
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

  // The drawing only changes with the history, the selection and head. Zooming, panning and
  // pointing at the legend re-render this component without touching thousands of circles.
  const drawing = useMemo(() => {
    const draw = (delay: number | null, lag = 0) =>
      delay === null ? { cls: "", delay: undefined } : { cls: " draw", delay: `${delay + lag}ms` };
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

        {layout.nodes.map((node) => {
          const isSelected = node.commit.hash === selected;
          const isHead = node.commit.hash === graph.head;
          const at = draw(entryDelay(intro, `n:${node.id}`), STATION_LAG);
          return (
            <g
              key={node.id}
              className={`node${isSelected ? " selected" : ""}${at.cls}`}
              data-lane={node.lane}
              style={
                {
                  transform: `translate(${node.x}px, ${node.y}px)`,
                  "--line": node.color,
                  "--d": at.delay,
                } as CSSProperties
              }
              tabIndex={0}
              role="button"
              aria-label={node.commit.message}
              onClick={(e) => {
                e.stopPropagation();
                if (!drag.current.moved) onSelectRef.current(node.commit.hash);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectRef.current(node.commit.hash);
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
        })}
      </>
    );
  }, [layout, selected, graph.head, intro]);

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
              {drawing}
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
