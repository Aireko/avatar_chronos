import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { ChronosGraph } from "../backend";
import { INSPECTOR_W, STATION_R, type GraphLayout, type GraphNode } from "./layout";

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

/** A flat ball in the branch colour. Merges get a white centre; the first commit is a rounded block. */
function Ball({ node }: { node: GraphNode }) {
  if (node.kind === "origin") {
    return <rect className="ball" x={-R} y={-R} width={R * 2} height={R * 2} rx={6} />;
  }
  if (node.kind === "interchange") {
    return (
      <>
        <circle className="ball" r={R + 2} />
        <circle className="ball-core" r={5} />
      </>
    );
  }
  return <circle className="ball" r={R} />;
}

export function CommitGraph({ graph, layout, selected, panelOpen, onSelect, onAction }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef({ moved: false });
  const shownRepo = useRef<string | null>(null);

  const visibleWidth = (el: HTMLDivElement) => Math.max(240, el.clientWidth - (panelOpen ? INSPECTOR_W : 0));

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

  // A new repository opens at its newest commits. When "head" moves (after a rebase), follow it.
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
    el.scrollTo({
      left: node.x - visibleWidth(el) / 2,
      top: node.y - el.clientHeight / 2,
      behavior: "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.repoPath, graph.head]);

  // Glide to the selected commit when it is off screen or hidden under the ticket.
  useEffect(() => {
    const el = viewport.current;
    const node = selected ? layout.byHash.get(selected) : undefined;
    if (!el || !node) return;
    const w = visibleWidth(el);
    const offX = node.x < el.scrollLeft + 150 || node.x > el.scrollLeft + w - 150;
    const offY = node.y < el.scrollTop + 130 || node.y > el.scrollTop + el.clientHeight - 90;
    if (offX || offY) {
      el.scrollTo({
        left: offX ? node.x - w / 2 : el.scrollLeft,
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

  // Only the newest stretch animates in sequence; older history is simply there.
  const lastCol = layout.nodes.length - 1;
  const delayFor = (col: number) => Math.max(0, col - (lastCol - 12)) * 70;
  const pathStyle = (d: string, order: number) =>
    ({ d: `path("${d}")`, animationDelay: `${delayFor(order)}ms` }) as CSSProperties;

  const solid = layout.edges.filter((e) => !e.ghost);
  const ghosts = layout.edges.filter((e) => e.ghost);

  const menuNode = selected && !panelOpen ? layout.byHash.get(selected) : undefined;
  const currentBranch = graph.branches.find((b) => b.isHead)?.name ?? null;
  const menuIsHead = menuNode?.commit.hash === graph.head;
  const menu: { mode: PanelMode; label: string; dx: number; dy: number; disabled: boolean; hint: string }[] = [
    {
      mode: "rebase",
      label: "Rebase",
      dx: -88,
      dy: -50,
      disabled: menuIsHead || !currentBranch,
      hint: menuIsHead
        ? "You are already on this commit"
        : currentBranch
          ? `Move ${currentBranch} onto this commit`
          : "Check out a branch first",
    },
    { mode: "details", label: "Details", dx: 0, dy: -94, disabled: false, hint: "Who, when and which files" },
    {
      mode: "diff",
      label: "Diff",
      dx: 88,
      dy: -50,
      disabled: menuIsHead,
      hint: menuIsHead ? "Nothing newer to compare" : "What your branch changed since this commit",
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
            <path key={edge.key} d={edge.d} pathLength={1} className="tube-ghost" stroke={edge.color} />
          ))}
          {/* Outlines first, then colours, so an outline never cuts across another line's colour. */}
          {solid.map((edge) => (
            <path
              key={`o-${edge.key}`}
              d={edge.d}
              pathLength={1}
              className="tube-outline"
              style={pathStyle(edge.d, edge.order)}
            />
          ))}
          {solid.map((edge) => (
            <path
              key={`f-${edge.key}`}
              d={edge.d}
              pathLength={1}
              className="tube"
              stroke={edge.color}
              style={pathStyle(edge.d, edge.order)}
            />
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
                <circle className="node-hit" r={30} />
                <g className="station" style={{ animationDelay: `${delayFor(node.col) + 320}ms` }}>
                  <circle className="pick-edge" r={R + 9} />
                  <circle className="pick" r={R + 9} />
                  <Ball node={node} />
                </g>

                {isHead && (
                  <g className="head-pin" transform={`translate(0 ${-(R + 12)})`}>
                    <g className="head-bob">
                      <text y={-13}>head</text>
                      <path d="M 0 -8 V 2 M -5 -3 L 0 3 L 5 -3" />
                    </g>
                  </g>
                )}

                {node.flags.map((flag) => (
                  <g key={flag.name} className="flag" transform={`translate(0 ${flag.dy})`}>
                    {flag.isHead && (
                      <rect className="flag-current" x={-flag.w / 2 - 4} y={-16} width={flag.w + 8} height={32} rx={10} />
                    )}
                    <rect className="flag-face" x={-flag.w / 2} y={-12} width={flag.w} height={24} rx={7} fill={flag.color} />
                    <text y={4.5} fill={flag.on}>
                      {flag.name}
                    </text>
                  </g>
                ))}

                <text className="map-label" y={R + 30}>
                  {node.label.map((line, i) => (
                    <tspan key={i} x={0} dy={i === 0 ? 0 : 16}>
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
            style={{ left: menuNode.x, top: menuNode.y }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {menu.map((item) => (
              <button
                key={item.mode}
                className={`bubble ${item.mode}`}
                style={{ "--dx": `${item.dx}px`, "--dy": `${item.dy}px` } as CSSProperties}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => onAction(item.mode)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}