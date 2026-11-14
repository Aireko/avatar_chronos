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
  /** Column from the left edge of the map; the draw-in reveals columns in this order. */
  col: number;
}

/** A call the indexer could not tie to one function: drawn as a dashed box that ends the branch. */
export interface LaidGhost {
  id: string;
  fromId: string;
  label: string;
  state: "unresolved" | "ambiguous" | "mixed";
  cx: number;
  cy: number;
  col: number;
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
  path: string;
  /** Where the call-count label sits. */
  mid: { x: number; y: number };
  callCount: number;
  /** The line points back to where the caller and callee are in the same column or reversed. */
  loops: boolean;
  /** Where the arrowhead's point touches the box it enters. */
  tip: Point;
  /** The way the arrowhead points, in degrees: along the last stretch of the line. */
  angle: number;
  /** The left-most column the line touches: the draw-in starts it once that column has landed. */
  col: number;
}

export interface Point {
  x: number;
  y: number;
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
  /** The right-most column, so the draw-in can pace itself. */
  lastCol: number;
  /** Centres of the two column headings. */
  callerHeadX: number | null;
  calleeHeadX: number | null;
}

type Side = "caller" | "callee";

interface Box {
  key: string;
  cx: number;
  cy: number;
}

interface Draft {
  id: string;
  edgeIds: string[];
  kind: LaidEdgeKind;
  a: Box;
  b: Box;
  self: boolean;
  callCount: number;
  col: number;
}

/** Total height along a box side over which the lines meeting there are spread. */
const SLOT_SPAN = 38;
/** The most space left between two neighbouring lines on a box side. */
const MAX_SLOT_STEP = 11;

/** Which side of each box a line uses, matching how `curve` leaves and enters. */
const sidesOf = (a: Box, b: Box): ["l" | "r", "l" | "r"] =>
  Math.abs(a.cx - b.cx) < 1 ? ["r", "r"] : a.cx < b.cx ? ["r", "l"] : ["l", "r"];

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

  const ghostsFor = (id: string): Omit<LaidGhost, "cx" | "cy" | "col">[] => {
    const list = ghostEdges.get(id) ?? [];
    const shown = list.slice(0, MAX_GHOSTS);
    const rest = list.slice(MAX_GHOSTS);
    const out: Omit<LaidGhost, "cx" | "cy" | "col">[] = shown.map((e) => ({
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
        ghosts.push({ ...ghost, cx: sign * (node.depth + 1) * COL, cy: gy, col: 0 });
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
      ghosts.push({ ...ghost, cx: COL, cy: gy, col: 0 });
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
  const reach = Math.max(0, ...tree.nodes.filter((n) => n.side === "caller").map((n) => n.depth));
  const colOf = (side: CallTreeNode["side"], depth: number) =>
    side === "caller" ? reach - depth : side === "callee" ? reach + depth : reach;
  const nodes: LaidNode[] = tree.nodes.map((node) => {
    const p = pos.get(node.id) ?? { x: 0, y: 0 };
    return { node, cx: p.x + shiftX, cy: p.y + shiftY, col: colOf(node.side, node.depth) };
  });
  const at = new Map(nodes.map((n) => [n.node.id, n]));
  for (const ghost of ghosts) {
    ghost.cx += shiftX;
    ghost.cy += shiftY;
    ghost.col = (at.get(ghost.fromId)?.col ?? reach) + 1;
  }

  // Every line, before its shape is known: which two boxes it joins and how many calls it stands for.
  const drafts: Draft[] = [];
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
    drafts.push({
      id: edge.id,
      edgeIds: [edge.id],
      kind: isTree ? "tree" : "back",
      a: { key: fromNode.id, cx: from.cx, cy: from.cy },
      b: { key: toNode.id, cx: to.cx, cy: to.cy },
      self: edge.from === edge.to,
      callCount: edge.callCount,
      col: Math.min(from.col, to.col),
    });
  }
  for (const ghost of ghosts) {
    const from = at.get(ghost.fromId);
    if (!from) continue;
    drafts.push({
      id: ghost.id,
      edgeIds: ghost.edgeIds,
      kind: "ghost",
      a: { key: ghost.fromId, cx: from.cx, cy: from.cy },
      b: { key: ghost.id, cx: ghost.cx, cy: ghost.cy },
      self: false,
      callCount: ghost.callCount,
      col: from.col,
    });
  }

  // Lines that meet on one side of a box are spread along it, in the order of the boxes they come
  // from or go to, so they fan out without crossing instead of piling onto a single point.
  const slots = new Map<string, { draft: Draft; end: "a" | "b"; other: number }[]>();
  for (const draft of drafts) {
    if (draft.self) continue;
    const [sideA, sideB] = sidesOf(draft.a, draft.b);
    const add = (key: string, side: string, entry: { draft: Draft; end: "a" | "b"; other: number }) => {
      const id = `${key}|${side}`;
      slots.set(id, [...(slots.get(id) ?? []), entry]);
    };
    add(draft.a.key, sideA, { draft, end: "a", other: draft.b.cy });
    add(draft.b.key, sideB, { draft, end: "b", other: draft.a.cy });
  }
  const offsets = new Map<string, number>();
  for (const group of slots.values()) {
    group.sort((x, y) => x.other - y.other || x.draft.id.localeCompare(y.draft.id));
    const step = group.length > 1 ? Math.min(MAX_SLOT_STEP, SLOT_SPAN / (group.length - 1)) : 0;
    group.forEach((entry, i) => offsets.set(`${entry.draft.id}|${entry.end}`, (i - (group.length - 1) / 2) * step));
  }

  const edges: LaidEdge[] = drafts.map((draft) => ({
    id: draft.id,
    edgeIds: draft.edgeIds,
    kind: draft.kind,
    ...curve(
      draft.a.cx,
      draft.a.cy + (offsets.get(`${draft.id}|a`) ?? 0),
      draft.b.cx,
      draft.b.cy + (offsets.get(`${draft.id}|b`) ?? 0),
      draft.self,
    ),
    callCount: draft.callCount,
    col: draft.col,
  }));

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
    lastCol: Math.max(reach, ...nodes.map((n) => n.col), ...ghosts.map((g) => g.col)),
    callerHeadX: hasCallers ? (rootAt?.cx ?? 0) - COL : null,
    calleeHeadX: hasCallees ? (rootAt?.cx ?? 0) + COL : null,
  };
}

/** How far the arrowhead reaches back from its tip. */
export const HEAD_LEN = 14;
/** The last stretch of every line is straight, at least as long as the arrowhead, so the head sits on it. */
const TAIL = 20;
/** Steepest slope an arrow may enter a box at, as rise over run, so it never skims along the box edge. */
const MAX_ENTRY_SLOPE = 1.4;

/** The arrowhead as a path with its point at the origin, pointing along +x. */
export const HEAD_PATH = `M 0 0 L ${-HEAD_LEN} -5.5 L ${-HEAD_LEN + 3.5} 0 L ${-HEAD_LEN} 5.5 Z`;

const round = (n: number) => Math.round(n * 100) / 100;
const unit = (x: number, y: number): Point => {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
};

/**
 * A curve that leaves `start` along `leave`, comes in along the direction `d` and ends in a straight
 * stretch aimed at `tip`. The arrowhead is drawn at `tip` pointing along `d`, so it lines up with the
 * visible end of the line, whatever angle the line comes in at.
 */
function finish(start: Point, leave: Point, tip: Point, d: Point, pull: number) {
  const base = { x: tip.x - d.x * TAIL, y: tip.y - d.y * TAIL };
  const aim = { x: base.x - d.x * pull, y: base.y - d.y * pull };
  // The shaft stops inside the head, so its round cap never shows past the point.
  const end = { x: tip.x - d.x * HEAD_LEN * 0.6, y: tip.y - d.y * HEAD_LEN * 0.6 };
  const path =
    `M ${round(start.x)} ${round(start.y)} C ${round(leave.x)} ${round(leave.y)}, ` +
    `${round(aim.x)} ${round(aim.y)}, ${round(base.x)} ${round(base.y)} L ${round(end.x)} ${round(end.y)}`;
  return { path, tip, angle: round((Math.atan2(d.y, d.x) * 180) / Math.PI) };
}

/** A line from one box to another, leaving and entering through the sides that face each other. */
function curve(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  self: boolean,
): { path: string; mid: Point; loops: boolean; tip: Point; angle: number } {
  const half = NODE_W / 2;
  if (self) {
    const r = x1 + half;
    const end = finish({ x: r, y: y1 - 10 }, { x: r + 60, y: y1 - 36 }, { x: r, y: y1 + 10 }, unit(-1, 0.3), 22);
    return { ...end, mid: { x: r + 40, y: y1 }, loops: true };
  }
  if (Math.abs(x1 - x2) < 1) {
    // Same column: bow out to the right so the line does not run through the boxes between.
    const r = x1 + half;
    const bow = 64 + Math.min(Math.abs(y2 - y1) / 4, 40);
    const end = finish({ x: r, y: y1 }, { x: r + bow, y: y1 }, { x: r, y: y2 }, { x: -1, y: 0 }, bow - TAIL);
    return { ...end, mid: { x: r + bow * 0.75, y: (y1 + y2) / 2 }, loops: true };
  }
  const forward = x1 < x2;
  const dir = forward ? 1 : -1;
  const sx = forward ? x1 + half : x1 - half;
  const ex = forward ? x2 - half : x2 + half;
  const run = Math.abs(ex - sx);
  // Come in at the angle the line is actually travelling, eased a little, instead of always
  // level: a steep line gets a head that points down or up it, not flat into the box.
  const slope = Math.max(-MAX_ENTRY_SLOPE, Math.min(MAX_ENTRY_SLOPE, ((y2 - y1) / run) * 0.85));
  const end = finish(
    { x: sx, y: y1 },
    { x: sx + dir * Math.max(24, run / 2), y: y1 },
    { x: ex, y: y2 },
    unit(dir, slope),
    Math.max(16, run * 0.3),
  );
  return { ...end, mid: { x: (sx + ex) / 2, y: (y1 + y2) / 2 }, loops: !forward };
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
