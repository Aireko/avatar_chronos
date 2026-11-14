import type { CallTreeEdge, CallTreeNode, CallTreeOk, CallTreeSymbol } from "../backend";

/** Extensions the Tree-sitter indexer parses (`find_language` in backend/src/parser.c). */
const SUPPORTED = [".c", ".h", ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export const supportsCallGraph = (path: string): boolean => {
  const lower = path.toLowerCase();
  return SUPPORTED.some((ext) => lower.endsWith(ext));
};

/**
 * Names a definition exactly. The `#line` suffix is understood by `chronos_call_tree`, so a
 * re-centre never lands on a different function that shares the qualified name.
 */
export const exactName = (symbol: Pick<CallTreeSymbol, "qualifiedName" | "startLine">): string =>
  `${symbol.qualifiedName}#${symbol.startLine}`;

export const baseName = (path: string): string => path.split("/").pop() || path;

/** Shortens with an ellipsis; the full text stays in the tooltip. */
export function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export const NODE_W = 208;
export const NODE_H = 50;
const COL_GAP = 92;
const ROW_GAP = 16;
const PAD_X = 36;
const PAD_TOP = 56;
const PAD_BOTTOM = 36;
const COL = NODE_W + COL_GAP;
const ROW = NODE_H + ROW_GAP;
/** Unresolved calls shown per function before the rest fold into one "more" box. */
const MAX_GHOSTS = 3;

export interface LaidNode {
  node: CallTreeNode;
  cx: number;
  cy: number;
}

/** A call the indexer could not tie to one function: drawn as a dashed box that ends the branch. */
export interface LaidGhost {
  id: string;
  fromId: string;
  label: string;
  state: "unresolved" | "ambiguous" | "mixed";
  cx: number;
  cy: number;
  edgeIds: string[];
  callCount: number;
  /** Ambiguous calls only: how many definitions the name could refer to. */
  candidates: number;
}

export type LaidEdgeKind = "tree" | "back" | "ghost";

export interface LaidEdge {
  id: string;
  /** Every edge this line stands for (a "more" box stands for several). */
  edgeIds: string[];
  kind: LaidEdgeKind;
  /** The box the line leaves (the caller) and the box it reaches (a node, or a ghost's id). */
  from: string;
  to: string;
  path: string;
  /** Where the call-count label sits. */
  mid: { x: number; y: number };
  callCount: number;
  /** The line points back to where the caller and callee are in the same column or reversed. */
  loops: boolean;
}

export interface CallTreeLayout {
  nodes: LaidNode[];
  ghosts: LaidGhost[];
  edges: LaidEdge[];
  width: number;
  height: number;
  rootX: number;
  rootY: number;
  hasCallers: boolean;
  hasCallees: boolean;
  /** Centres of the two column headings. */
  callerHeadX: number | null;
  calleeHeadX: number | null;
}

type Side = "caller" | "callee";

/**
 * Lays the tree out left to right, so every arrow reads the way a call goes:
 * callers on the left, the chosen function in the middle, callees on the right.
 * Each side is a tidy tree: leaves take consecutive rows, a parent sits level with the
 * middle of its children.
 */
export function layoutCallTree(tree: CallTreeOk): CallTreeLayout {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const root = byId.get(tree.root);
  if (!root) throw new Error("The call tree has no root.");

  const childrenOf = (side: Side, id: string) =>
    tree.nodes.filter((n) => n.side === side && n.parent === id);

  const ghostEdges = new Map<string, CallTreeEdge[]>();
  for (const edge of tree.edges) {
    if (edge.to !== null) continue;
    const list = ghostEdges.get(edge.from) ?? [];
    list.push(edge);
    ghostEdges.set(edge.from, list);
  }

  const pos = new Map<string, { x: number; y: number }>();
  const ghosts: LaidGhost[] = [];

  const ghostsFor = (id: string): Omit<LaidGhost, "cx" | "cy">[] => {
    const list = ghostEdges.get(id) ?? [];
    const shown = list.slice(0, MAX_GHOSTS);
    const rest = list.slice(MAX_GHOSTS);
    const out: Omit<LaidGhost, "cx" | "cy">[] = shown.map((e) => ({
      id: `g:${e.id}`,
      fromId: id,
      label: e.calleeText,
      state: e.state === "ambiguous" ? "ambiguous" : "unresolved",
      edgeIds: [e.id],
      callCount: e.callCount,
      candidates: e.candidateCount,
    }));
    if (rest.length > 0) {
      const states = new Set(rest.map((e) => e.state));
      out.push({
        id: `g:${rest[0].id}+`,
        fromId: id,
        label: `${rest.length} more calls`,
        state: states.size === 1 && states.has("ambiguous") ? "ambiguous" : states.size === 1 ? "unresolved" : "mixed",
        edgeIds: rest.map((e) => e.id),
        callCount: rest.reduce((sum, e) => sum + e.callCount, 0),
        candidates: 0,
      });
    }
    return out;
  };

  /** Returns the row position (in pixels, before centring) of the node it places. */
  const place = (side: Side, node: CallTreeNode, rows: { next: number }): number => {
    const sign = side === "caller" ? -1 : 1;
    const x = sign * node.depth * COL;
    const kids = childrenOf(side, node.id);
    const ghostKids = side === "callee" ? ghostsFor(node.id) : [];
    let y: number;
    if (kids.length === 0 && ghostKids.length === 0) {
      y = rows.next++ * ROW;
    } else {
      const ys = kids.map((kid) => place(side, kid, rows));
      for (const ghost of ghostKids) {
        const gy = rows.next++ * ROW;
        ghosts.push({ ...ghost, cx: sign * (node.depth + 1) * COL, cy: gy });
        ys.push(gy);
      }
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(node.id, { x, y });
    return y;
  };

  /** Places one whole side and centres it on the root row. */
  const placeSide = (side: Side) => {
    const rows = { next: 0 };
    const ghostStart = ghosts.length;
    const kids = childrenOf(side, root.id);
    const rootGhosts = side === "callee" ? ghostsFor(root.id) : [];
    const ys = kids.map((kid) => place(side, kid, rows));
    for (const ghost of rootGhosts) {
      const gy = rows.next++ * ROW;
      ghosts.push({ ...ghost, cx: COL, cy: gy });
      ys.push(gy);
    }
    if (ys.length === 0) return;
    const centre = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (const kid of tree.nodes) {
      if (kid.side !== side) continue;
      const p = pos.get(kid.id);
      if (p) p.y -= centre;
    }
    for (let i = ghostStart; i < ghosts.length; i++) ghosts[i].cy -= centre;
  };

  pos.set(root.id, { x: 0, y: 0 });
  placeSide("caller");
  placeSide("callee");

  // Shift everything into positive coordinates.
  const xs = [...pos.values()].map((p) => p.x).concat(ghosts.map((g) => g.cx));
  const ys = [...pos.values()].map((p) => p.y).concat(ghosts.map((g) => g.cy));
  const shiftX = PAD_X + NODE_W / 2 - Math.min(...xs);
  const shiftY = PAD_TOP + NODE_H / 2 - Math.min(...ys);
  const nodes: LaidNode[] = tree.nodes.map((node) => {
    const p = pos.get(node.id) ?? { x: 0, y: 0 };
    return { node, cx: p.x + shiftX, cy: p.y + shiftY };
  });
  for (const ghost of ghosts) {
    ghost.cx += shiftX;
    ghost.cy += shiftY;
  }
  const at = new Map(nodes.map((n) => [n.node.id, n]));

  const edges: LaidEdge[] = [];
  for (const edge of tree.edges) {
    if (edge.to === null) continue;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (!from || !to) continue;
    const toNode = to.node;
    const fromNode = from.node;
    const isTree =
      (edge.side === "callee" && toNode.parent === fromNode.id && toNode.side === "callee") ||
      (edge.side === "caller" && fromNode.parent === toNode.id && fromNode.side === "caller");
    const { path, mid, loops } = curve(from.cx, from.cy, to.cx, to.cy, edge.from === edge.to);
    edges.push({
      id: edge.id,
      edgeIds: [edge.id],
      kind: isTree ? "tree" : "back",
      from: edge.from,
      to: edge.to,
      path,
      mid,
      callCount: edge.callCount,
      loops,
    });
  }
  for (const ghost of ghosts) {
    const from = at.get(ghost.fromId);
    if (!from) continue;
    const { path, mid } = curve(from.cx, from.cy, ghost.cx, ghost.cy, false);
    edges.push({
      id: ghost.id,
      edgeIds: ghost.edgeIds,
      kind: "ghost",
      from: ghost.fromId,
      to: ghost.id,
      path,
      mid,
      callCount: ghost.callCount,
      loops: false,
    });
  }

  const rootAt = at.get(root.id);
  const maxX = Math.max(...xs.map((x) => x + shiftX)) + NODE_W / 2;
  const maxY = Math.max(...ys.map((y) => y + shiftY)) + NODE_H / 2;
  const hasCallers = tree.nodes.some((n) => n.side === "caller");
  const hasCallees = tree.nodes.some((n) => n.side === "callee") || ghosts.length > 0;
  return {
    nodes,
    ghosts,
    edges,
    width: maxX + PAD_X + 24,
    height: maxY + PAD_BOTTOM,
    rootX: rootAt?.cx ?? 0,
    rootY: rootAt?.cy ?? 0,
    hasCallers,
    hasCallees,
    callerHeadX: hasCallers ? (rootAt?.cx ?? 0) - COL : null,
    calleeHeadX: hasCallees ? (rootAt?.cx ?? 0) + COL : null,
  };
}

/** A line from one box to another, leaving and entering through the sides that face each other. */
function curve(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  self: boolean,
): { path: string; mid: { x: number; y: number }; loops: boolean } {
  const half = NODE_W / 2;
  if (self) {
    const r = x1 + half;
    return {
      path: `M ${r} ${y1 - 10} C ${r + 52} ${y1 - 34}, ${r + 52} ${y1 + 34}, ${r} ${y1 + 10}`,
      mid: { x: r + 40, y: y1 },
      loops: true,
    };
  }
  if (Math.abs(x1 - x2) < 1) {
    // Same column: bow out to the right so the line does not run through the boxes between.
    const r = x1 + half;
    const bow = 64 + Math.min(Math.abs(y2 - y1) / 4, 40);
    return {
      path: `M ${r} ${y1} C ${r + bow} ${y1}, ${r + bow} ${y2}, ${r} ${y2}`,
      mid: { x: r + bow * 0.75, y: (y1 + y2) / 2 },
      loops: true,
    };
  }
  const forward = x1 < x2;
  const sx = forward ? x1 + half : x1 - half;
  const ex = forward ? x2 - half : x2 + half;
  const pull = Math.max(24, Math.abs(ex - sx) / 2);
  const dir = forward ? 1 : -1;
  return {
    path: `M ${sx} ${y1} C ${sx + dir * pull} ${y1}, ${ex - dir * pull} ${y2}, ${ex} ${y2}`,
    mid: { x: (sx + ex) / 2, y: (y1 + y2) / 2 },
    loops: !forward,
  };
}

/* ---------- draw-in timing (pure; see CallGraphView and callGraph.css) ----------
   The call map draws itself in like the main map and the blast map: the chosen function
   lands, the pen draws each call line out from it, and each box lands as its line reaches
   it, so the map unrolls level by level. When Reach goes up, the levels already on the
   page stay put and only the new ones unroll. Delays are staggered but capped. */
/** How long a call line takes to draw (keep in sync with .calls-edge.draw in callGraph.css). */
export const CALLS_EDGE_MS = 260;
/** Pause between a box landing and the lines out of it starting. */
export const CALLS_LEAD = 60;
/** Gap between two lines of the same level starting. */
export const CALLS_STEP = 24;
/** Only this many lines per level are staggered; the rest share the last slot. */
export const CALLS_MAX_STAGGER = 6;
/** Nothing waits longer than this before it starts. */
export const CALLS_MAX_DELAY = 900;
/** A box lands once its line is this far drawn. */
const LAND_AT = 0.7;

export interface CallDrawPlan {
  /** Delay (ms) before each box lands, by node or ghost id. Absent: already on the page. */
  boxes: Map<string, number>;
  /** Each line's delay (ms), and whether the pen starts at its arrow end. Absent: already drawn. */
  lines: Map<string, { delay: number; inward: boolean }>;
}

/**
 * When each box and line of a call map draws in. `settledDepth` is how many levels were
 * already on the page (the same function at a smaller Reach); those don't draw in again.
 * -1 (the default) draws everything.
 */
export function callDrawPlan(layout: CallTreeLayout, settledDepth = -1): CallDrawPlan {
  const depth = new Map<string, number>();
  for (const { node } of layout.nodes) depth.set(node.id, node.depth);
  for (const ghost of layout.ghosts) depth.set(ghost.id, (depth.get(ghost.fromId) ?? 0) + 1);
  const levelOf = (id: string) => depth.get(id) ?? 0;
  const settled = (id: string) => levelOf(id) <= settledDepth;

  // A box on the page already counts as landed just early enough that the lines out of
  // it start at once.
  const arrival = new Map<string, number>();
  for (const id of depth.keys()) {
    if (settled(id)) arrival.set(id, -CALLS_LEAD);
    else if (levelOf(id) === 0) arrival.set(id, 0);
  }

  const plan: CallDrawPlan = { boxes: new Map(), lines: new Map() };
  const latestStart = CALLS_MAX_DELAY - CALLS_EDGE_MS * LAND_AT;

  // Lines that grow the tree, nearest level first, so each starts from a box that has a time.
  const growing = layout.edges
    .filter((line) => line.kind !== "back")
    .map((line) => {
      const fromFirst = levelOf(line.from) <= levelOf(line.to);
      return { line, near: fromFirst ? line.from : line.to, far: fromFirst ? line.to : line.from };
    })
    .sort((a, b) => levelOf(a.far) - levelOf(b.far));
  const perLevel = new Map<number, number>();
  for (const { line, near, far } of growing) {
    if (settled(far)) continue;
    const level = levelOf(far);
    const i = perLevel.get(level) ?? 0;
    perLevel.set(level, i + 1);
    const base = arrival.get(near) ?? 0;
    const start = Math.round(
      Math.min(Math.max(0, base + CALLS_LEAD + Math.min(i, CALLS_MAX_STAGGER) * CALLS_STEP), latestStart),
    );
    plan.lines.set(line.id, { delay: start, inward: near === line.to });
    const lands = Math.round(start + CALLS_EDGE_MS * LAND_AT);
    const known = arrival.get(far);
    if (known === undefined || lands < known) arrival.set(far, lands);
  }

  // A box no line grows into (reached by a line back from a box already drawn) lands
  // when its level would have.
  for (const id of depth.keys()) {
    if (settled(id)) continue;
    const at = arrival.get(id) ?? Math.min(levelOf(id) * (CALLS_LEAD + CALLS_EDGE_MS * LAND_AT), CALLS_MAX_DELAY);
    plan.boxes.set(id, Math.min(Math.max(0, Math.round(at)), CALLS_MAX_DELAY));
  }

  // Lines back to a box already drawn fade in once both their ends are there.
  for (const line of layout.edges) {
    if (line.kind !== "back" || (settled(line.from) && settled(line.to))) continue;
    const ends = Math.max(plan.boxes.get(line.from) ?? 0, plan.boxes.get(line.to) ?? 0);
    plan.lines.set(line.id, { delay: Math.min(ends + CALLS_LEAD * 2, CALLS_MAX_DELAY), inward: false });
  }
  return plan;
}

/** Counts for the heading and screen readers. */
export function summarize(tree: CallTreeOk): { callers: number; callees: number; unknown: number } {
  const callerIds = new Set<string>();
  const calleeIds = new Set<string>();
  for (const n of tree.nodes) {
    if (n.side === "caller") callerIds.add(n.id);
    if (n.side === "callee") calleeIds.add(n.id);
  }
  const unknown = tree.edges.filter((e) => e.to === null).length;
  return { callers: callerIds.size, callees: calleeIds.size, unknown };
}

/** The caller function's source with the call-site lines marked, numbered from the function's first line. */
export interface SourceLine {
  number: number;
  text: string;
  hit: boolean;
}

export function numberLines(
  source: string,
  firstLine: number,
  hits: { startLine: number; endLine: number }[],
  maxLines = 160,
): { lines: SourceLine[]; clipped: number } {
  const all = source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const lines = all.slice(0, maxLines).map((text, i) => {
    const number = firstLine + i;
    return { number, text, hit: hits.some((h) => number >= h.startLine && number <= Math.max(h.startLine, h.endLine)) };
  });
  return { lines, clipped: Math.max(0, all.length - maxLines) };
}
