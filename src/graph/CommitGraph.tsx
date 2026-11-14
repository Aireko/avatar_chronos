import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChronosGraph } from "../backend";
import { STATION_R, type GraphLayout } from "./layout";

export type PanelMode = "details" | "diff" | "rebase";

interface Props {
  graph: ChronosGraph;
  layout: GraphLayout;
  selected: string | null;
  panelOpen: boolean;
  onSelect: (hash: string | null) => void;
  onAction: (mode: PanelMode) => void;
}

const R = STATION_R;
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 2.4;
const ZOOM_STEP = 0.12;
/** Extra space around the graph so you can drag past the edges. */
const MAP_PAD = 280;

function clampZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

export function CommitGraph({ graph, layout, selected, panelOpen, onSelect, onAction }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef({ moved: false });
  const shownRepo = useRef<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [legendOpen, setLegendOpen] = useState(true);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const sheetW = layout.width + MAP_PAD * 2;
  const sheetH = layout.height + MAP_PAD * 2;

  function applyZoom(next: number, anchor?: { x: number; y: number }) {
    const el = viewport.current;
    const prev = zoomRef.current;
    const z = clampZoom(next);
    if (z === prev) return;

    if (el) {
      const ax = anchor?.x ?? el.clientWidth / 2;
      const ay = anchor?.y ?? el.clientHeight / 2;
      const contentX = (el.scrollLeft + ax) / prev;
      const contentY = (el.scrollTop + ay) / prev;
      setZoom(z);
      requestAnimationFrame(() => {
        el.scrollLeft = contentX * z - ax;
        el.scrollTop = contentY * z - ay;
      });
    } else {
      setZoom(z);
    }
  }

  // Trackpad/mouse: free 2D pan. Shift+wheel pans horizontally. Ctrl/Cmd+wheel zooms.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP);
        applyZoom(zoomRef.current * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
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
        applyZoom(zoomRef.current + ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        applyZoom(zoomRef.current - ZOOM_STEP);
      } else if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        applyZoom(1);
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
      behavior,
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

  // Only the newest stretch is drawn in sequence; older history is simply there.
  const lastCol = layout.nodes.length - 1;
  const delayFor = (col: number) => Math.max(0, col - (lastCol - 12)) * 70;
  const casingStyle = (d: string, order: number) =>
    ({ d: `path("${d}")`, animationDelay: `${delayFor(order)}ms` }) as CSSProperties;
  const lineStyle = (d: string, order: number, color: string) =>
    ({ d: `path("${d}")`, animationDelay: `${delayFor(order)}ms`, stroke: color }) as CSSProperties;

  const solid = layout.edges.filter((e) => !e.ghost);
  const ghosts = layout.edges.filter((e) => e.ghost);

  const menuNode = selected && !panelOpen ? layout.byHash.get(selected) : undefined;
  const currentBranch = graph.branches.find((b) => b.isHead)?.name ?? null;
  const menuIsHead = menuNode?.commit.hash === graph.head;
  const menu: { mode: PanelMode; label: string; disabled: boolean; hint: string }[] = [
    { mode: "details", label: "Details", disabled: false, hint: "Author, date and changed files" },
    {
      mode: "diff",
      label: "Diff",
      disabled: menuIsHead,
      hint: menuIsHead ? "Nothing newer to compare" : "What your branch changed since this commit",
    },
    {
      mode: "rebase",
      label: "Rebase",
      disabled: menuIsHead || !currentBranch,
      hint: menuIsHead
        ? "You are already on this commit"
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
        <div className="map-sheet" style={{ width: sheetW * zoom, height: sheetH * zoom }}>
          <div className="map-zoom" style={{ width: sheetW, height: sheetH, transform: `scale(${zoom})` }}>
            <svg
              className="map-svg"
              width={layout.width}
              height={layout.height}
              style={{ left: MAP_PAD, top: MAP_PAD }}
            >
              {ghosts.map((edge) => (
                <path key={edge.key} d={edge.d} pathLength={1} className="tube-ghost" style={{ stroke: edge.color }} />
              ))}
              {/* Paper-coloured casings first, then the pen lines, so joins stay clean. */}
              {solid.map((edge) => (
                <path
                  key={`c-${edge.key}`}
                  d={edge.d}
                  pathLength={1}
                  className="tube-casing"
                  style={casingStyle(edge.d, edge.order)}
                />
              ))}
              {solid.map((edge) => (
                <path
                  key={`f-${edge.key}`}
                  d={edge.d}
                  pathLength={1}
                  className="tube"
                  style={lineStyle(edge.d, edge.order, edge.color)}
                />
              ))}
              {/* Where a line crosses another branch's row, it hops over with a small gap. */}
              {layout.bridges.map((bridge) => (
                <g key={bridge.key} className="bridge" style={{ animationDelay: `${delayFor(bridge.order) + 400}ms` }}>
                  <line className="bridge-gap" x1={bridge.x} x2={bridge.x} y1={bridge.y - 9} y2={bridge.y + 9} />
                  <line
                    className="bridge-line"
                    x1={bridge.x}
                    x2={bridge.x}
                    y1={bridge.y - 12}
                    y2={bridge.y + 12}
                    style={{ stroke: bridge.color }}
                  />
                </g>
              ))}

              {layout.nodes.map((node) => {
                const isSelected = node.commit.hash === selected;
                const isHead = node.commit.hash === graph.head;
                return (
                  <g
                    key={node.id}
                    className={`node${isSelected ? " selected" : ""}`}
                    style={{ transform: `translate(${node.x}px, ${node.y}px)`, "--line": node.color } as CSSProperties}
                    tabIndex={0}
                    role="button"
                    aria-label={node.commit.message}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!drag.current.moved) onSelect(node.commit.hash);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(node.commit.hash);
                      }
                    }}
                  >
                    <title>{node.commit.message}</title>
                    <circle className="node-hit" r={26} />
                    <path className="halo" d={node.halo} />
                    <g className="station" style={{ animationDelay: `${delayFor(node.col) + 320}ms` }}>
                      <path className="ring" d={node.shape} />
                      {node.kind === "interchange" && <circle className="ring-core" r={3.6} />}
                    </g>

                    {isHead && (
                      <g className="head-note">
                        <text y={-(R + 24)}>head</text>
                        <path d={`M 1 ${-(R + 19)} q 3 5 -1 11 m -5 -5 q 3 4 5 6 q 3 -3 5 -7`} />
                      </g>
                    )}

                    {node.flags.map((flag) => (
                      <g key={flag.name} className="flag" transform={`translate(0 ${flag.dy})`}>
                        <text style={{ fill: flag.color }}>{flag.name}</text>
                        {flag.isCurrent && (
                          <path
                            className="flag-underline"
                            d={`M ${-flag.w / 2} 5 q ${flag.w / 4} 3.5 ${flag.w / 2} 0.5 t ${flag.w / 2} -0.5`}
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
            </svg>

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
          </div>
        </div>
      </div>

      <div className="map-chrome">
        <div className={`branch-legend${legendOpen ? "" : " collapsed"}`} aria-label="Branch colors">
          <button
            type="button"
            className="legend-toggle"
            aria-expanded={legendOpen}
            onClick={() => setLegendOpen((v) => !v)}
          >
            <span>Branches</span>
            <span aria-hidden="true">{legendOpen ? "▾" : "▸"}</span>
          </button>
          {legendOpen && (
            <ul className="legend-list">
              {layout.lanes.map((lane) => (
                <li key={lane.name} className="legend-row" title={lane.isHead ? `${lane.name} (current)` : lane.name}>
                  <span className="legend-swatch" style={{ background: lane.color }} />
                  <span className="legend-name">
                    {lane.name}
                    {lane.isHead ? " · head" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="zoom-controls" role="toolbar" aria-label="Zoom">
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Zoom in"
            title="Zoom in (+)"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => applyZoom(zoom + ZOOM_STEP)}
          >
            +
          </button>
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Reset zoom"
            title="Reset zoom (⌘0)"
            onClick={() => applyZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Zoom out"
            title="Zoom out (−)"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => applyZoom(zoom - ZOOM_STEP)}
          >
            −
          </button>
        </div>
      </div>
    </div>
  );
}
