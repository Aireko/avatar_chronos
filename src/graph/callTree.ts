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
    edges.push({ id: ghost.id, edgeIds: ghost.edgeIds, kind: "ghost", path, mid, callCount: ghost.callCount, loops: false });
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
