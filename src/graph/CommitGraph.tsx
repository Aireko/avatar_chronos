import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { ChronosGraph } from "../backend";
import { STATION_R, type GraphLayout } from "./layout";
import { scopeNoun, type Scope } from "./scope";

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

export function CommitGraph({ graph, layout, selected, panelOpen, scope, gone, currentBranch, onSelect, onAction }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef({ moved: false });
  const shownRepo = useRef<string | null>(null);

  // Mouse wheel moves along the timeline; Shift+wheel moves between rows.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // A new repository opens at its newest commits. When head moves (after a rebase), follow it.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    if (shownRepo.current !== graph.repoPath) {
      shownRepo.current = graph.repoPath;
      el.scrollLeft = el.scrollWidth;
      el.scrollTop = 0;
      return;
    }
    const node = graph.head ? layout.byHash.get(graph.head) : undefined;
    if (!node) return;
    el.scrollTo({ left: node.x - el.clientWidth / 2, top: node.y - el.clientHeight / 2, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.repoPath, graph.head]);

  // Bring the selected commit into view when it is off screen.
  useEffect(() => {
    const el = viewport.current;
    const node = selected ? layout.byHash.get(selected) : undefined;
    if (!el || !node) return;
    const offX = node.x < el.scrollLeft + 150 || node.x > el.scrollLeft + el.clientWidth - 150;
    const offY = node.y < el.scrollTop + 130 || node.y > el.scrollTop + el.clientHeight - 80;
    if (offX || offY) {
      el.scrollTo({
        left: offX ? node.x - el.clientWidth / 2 : el.scrollLeft,
        top: offY ? node.y - el.clientHeight / 2 : el.scrollTop,
        behavior: "smooth",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, panelOpen]);

  // Drag anywhere to pan. A drag never counts as a click.
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
    <div
      ref={viewport}
      className="map"
      onPointerDown={onPointerDown}
      onClick={() => {
        if (!drag.current.moved) onSelect(null);
      }}
    >
      <div className="map-sheet" style={{ width: layout.width, height: layout.height }}>
        <svg className="map-svg" width={layout.width} height={layout.height}>
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
              left: menuNode.x,
              top: menuNode.y - (R + 34) - menuNode.flags.length * 25 - (menuIsHead ? 32 : 0),
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
  );
}