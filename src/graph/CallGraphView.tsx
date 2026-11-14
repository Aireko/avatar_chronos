import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  callTree,
  errorMessage,
  readSource,
  type CallTree,
  type CallTreeEdge,
  type CallTreeNode,
  type CallTreeOk,
  type CallTreeSymbol,
} from "../backend";
import { prefersReducedMotion } from "./drag";
import {
  HEAD_PATH,
  NODE_H,
  NODE_W,
  baseName,
  exactName,
  fit,
  layoutCallTree,
  numberLines,
  summarize,
  type LaidGhost,
  type SourceLine,
} from "./callTree";
import "./callGraph.css";

interface Props {
  repoPath: string;
  /** The commit the map is built from: the head of the loaded history. */
  revision: string;
  /** Where the function lives at that commit. */
  path: string;
  /** The function's name as the history view knows it (short or qualified). */
  name: string;
  /** Leaves the map and goes back to the commit history. */
  onClose: () => void;
}

interface Target {
  path: string;
  name: string;
}

/** `gen` counts the maps drawn so far: each new one is remounted so its draw-in plays again. */
type Load =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "done"; tree: CallTree; gen: number };

type Pick = { kind: "node"; id: string } | { kind: "edges"; ids: string[] } | null;

type Shown =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; lines: SourceLine[]; clipped: number };

const DEPTHS = [1, 2, 3, 4];

// Zoom works like the history map: buttons, +/-, Ctrl/Cmd+wheel, all gliding. The range runs
// further out than the history map's, because a function with dozens of callees is tall.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.12;
/** How long a zoom key or button takes to glide to its new zoom. */
const ZOOM_MS = 200;
/** A drag shorter than this is a click, not a pan. */
const DRAG_SLOP = 5;

// The draw-in reveals the map one column at a time from the left: a box lands, then the lines
// leaving it are drawn, then their arrowheads. The whole reveal takes about the same time however
// many columns there are.
const COLUMN_MS = 120;
const REVEAL_MS = 720;
const LINE_LAG = 150;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
const MAX_SHOWN_SITES = 8;

const short = (sha: string) => (/^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha);

export function CallGraphView({ repoPath, revision, path, name, onClose }: Props) {
  const [target, setTarget] = useState<Target>({ path, name });
  const [trail, setTrail] = useState<Target[]>([]);
  const [depth, setDepth] = useState(2);
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<Pick>(null);
  const [shown, setShown] = useState<Shown>({ phase: "idle" });
  const canvas = useRef<HTMLDivElement>(null);
  const svgEl = useRef<SVGSVGElement>(null);
  const generation = useRef(0);
  const drag = useRef({ moved: false });
  // `zoom` is what React last drew; `goal` is where a gliding zoom is heading (shown on the keys).
  const [zoom, setZoom] = useState(1);
  const [goal, setGoal] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The zoom on screen right now, which differs from `zoom` while a glide runs. */
  const liveZoom = useRef(zoom);
  const glide = useRef<{ raf: number; target: number } | null>(null);
  const mapSize = useRef<{ w: number; h: number } | null>(null);

  // One request per target, depth and commit. A newer one makes an older answer stale.
  useEffect(() => {
    let stale = false;
    setLoad({ phase: "loading" });
    setPick(null);
    callTree(repoPath, target.path, target.name, { revision, maxDepth: depth })
      .then(
        (tree) => {
          if (!stale) setLoad({ phase: "done", tree, gen: ++generation.current });
        },
        (e: unknown) => {
          if (!stale) setLoad({ phase: "error", message: errorMessage(e) });
        },
      );
    return () => {
      stale = true;
    };
  }, [repoPath, revision, target, depth, attempt]);

  const tree: CallTreeOk | null = load.phase === "done" && load.tree.status === "ok" ? load.tree : null;
  const layout = useMemo(() => (tree ? layoutCallTree(tree) : null), [tree]);
  const nodes = useMemo(() => new Map((tree?.nodes ?? []).map((n) => [n.id, n])), [tree]);
  const edges = useMemo(() => new Map((tree?.edges ?? []).map((e) => [e.id, e])), [tree]);

  // Bring the chosen function into view whenever a new map arrives.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !layout) return;
    const z = liveZoom.current;
    el.scrollTo({
      left: Math.max(0, layout.rootX * z - el.clientWidth / 2),
      top: Math.max(0, layout.rootY * z - el.clientHeight / 2),
    });
  }, [layout]);

  // The source behind the selection: the function itself, or the caller with its call lines marked.
  useEffect(() => {
    if (!tree || !pick) {
      setShown({ phase: "idle" });
      return;
    }
    let subject: CallTreeNode | undefined;
    let hits: { startLine: number; endLine: number }[] = [];
    if (pick.kind === "node") {
      subject = nodes.get(pick.id);
    } else {
      const picked = pick.ids.map((id) => edges.get(id)).filter((e): e is CallTreeEdge => Boolean(e));
      subject = picked[0] ? nodes.get(picked[0].from) : undefined;
      if (subject) {
        const file = subject.filePath;
        hits = picked.flatMap((e) =>
          e.callSites.filter((s) => s.filePath === file).map((s) => ({ startLine: s.range.startLine, endLine: s.range.endLine })),
        );
      }
    }
    if (!subject) {
      setShown({ phase: "idle" });
      return;
    }
    const at = subject;
    let stale = false;
    setShown({ phase: "loading" });
    readSource(repoPath, at.filePath, at.startByte, at.endByte, tree.revision.commitSha).then(
      (response) => {
        if (stale) return;
        const { lines, clipped } = numberLines(response.source, at.startLine, hits);
        setShown({ phase: "ready", lines, clipped });
      },
      (e: unknown) => {
        if (!stale) setShown({ phase: "error", message: errorMessage(e) });
      },
    );
    return () => {
      stale = true;
    };
  }, [repoPath, tree, nodes, edges, pick]);

  mapSize.current = layout ? { w: layout.width, h: layout.height } : null;

  /** Sizes the drawing for zoom `z` straight on the DOM, without rendering the whole map again. */
  function paintZoom(z: number) {
    liveZoom.current = z;
    const size = mapSize.current;
    const el = svgEl.current;
    if (!size || !el) return;
    el.setAttribute("width", String(size.w * z));
    el.setAttribute("height", String(size.h * z));
  }

  function stopGlide() {
    if (glide.current) cancelAnimationFrame(glide.current.raf);
    glide.current = null;
  }

  /** Where the zoom is heading: the end of a running glide, or the current zoom. */
  const targetZoom = () => glide.current?.target ?? liveZoom.current;

  /** Zooms to `next`, keeping the point under `anchor` (default: the middle of the view) still. */
  function applyZoom(next: number, anchor?: { x: number; y: number }, smooth = false) {
    const el = canvas.current;
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
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / ZOOM_MS));
      const at = prev + (z - prev) * (1 - (1 - t) ** 3);
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

  /** The zoom at which the whole map fits the view, never past 100%. */
  function fitZoom() {
    const el = canvas.current;
    const size = mapSize.current;
    if (!el || !size) return 1;
    return Math.min(1, el.clientWidth / size.w, el.clientHeight / size.h);
  }

  useEffect(() => stopGlide, []);

  // Ctrl/Cmd+wheel (and a trackpad pinch) zooms around the pointer; a plain wheel scrolls as usual.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP);
      applyZoom(liveZoom.current * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  // +/- on the keyboard zoom the map, and Ctrl/Cmd+0 resets it (ignored while typing).
  useEffect(() => {
    if (!tree) return;
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
  }, [tree]);

  // Drag the background to pan, as on the history map. Starting on a box or a line is a click,
  // and a drag never counts as one.
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('[role="button"]')) return;
    const el = e.currentTarget;
    if (e.nativeEvent.offsetX >= el.clientWidth || e.nativeEvent.offsetY >= el.clientHeight) return;
    const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    drag.current.moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!drag.current.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!drag.current.moved) {
        drag.current.moved = true;
        el.classList.add("dragging");
      }
      el.scrollLeft = start.left - dx;
      el.scrollTop = start.top - dy;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function centre(symbol: CallTreeSymbol, remember = true) {
    if (remember) setTrail((t) => [...t, target]);
    setTarget({ path: symbol.filePath, name: exactName(symbol) });
  }

  function back() {
    const previous = trail[trail.length - 1];
    if (!previous) return;
    setTrail(trail.slice(0, -1));
    setTarget(previous);
  }

  function activate(handler: () => void) {
    return (e: ReactKeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    };
  }

  const title =
    tree && nodes.get(tree.root)
      ? `${nodes.get(tree.root)?.qualifiedName}()`
      : `${target.name.replace(/#\d+$/, "")}()`;

  const bar = (
    <div className="calls-bar">
      <button type="button" className="btn" onClick={back} disabled={trail.length === 0}>
        ‹ Back
      </button>
      <strong className="calls-title" title={`${target.path} at ${revision}`}>
        {title}
      </strong>
      <span className="calls-rev" title="The map is built from this commit. Uncommitted edits are not in it.">
        at {short(revision)}
      </span>
      <div className="calls-depth" role="group" aria-label="How many calls away to show">
        <span className="calls-depth-label">Reach</span>
        {DEPTHS.map((d) => (
          <button key={d} type="button" className="btn" aria-pressed={depth === d} onClick={() => setDepth(d)}>
            {d}
          </button>
        ))}
      </div>
      {tree && <Summary tree={tree} />}
      <button type="button" className="btn calls-history" onClick={onClose}>
        Show history
      </button>
    </div>
  );

  if (load.phase === "loading") {
    return (
      <section className="calls" aria-label="Call map">
        {bar}
        <p className="calls-state" role="status">
          <span className="calls-dot" aria-hidden="true" />
          Reading the calls…
        </p>
      </section>
    );
  }

  if (load.phase === "error") {
    return (
      <section className="calls" aria-label="Call map">
        {bar}
        <div className="calls-state calls-bad" role="alert">
          <p>{load.message}</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (load.tree.status === "not_found") {
    return (
      <section className="calls" aria-label="Call map">
        {bar}
        <div className="calls-state">
          <p>
            <code>{target.name.replace(/#\d+$/, "")}</code> isn’t defined in <code>{target.path}</code> at commit{" "}
            {short(revision)}.
          </p>
          <p className="calls-quiet">
            It may have been removed or renamed since, or the file’s language isn’t one the call index reads. The commit
            history still shows how it changed.
          </p>
          <button type="button" className="btn" onClick={onClose}>
            Show history
          </button>
        </div>
      </section>
    );
  }

  if (load.tree.status === "ambiguous") {
    return (
      <section className="calls" aria-label="Call map">
        {bar}
        <div className="calls-state">
          <p>
            More than one function in <code>{target.path}</code> goes by <code>{target.name.replace(/#\d+$/, "")}</code>.
            Choose the one you mean.
          </p>
          <ul className="calls-choices">
            {load.tree.candidates.map((c) => (
              <li key={c.symbol.id}>
                <button type="button" className="btn" onClick={() => centre(c, false)}>
                  <code>{c.qualifiedName}</code>
                  <span className="calls-quiet">
                    {" "}
                    {c.kind}, lines {c.startLine}–{c.endLine}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  if (!tree || !layout) return null;

  const empty = !layout.hasCallers && !layout.hasCallees;
  const pickedEdges = pick?.kind === "edges" ? pick.ids : [];
  const pickedNode = pick?.kind === "node" ? nodes.get(pick.id) : undefined;

  const edgeSelected = (ids: string[]) => ids.some((id) => pickedEdges.includes(id));
  const gen = load.phase === "done" ? load.gen : 0;
  const step = Math.floor(Math.min(COLUMN_MS, REVEAL_MS / Math.max(1, layout.lastCol)));
  /** When something in column `col` starts to draw in (the CSS reads it as `--d`). */
  const delay = (col: number, lag: number) => ({ "--d": `${col * step + lag}ms` }) as CSSProperties;

  function pickGhost(ghost: LaidGhost) {
    setPick({ kind: "edges", ids: ghost.edgeIds });
  }

  return (
    <section className="calls" aria-label="Call map">
      {bar}
      <div className="calls-notes">
        {tree.truncated && (
          <p>
            Some neighbours are left out. A box marked … has more; choose it and press “Centre here” to follow them.
          </p>
        )}
        {tree.coverage === "incomplete" && (
          <p>Some files couldn’t be read, so calls from or to them may be missing.</p>
        )}
        {empty && (
          <p>
            No calls to or from this function were found. Calls made through function pointers, imports or dynamic
            dispatch aren’t followed.
          </p>
        )}
      </div>

      <div className="calls-stage">
        <div className="calls-canvas" ref={canvas} onPointerDown={onPointerDown}>
          {/* A new map remounts, so its draw-in plays; picking something does not replay it. */}
          <svg
            key={gen}
            ref={svgEl}
            className="calls-svg"
            width={layout.width * zoom}
            height={layout.height * zoom}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="group"
            aria-label={`Callers and callees of ${title}`}
          >
            {layout.callerHeadX !== null && (
              <text className="calls-head draw" x={layout.callerHeadX} y={30} textAnchor="middle" style={delay(0, 0)}>
                Called by
              </text>
            )}
            {layout.calleeHeadX !== null && (
              <text
                className="calls-head draw"
                x={layout.calleeHeadX}
                y={30}
                textAnchor="middle"
                style={delay(layout.lastCol > 0 ? Math.max(1, layout.lastCol - 1) : 0, 0)}
              >
                Calls
              </text>
            )}

            {layout.edges.map((line) => {
              const selected = edgeSelected(line.edgeIds);
              const first = edges.get(line.edgeIds[0]);
              const label = first
                ? `${nodes.get(first.from)?.name ?? "?"} calls ${first.to ? (nodes.get(first.to)?.name ?? "?") : first.calleeText}`
                : "call";
              const select = () => setPick({ kind: "edges", ids: line.edgeIds });
              return (
                <g
                  key={line.id}
                  className={`calls-edge ${line.kind}${selected ? " picked" : ""} draw`}
                  style={delay(line.col, LINE_LAG)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${label}${line.callCount > 1 ? `, ${line.callCount} calls` : ""}. Show the call site`}
                  onClick={select}
                  onKeyDown={activate(select)}
                >
                  <path className="calls-hit" d={line.path} />
                  <path className="calls-line" d={line.path} pathLength={line.kind === "tree" ? 1 : undefined} />
                  {/* The head is its own shape, aimed along the last stretch of the line. */}
                  <g transform={`translate(${line.tip.x} ${line.tip.y}) rotate(${line.angle})`}>
                    <path className="calls-arrowhead" d={HEAD_PATH} />
                  </g>
                  {line.callCount > 1 && (
                    <text className="calls-count" x={line.mid.x} y={line.mid.y - 5} textAnchor="middle">
                      ×{line.callCount}
                    </text>
                  )}
                </g>
              );
            })}

            {layout.ghosts.map((ghost) => {
              const selected = edgeSelected(ghost.edgeIds);
              const tag =
                ghost.state === "ambiguous"
                  ? `ambiguous · ${ghost.candidates} matches`
                  : ghost.state === "mixed"
                    ? "unresolved or ambiguous"
                    : "unresolved";
              return (
                <g
                  key={ghost.id}
                  className={`calls-ghost${selected ? " picked" : ""} draw`}
                  style={delay(ghost.col, 0)}
                  transform={`translate(${ghost.cx - NODE_W / 2} ${ghost.cy - NODE_H / 2})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${ghost.label}, ${tag}. Show the call site`}
                  onClick={() => pickGhost(ghost)}
                  onKeyDown={activate(() => pickGhost(ghost))}
                >
                  <title>{`${ghost.label}: the indexer could not tie this call to one function (${tag})`}</title>
                  {/* The inner group carries the draw-in, so it never fights the box's own position. */}
                  <g className="calls-body">
                    <rect className="calls-box" width={NODE_W} height={NODE_H} rx={10} />
                    <text className="calls-ghost-name" x={12} y={21}>
                      {fit(ghost.label, 24)}
                      {ghost.callCount > 1 ? ` ×${ghost.callCount}` : ""}
                    </text>
                    <text className="calls-file" x={12} y={39}>
                      {tag}
                    </text>
                  </g>
                </g>
              );
            })}

            {layout.nodes.map(({ node, cx, cy, col }) => {
              const isRoot = node.side === "root";
              const selected = pickedNode?.id === node.id;
              const outerX = node.side === "caller" ? 0 : NODE_W;
              const choose = () => setPick({ kind: "node", id: node.id });
              return (
                <g
                  key={node.id}
                  className={`calls-node ${node.side}${selected ? " picked" : ""} draw`}
                  style={delay(col, 0)}
                  transform={`translate(${cx - NODE_W / 2} ${cy - NODE_H / 2})`}
                  role="button"
                  tabIndex={0}
                  aria-current={isRoot ? "true" : undefined}
                  aria-label={`${node.qualifiedName}, ${node.kind} in ${node.filePath}${isRoot ? ", the function you chose" : ""}${node.hasMore ? ", has more neighbours not shown" : ""}`}
                  onClick={choose}
                  onDoubleClick={() => {
                    if (!isRoot) centre(node);
                  }}
                  onKeyDown={activate(choose)}
                >
                  <title>{`${node.qualifiedName} (${node.filePath}:${node.startLine})`}</title>
                  <g className="calls-body">
                    <rect className="calls-box" width={NODE_W} height={NODE_H} rx={10} />
                    <text className="calls-name" x={12} y={21}>
                      {fit(node.qualifiedName, 24)}
                    </text>
                    <text className="calls-file" x={12} y={39}>
                      {fit(`${baseName(node.filePath)}:${node.startLine}`, 30)}
                    </text>
                    {node.hasMore && (
                      <g className="calls-more" transform={`translate(${outerX} ${NODE_H / 2})`}>
                        <circle r={10} />
                        <text textAnchor="middle" y={4}>
                          …
                        </text>
                      </g>
                    )}
                  </g>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="zoom-controls calls-zoom" role="toolbar" aria-label="Zoom">
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
            title="Reset zoom (Ctrl/⌘ 0)"
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
          <button
            type="button"
            className="btn zoom-btn"
            aria-label="Fit the whole map in the view"
            title="Fit everything in view"
            onClick={() => applyZoom(fitZoom(), undefined, true)}
          >
            Fit
          </button>
        </div>
      </div>

      {pick && (
        <Detail
          tree={tree}
          pick={pick}
          shown={shown}
          onCentre={(symbol) => centre(symbol)}
          onClear={() => setPick(null)}
        />
      )}
    </section>
  );
}

function Summary({ tree }: { tree: CallTreeOk }) {
  const { callers, callees, unknown } = summarize(tree);
  return (
    <span className="calls-summary">
      {callers} {callers === 1 ? "caller" : "callers"}, {callees} {callees === 1 ? "callee" : "callees"}
      {unknown > 0 ? `, ${unknown} unresolved` : ""}
    </span>
  );
}

function Detail({
  tree,
  pick,
  shown,
  onCentre,
  onClear,
}: {
  tree: CallTreeOk;
  pick: NonNullable<Pick>;
  shown: Shown;
  onCentre: (symbol: CallTreeSymbol) => void;
  onClear: () => void;
}) {
  const nodes = new Map(tree.nodes.map((n) => [n.id, n]));
  const edges = pick.kind === "edges" ? pick.ids.map((id) => tree.edges.find((e) => e.id === id)).filter((e): e is CallTreeEdge => Boolean(e)) : [];
  const node = pick.kind === "node" ? nodes.get(pick.id) : undefined;
  const subject = node ?? (edges[0] ? nodes.get(edges[0].from) : undefined);

  return (
    <div className="calls-detail" aria-live="polite">
      <div className="calls-detail-head">
        {node && (
          <>
            <strong>{node.qualifiedName}</strong>
            <span className="calls-quiet">
              {node.filePath}:{node.startLine}–{node.endLine}
            </span>
            {node.side !== "root" && (
              <button type="button" className="btn" onClick={() => onCentre(node)}>
                Centre here
              </button>
            )}
            {node.hasMore && (
              <span className="calls-quiet">
                More {node.side === "caller" ? "callers" : "callees"} exist beyond what is drawn.
              </span>
            )}
          </>
        )}
        {edges.length > 0 && subject && (
          <>
            <strong>
              {subject.qualifiedName} {edges.length > 1 ? "makes these calls" : "makes this call"}
            </strong>
          </>
        )}
        <button type="button" className="btn calls-close" onClick={onClear} aria-label="Close details">
          Close
        </button>
      </div>

      {edges.map((edge) => {
        const callee = edge.to ? nodes.get(edge.to) : undefined;
        return (
          <div key={edge.id} className="calls-edge-info">
            <p>
              <code>{edge.calleeText}</code>
              {callee ? (
                <>
                  {" "}
                  resolves to <code>{callee.qualifiedName}</code> in {callee.filePath}
                </>
              ) : edge.state === "ambiguous" ? (
                <> could be any of {edge.candidateCount} functions.</>
              ) : (
                <> isn’t defined in any file the index read.</>
              )}
              {edge.callCount > 1 ? ` ${edge.callCount} calls` : ""}
            </p>
            {edge.callSites.length > 0 && (
              <p className="calls-quiet">
                {edge.callSites
                  .slice(0, MAX_SHOWN_SITES)
                  .map((s) => `${s.filePath}:${s.range.startLine}`)
                  .join(", ")}
                {edge.callCount > MAX_SHOWN_SITES ? `, and ${edge.callCount - MAX_SHOWN_SITES} more` : ""}
              </p>
            )}
            {edge.candidates.length > 0 && (
              <ul className="calls-choices">
                {edge.candidates.map((c) => (
                  <li key={c.symbol.id}>
                    <button type="button" className="btn" onClick={() => onCentre(c)}>
                      <code>{c.qualifiedName}</code>
                      <span className="calls-quiet"> {baseName(c.filePath)}:{c.startLine}</span>
                    </button>
                  </li>
                ))}
                {edge.candidateCount > edge.candidates.length && (
                  <li className="calls-quiet">and {edge.candidateCount - edge.candidates.length} more</li>
                )}
              </ul>
            )}
          </div>
        );
      })}

      {shown.phase === "loading" && <p className="calls-quiet">Loading source…</p>}
      {shown.phase === "error" && <p className="calls-bad">{shown.message}</p>}
      {shown.phase === "ready" && (
        <pre className="calls-source" aria-label={`Source of ${subject?.qualifiedName ?? "the function"}`}>
          {shown.lines.map((line) => (
            <span key={line.number} className={`calls-line-row${line.hit ? " hit" : ""}`}>
              <span className="calls-gutter">{line.number}</span>
              {line.text}
              {"\n"}
            </span>
          ))}
          {shown.clipped > 0 && <span className="calls-quiet">… {shown.clipped} more lines</span>}
        </pre>
      )}
    </div>
  );
}
