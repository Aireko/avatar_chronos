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
const PAD_X = 36;
const PAD_TOP = 56;
const PAD_BOTTOM = 36;
const LEVEL_GAP = 72;
const ROW_GAP = 16;
const COL = NODE_H + LEVEL_GAP;
const ROW = NODE_W + ROW_GAP;
/** Total width along a box side over which the lines meeting there are spread. */
const SLOT_SPAN = 120;
/** The most space left between two neighbouring lines on a box side. */
const MAX_SLOT_STEP = 24;
/** Unresolved calls shown per function before the rest fold into one "more" box. */
const MAX_GHOSTS = 3;
/** Callers (or callees) one box shows before the rest fold into a "N more" box. */
const PER_PARENT = 5;
/** Boxes drawn on each side of the chosen function, however far Reach goes. The rest fold. */
const SIDE_BUDGET = 14;
/** How many hidden neighbours one click on a "N more" box brings in. */
const PAGE = 10;

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

/** A "N more callers/callees" box. Clicking it brings in `step` more of them. */
export interface LaidFold {
  id: string;
  /** Key into `LayoutOptions.more`. */
  key: string;
  parentId: string;
  side: Side;
  hidden: number;
  step: number;
  cx: number;
  cy: number;
  col: number;
}

export interface LayoutOptions {
  /** Extra neighbours revealed per box, keyed by `foldKey`. */
  more?: ReadonlyMap<string, number>;
}

export const foldKey = (side: Side, id: string) => `${side}:${id}`;

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
  folds: LaidFold[];
  edges: LaidEdge[];
  width: number;
  height: number;
  rootX: number;
  rootY: number;
  hasCallers: boolean;
  hasCallees: boolean;
  /** The right-most column, so the draw-in can pace itself. */
  lastCol: number;
  /** Heights of the two level headings. */
  callerHeadY: number | null;
  calleeHeadY: number | null;
}

export type Side = "caller" | "callee";

interface Box {
  key: string;
  cx: number;
  cy: number;
}

interface Draft {
  id: string;
  edgeIds: string[];
  kind: LaidEdgeKind;
  from: string;
  to: string;
  a: Box;
  b: Box;
  self: boolean;
  callCount: number;
  col: number;
}

/** Which side of each box a line uses, matching how `curve` leaves and enters. */
const sidesOf = (a: Box, b: Box): ["l" | "r", "l" | "r"] =>
  Math.abs(a.cx - b.cx) < 1 ? ["r", "r"] : a.cx < b.cx ? ["r", "l"] : ["l", "r"];

/**
 * Lays the tree out left to right, so every arrow reads the way a call goes:
 * callers on the left, the chosen function in the middle, callees on the right.
 * Each side is a tidy tree: leaves take consecutive rows, a parent sits level with the
 * middle of its children.
 */
export function layoutCallTree(tree: CallTreeOk, opts: LayoutOptions = {}): CallTreeLayout {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const root = byId.get(tree.root);
  if (!root) throw new Error("The call tree has no root.");

  const kidMap = new Map<string, CallTreeNode[]>();
  for (const n of tree.nodes) {
    if (n.side === "root" || n.parent === null) continue;
    const key = foldKey(n.side, n.parent);
    const list = kidMap.get(key);
    if (list) list.push(n);
    else kidMap.set(key, [n]);
  }
  const calls = new Map<string, number>();
  for (const e of tree.edges) if (e.to !== null) calls.set(`${e.from}>${e.to}`, e.callCount);

  // Which neighbours each box shows. Nearest levels first, busiest calls first, and each side
  // draws at most SIDE_BUDGET boxes whatever Reach is: the rest fold into "N more" boxes.
  const shown = new Map<string, CallTreeNode[]>();
  const hidden = new Map<string, number>();
  for (const side of ["caller", "callee"] as const) {
    const queue: CallTreeNode[] = [root];
    let left = SIDE_BUDGET;
    // Boxes the person opened bring their extras with them, so opening one never pushes another out.
    for (const [key, n] of opts.more ?? []) if (key.startsWith(`${side}:`)) left += n;
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      const key = foldKey(side, parent.id);
      const all = kidMap.get(key);
      if (!all) continue;
      const weight = (n: CallTreeNode) => calls.get(side === "callee" ? `${parent.id}>${n.id}` : `${n.id}>${parent.id}`) ?? 0;
      const sorted = [...all].sort((a, b) => weight(b) - weight(a));
      const extra = opts.more?.get(key) ?? 0;
      let take = Math.min(sorted.length, PER_PARENT + extra);
      if (extra === 0) take = Math.min(take, left); // a box the person opened keeps what they asked for
      left = Math.max(0, left - take);
      const kept = sorted.slice(0, take);
      shown.set(key, kept);
      if (take < sorted.length) hidden.set(key, sorted.length - take);
      for (const kid of kept) queue.push(kid);
    }
  }

  const ghostEdges = new Map<string, CallTreeEdge[]>();
  for (const edge of tree.edges) {
    if (edge.to !== null) continue;
    const list = ghostEdges.get(edge.from) ?? [];
    list.push(edge);
    ghostEdges.set(edge.from, list);
  }

  const pos = new Map<string, { x: number; y: number }>();
  const ghosts: LaidGhost[] = [];
  const folds: LaidFold[] = [];

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

  const addFold = (side: Side, node: CallTreeNode, count: number, rows: { next: number }): number => {
    const key = foldKey(side, node.id);
    const cy = rows.next++ * ROW;
    const cx = (side === "caller" ? -1 : 1) * (node.depth + 1) * COL;
    folds.push({ id: `f:${key}`, key, parentId: node.id, side, hidden: count, step: count <= 15 ? count : PAGE, cx, cy, col: 0 });
    return cy;
  };

  /** Returns the row position (in pixels, before centring) of the node it places. */
  const place = (side: Side, node: CallTreeNode, rows: { next: number }): number => {
    const sign = side === "caller" ? -1 : 1;
    const x = sign * node.depth * COL;
    const key = foldKey(side, node.id);
    const kids = shown.get(key) ?? [];
    const more = hidden.get(key) ?? 0;
    const ghostKids = side === "callee" ? ghostsFor(node.id) : [];
    let y: number;
    if (kids.length === 0 && ghostKids.length === 0 && more === 0) {
      y = rows.next++ * ROW;
    } else {
      const ys = kids.map((kid) => place(side, kid, rows));
      for (const ghost of ghostKids) {
        const gy = rows.next++ * ROW;
        ghosts.push({ ...ghost, cx: sign * (node.depth + 1) * COL, cy: gy, col: 0 });
        ys.push(gy);
      }
      if (more > 0) ys.push(addFold(side, node, more, rows));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(node.id, { x, y });
    return y;
  };

  /** Places one whole side and centres it on the root row. */
  const placeSide = (side: Side) => {
    const rows = { next: 0 };
    const ghostStart = ghosts.length;
    const foldStart = folds.length;
    const key = foldKey(side, root.id);
    const kids = shown.get(key) ?? [];
    const rootGhosts = side === "callee" ? ghostsFor(root.id) : [];
    const ys = kids.map((kid) => place(side, kid, rows));
    for (const ghost of rootGhosts) {
      const gy = rows.next++ * ROW;
      ghosts.push({ ...ghost, cx: COL, cy: gy, col: 0 });
      ys.push(gy);
    }
    const rootMore = hidden.get(key) ?? 0;
    if (rootMore > 0) ys.push(addFold(side, root, rootMore, rows));
    if (ys.length === 0) return;
    const centre = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (const kid of tree.nodes) {
      if (kid.side !== side) continue;
      const p = pos.get(kid.id);
      if (p) p.y -= centre;
    }
    for (let i = ghostStart; i < ghosts.length; i++) ghosts[i].cy -= centre;
    for (let i = foldStart; i < folds.length; i++) folds[i].cy -= centre;
  };

  pos.set(root.id, { x: 0, y: 0 });
  placeSide("caller");
  placeSide("callee");

  // Shift everything into positive coordinates.
  const xs = [...pos.values()].map((p) => p.x).concat(ghosts.map((g) => g.cx), folds.map((f) => f.cx));
  const ys = [...pos.values()].map((p) => p.y).concat(ghosts.map((g) => g.cy), folds.map((f) => f.cy));
  const shiftX = PAD_TOP + NODE_H / 2 - Math.min(...xs);
  const shiftY = PAD_X + NODE_W / 2 - Math.min(...ys);
  const placed = tree.nodes.filter((n) => pos.has(n.id));
  const reach = Math.max(0, ...placed.filter((n) => n.side === "caller").map((n) => n.depth));
  const colOf = (side: CallTreeNode["side"], depth: number) =>
    side === "caller" ? reach - depth : side === "callee" ? reach + depth : reach;
  const nodes: LaidNode[] = placed.map((node) => {
    const p = pos.get(node.id) ?? { x: 0, y: 0 };
    return { node, cx: p.x + shiftX, cy: p.y + shiftY, col: colOf(node.side, node.depth) };
  });
  const at = new Map(nodes.map((n) => [n.node.id, n]));
  for (const ghost of ghosts) {
    ghost.cx += shiftX;
    ghost.cy += shiftY;
    ghost.col = (at.get(ghost.fromId)?.col ?? reach) + 1;
  }
  for (const fold of folds) {
    fold.cx += shiftX;
    fold.cy += shiftY;
    fold.col = colOf(fold.side, (at.get(fold.parentId)?.node.depth ?? 0) + 1);
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
      from: edge.from,
      to: edge.to,
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
      from: ghost.fromId,
      to: ghost.id,
      a: { key: ghost.fromId, cx: from.cx, cy: from.cy },
      b: { key: ghost.id, cx: ghost.cx, cy: ghost.cy },
      self: false,
      callCount: ghost.callCount,
      col: from.col,
    });
  }

  for (const fold of folds) {
    const parent = at.get(fold.parentId);
    if (!parent) continue;
    const p = { key: parent.node.id, cx: parent.cx, cy: parent.cy };
    const f = { key: fold.id, cx: fold.cx, cy: fold.cy };
    const into = fold.side === "callee"; // callees: the box calls into the fold; callers: the fold calls the box
    drafts.push({
      id: fold.id,
      edgeIds: [],
      kind: "ghost",
      from: into ? p.key : f.key,
      to: into ? f.key : p.key,
      a: into ? p : f,
      b: into ? f : p,
      self: false,
      callCount: 0,
      col: Math.min(parent.col, fold.col),
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
    from: draft.from,
    to: draft.to,
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
  const levelEnd = Math.max(...xs.map((x) => x + shiftX)) + NODE_H / 2;
  const rowEnd = Math.max(...ys.map((y) => y + shiftY)) + NODE_W / 2;
  const hasCallers = tree.nodes.some((n) => n.side === "caller");
  const hasCallees = tree.nodes.some((n) => n.side === "callee") || ghosts.length > 0;
  const rootLevel = rootAt?.cx ?? 0;
  const headAt = (level: number) => level - NODE_H / 2 - 10;
  // Everything above was laid out with levels along x and siblings along y; the map flows
  // down the page, so the finished boxes swap the two.
  const turn = <T extends { cx: number; cy: number }>(box: T): T => ({ ...box, cx: box.cy, cy: box.cx });
  return {
    nodes: nodes.map(turn),
    ghosts: ghosts.map(turn),
    folds: folds.map(turn),
    edges,
    width: rowEnd + PAD_X,
    height: levelEnd + PAD_BOTTOM,
    rootX: rootAt?.cy ?? 0,
    rootY: rootLevel,
    hasCallers,
    hasCallees,
    lastCol: Math.max(reach, ...nodes.map((n) => n.col), ...ghosts.map((g) => g.col), ...folds.map((f) => f.col)),
    callerHeadY: hasCallers ? headAt(rootLevel - COL) : null,
    calleeHeadY: hasCallees ? headAt(rootLevel + COL) : null,
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
  // The curve is worked out with levels along x; it is written out turned, so it runs down the page.
  const path =
    `M ${round(start.y)} ${round(start.x)} C ${round(leave.y)} ${round(leave.x)}, ` +
    `${round(aim.y)} ${round(aim.x)}, ${round(base.y)} ${round(base.x)} L ${round(end.y)} ${round(end.x)}`;
  return { path, tip: { x: tip.y, y: tip.x }, angle: round((Math.atan2(d.x, d.y) * 180) / Math.PI) };
}

/** A line from one box to another, leaving and entering through the sides that face each other. */
function curve(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  self: boolean,
): { path: string; mid: Point; loops: boolean; tip: Point; angle: number } {
  const half = NODE_H / 2;
  const turned = (x: number, y: number): Point => ({ x: y, y: x });
  if (self) {
    const r = x1 + half;
    const end = finish({ x: r, y: y1 - 10 }, { x: r + 60, y: y1 - 36 }, { x: r, y: y1 + 10 }, unit(-1, 0.3), 22);
    return { ...end, mid: turned(r + 40, y1), loops: true };
  }
  if (Math.abs(x1 - x2) < 1) {
    // Same column: bow out to the right so the line does not run through the boxes between.
    const r = x1 + half;
    const bow = 64 + Math.min(Math.abs(y2 - y1) / 4, 40);
    const end = finish({ x: r, y: y1 }, { x: r + bow, y: y1 }, { x: r, y: y2 }, { x: -1, y: 0 }, bow - TAIL);
    return { ...end, mid: turned(r + bow * 0.75, (y1 + y2) / 2), loops: true };
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
  return { ...end, mid: turned((sx + ex) / 2, (y1 + y2) / 2), loops: !forward };
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
  for (const fold of layout.folds) depth.set(fold.id, (depth.get(fold.parentId) ?? 0) + 1);
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
