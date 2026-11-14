import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Presence } from "../tools/Presence";
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
import {
  NODE_H,
  NODE_W,
  baseName,
  callDrawPlan,
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

type Load = { phase: "loading" } | { phase: "error"; message: string } | { phase: "done"; tree: CallTree };

type Pick = { kind: "node"; id: string } | { kind: "edges"; ids: string[] } | null;

type Shown =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; lines: SourceLine[]; clipped: number };

const DEPTHS = [1, 2, 3, 4];
const MAX_SHOWN_SITES = 8;

const short = (sha: string) => (/^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha);

/** How long the details take to roll back up (.calls-detail-roll.is-leaving in callGraph.css). */
const DETAIL_EXIT_MS = 160;

/** Hands a draw-in delay to the CSS (`animation-delay: var(--d)`). */
const drawDelay = (ms: number | undefined): CSSProperties | undefined =>
  ms === undefined ? undefined : ({ "--d": `${ms}ms` } as CSSProperties);

/** A calm pencil scribble that draws itself along while the calls are read (as the context view's). */
function Scribble() {
  return (
    <svg className="calls-scribble" viewBox="0 0 64 14" width="48" height="12" aria-hidden="true">
      <path
        pathLength={1}
        d="M2 9 C 6 3, 10 2, 13 7 S 19 13, 23 8 S 30 2, 34 7 S 41 13, 45 8 S 52 2, 56 7 S 60 10, 62 6"
      />
    </svg>
  );
}

export function CallGraphView({ repoPath, revision, path, name, onClose }: Props) {
  const [target, setTarget] = useState<Target>({ path, name });
  const [trail, setTrail] = useState<Target[]>([]);
  const [depth, setDepth] = useState(2);
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<Pick>(null);
  const [shown, setShown] = useState<Shown>({ phase: "idle" });
  const canvas = useRef<HTMLDivElement>(null);

  // One request per target, depth and commit. A newer one makes an older answer stale.
  useEffect(() => {
    let stale = false;
    setLoad({ phase: "loading" });
    setPick(null);
    callTree(repoPath, target.path, target.name, { revision, maxDepth: depth })
      .then(
        (tree) => {
          if (!stale) setLoad({ phase: "done", tree });
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

  // The draw-in. Levels already on the page (the same function at a smaller Reach) stay
  // put, so raising Reach only unrolls the new levels.
  const drawKey = `${revision}\n${target.path}\n${target.name}`;
  const drawn = useRef<{ key: string; depth: number } | null>(null);
  const plan = useMemo(() => {
    if (!layout || !tree) return null;
    const before = drawn.current;
    return callDrawPlan(layout, before && before.key === drawKey ? Math.min(before.depth, tree.maxDepth) : -1);
    // `drawn` is read for the map being laid out now, and written once it is on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);
  useEffect(() => {
    if (tree && layout) drawn.current = { key: drawKey, depth: tree.maxDepth };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Bring the chosen function into view whenever a new map arrives.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !layout) return;
    el.scrollTo({
      left: Math.max(0, layout.rootX - el.clientWidth / 2),
      top: Math.max(0, layout.rootY - el.clientHeight / 2),
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
      {/* Keyed by the function, so moving the map to another one ticks the title over. */}
      <strong key={`${target.path}:${target.name}`} className="calls-title" title={`${target.path} at ${revision}`}>
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
        <p className="calls-state calls-working" role="status">
          <Scribble />
          <span>Reading the calls…</span>
        </p>
      </section>
    );
  }

  if (load.phase === "error") {
    return (
      <section className="calls" aria-label="Call map">
        {bar}
        <div className="calls-state calls-bad calls-error" role="alert">
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

  if (!tree || !layout || !plan) return null;

  const empty = !layout.hasCallers && !layout.hasCallees;
  const pickedEdges = pick?.kind === "edges" ? pick.ids : [];
  const pickedNode = pick?.kind === "node" ? nodes.get(pick.id) : undefined;

  const edgeSelected = (ids: string[]) => ids.some((id) => pickedEdges.includes(id));

  function pickGhost(ghost: LaidGhost) {
    setPick({ kind: "edges", ids: ghost.edgeIds });
  }

  // The column headings ink in with the chosen function, unless it was already there.
  const freshMap = plan.boxes.has(tree.root);

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

      <div className="calls-canvas" ref={canvas}>
        <svg
          className="calls-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={`Callers and callees of ${title}`}
        >
          <defs>
            <marker id="calls-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
              <path className="calls-arrow-ink" d="M 0 1 L 10 5 L 0 9 z" />
            </marker>
            <marker id="calls-arrow-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
              <path className="calls-arrow-soft" d="M 0 1 L 10 5 L 0 9 z" />
            </marker>
            <marker id="calls-arrow-pen" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
              <path className="calls-arrow-pen" d="M 0 1 L 10 5 L 0 9 z" />
            </marker>
          </defs>

          {layout.callerHeadX !== null && (
            <text className={`calls-head${freshMap ? " draw" : ""}`} x={layout.callerHeadX} y={30} textAnchor="middle">
              Called by
            </text>
          )}
          {layout.calleeHeadX !== null && (
            <text className={`calls-head${freshMap ? " draw" : ""}`} x={layout.calleeHeadX} y={30} textAnchor="middle">
              Calls
            </text>
          )}

          {layout.edges.map((line) => {
            const selected = edgeSelected(line.edgeIds);
            const marker = selected ? "calls-arrow-pen" : line.kind === "tree" ? "calls-arrow" : "calls-arrow-soft";
            const first = edges.get(line.edgeIds[0]);
            const label = first
              ? `${nodes.get(first.from)?.name ?? "?"} calls ${first.to ? (nodes.get(first.to)?.name ?? "?") : first.calleeText}`
              : "call";
            const select = () => setPick({ kind: "edges", ids: line.edgeIds });
            const draw = plan.lines.get(line.id);
            return (
              <g
                key={line.id}
                className={`calls-edge ${line.kind}${selected ? " picked" : ""}${draw ? " draw" : ""}${draw?.inward ? " is-inward" : ""}`}
                style={drawDelay(draw?.delay)}
                role="button"
                tabIndex={0}
                aria-label={`${label}${line.callCount > 1 ? `, ${line.callCount} calls` : ""}. Show the call site`}
                onClick={select}
                onKeyDown={activate(select)}
              >
                <path className="calls-hit" d={line.path} />
                <path className="calls-line" d={line.path} markerEnd={`url(#${marker})`} />
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
                className={`calls-ghost${selected ? " picked" : ""}${plan.boxes.has(ghost.id) ? " draw" : ""}`}
                style={drawDelay(plan.boxes.get(ghost.id))}
                transform={`translate(${ghost.cx - NODE_W / 2} ${ghost.cy - NODE_H / 2})`}
                role="button"
                tabIndex={0}
                aria-label={`${ghost.label}, ${tag}. Show the call site`}
                onClick={() => pickGhost(ghost)}
                onKeyDown={activate(() => pickGhost(ghost))}
              >
                <title>{`${ghost.label}: the indexer could not tie this call to one function (${tag})`}</title>
                <rect className="calls-pad" width={NODE_W} height={NODE_H} rx={10} />
                {/* The box lands and tilts in here: the outer group's transform places it. */}
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

          {layout.nodes.map(({ node, cx, cy }) => {
            const isRoot = node.side === "root";
            const selected = pickedNode?.id === node.id;
            const outerX = node.side === "caller" ? 0 : NODE_W;
            const choose = () => setPick({ kind: "node", id: node.id });
            return (
              <g
                key={node.id}
                className={`calls-node ${node.side}${selected ? " picked" : ""}${plan.boxes.has(node.id) ? " draw" : ""}`}
                style={drawDelay(plan.boxes.get(node.id))}
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
                <rect className="calls-pad" width={NODE_W} height={NODE_H} rx={10} />
                {/* The box lands and tilts in here: the outer group's transform places it. */}
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

      {/* The details roll down under the map and back up (roll-down / roll-up). */}
      <Presence show={pick !== null} className="calls-detail-roll" exitMs={DETAIL_EXIT_MS}>
        {pick && (
          <Detail
            tree={tree}
            pick={pick}
            shown={shown}
            onCentre={(symbol) => centre(symbol)}
            onClear={() => setPick(null)}
          />
        )}
      </Presence>
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
      {/* Keyed by what is picked, so choosing another box or line swaps the heading in. */}
      <div key={pick.kind === "node" ? `n:${pick.id}` : `e:${pick.ids.join(",")}`} className="calls-detail-head">
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

      {shown.phase === "loading" && <p className="calls-quiet calls-source-wait">Loading source…</p>}
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
