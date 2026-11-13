import type { Branch, Commit } from "../backend";

/* ---------- geometry ---------- */
export const COL_W = 190; // distance between commits along a row
export const LANE_H = 132; // distance between rows
export const STATION_R = 15; // ball radius
export const PAD_L = 120;
export const PAD_R = 260;
export const PAD_T = 130; // room above the top row for name flags and action bubbles
export const PAD_B = 90;
export const INSPECTOR_W = 450; // width the ticket covers, including its margin

const CORRIDOR = 80; // lines may only turn up/down this far from a column centre...
const CORRIDOR_STEP = 15; // ...or one step further, so two turns never share a path
const CORNER = 14; // corner radius of a turn
const MAX_LABEL_W = 128; // commit messages stay narrower than the corridor
const MAX_FLAG_W = 112; // so do branch name flags (plus their padding)

const LABEL_FONT = '500 14px "Barlow Semi Condensed", "Barlow", "Segoe UI", sans-serif';
const FLAG_FONT = '600 14px "Barlow Semi Condensed", "Barlow", "Segoe UI", sans-serif';

/* ---------- branch colours (colour + readable text colour on top of it) ---------- */
export interface LineStyle {
  color: string;
  on: string;
}

export const LINES: LineStyle[] = [
  { color: "#E5484D", on: "#FFFFFF" },
  { color: "#2F5DE3", on: "#FFFFFF" },
  { color: "#1F9D6B", on: "#FFFFFF" },
  { color: "#F2A900", on: "#16203A" },
  { color: "#7B4FD6", on: "#FFFFFF" },
  { color: "#0E9AA7", on: "#FFFFFF" },
  { color: "#D6409F", on: "#FFFFFF" },
  { color: "#8B5E3C", on: "#FFFFFF" },
];
export const lineStyle = (index: number) => LINES[index % LINES.length];

/* ---------- types ---------- */
export interface Lane {
  index: number;
  name: string;
  color: string;
  on: string;
  isHead: boolean;
  y: number;
}

export type StationKind = "stop" | "interchange" | "origin";

export interface Flag {
  name: string;
  w: number;
  dy: number;
  color: string;
  on: string;
  isHead: boolean;
}

export interface GraphNode {
  id: string; // stable identity, so a replayed commit keeps its ball across a rebase
  commit: Commit;
  col: number;
  lane: number; // which branch line it belongs to
  row: number; // which row it is drawn on (rows are shared between branches)
  x: number;
  y: number;
  color: string;
  kind: StationKind;
  label: string[];
  flags: Flag[];
}

export interface GraphEdge {
  key: string;
  d: string;
  color: string;
  ghost: boolean; // leads to history older than what is loaded
  order: number; // column of the newer end, used to time the draw-in
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes: Lane[];
  width: number;
  height: number;
  byHash: Map<string, GraphNode>;
  childrenOf: Map<string, string[]>;
}

/* ---------- text helpers (measured in real pixels) ---------- */
let measureCtx: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function fitText(text: string, font: string, maxWidth: number): string {
  if (textWidth(text, font) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, font) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Wraps a commit message onto at most two lines that fit inside its column. */
function wrapLabel(text: string, maxLines = 2): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.trim().split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (textWidth(next, LABEL_FONT) <= MAX_LABEL_W) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    lines[maxLines - 1] = lines.slice(maxLines - 1).join(" ");
    lines.length = maxLines;
  }
  return lines.map((line) => fitText(line, LABEL_FONT, MAX_LABEL_W));
}

export const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function formatAge(unixSeconds: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - unixSeconds);
  const units: [number, string][] = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/* ---------- identities that survive a rebase ---------- */
/**
 * A rebase gives replayed commits new hashes. To let their balls glide instead
 * of vanish and reappear, a new commit inherits the identity of a commit that
 * just disappeared with the same author and message.
 */
export function carryIds(prev: Commit[], prevIds: Map<string, string>, next: Commit[]): Map<string, string> {
  const prevHashes = new Set(prev.map((c) => c.hash));
  const nextHashes = new Set(next.map((c) => c.hash));
  const ids = new Map<string, string>();
  const used = new Set<string>();

  for (const c of next) {
    if (!prevHashes.has(c.hash)) continue;
    const id = prevIds.get(c.hash) ?? c.hash;
    ids.set(c.hash, id);
    used.add(id);
  }

  const pool = new Map<string, string[]>();
  for (const c of prev) {
    if (nextHashes.has(c.hash)) continue;
    const signature = `${c.author}\n${c.message}`;
    const list = pool.get(signature) ?? [];
    list.push(prevIds.get(c.hash) ?? c.hash);
    pool.set(signature, list);
  }

  for (const c of next) {
    if (ids.has(c.hash)) continue;
    const candidates = pool.get(`${c.author}\n${c.message}`) ?? [];
    let id = candidates.shift();
    while (id !== undefined && used.has(id)) id = candidates.shift();
    if (id === undefined) id = used.has(c.hash) ? `${c.hash}+` : c.hash;
    ids.set(c.hash, id);
    used.add(id);
  }
  return ids;
}

/* ---------- which branch line does each commit belong to? ---------- */
const PRIMARY = ["main", "master", "trunk"];
const SECONDARY = ["develop", "dev", "development"];

function branchRank(b: Branch): number {
  if (PRIMARY.includes(b.name)) return 0;
  if (SECONDARY.includes(b.name)) return 1;
  if (b.isHead) return 2;
  return 3;
}

const sortBranches = (branches: Branch[]) =>
  [...branches].sort((a, b) => branchRank(a) - branchRank(b) || a.name.localeCompare(b.name));

/** Name for a line no branch points at any more, e.g. a merged and deleted branch. */
function inferLineName(commit: Commit, mergeMessage: string | undefined): string {
  const ref = commit.refs.find((r) => !r.startsWith("tag: ")) ?? commit.refs[0];
  if (ref === "HEAD") return "detached HEAD";
  if (ref) return ref.replace(/^HEAD -> /, "").replace(/^tag: /, "");
  if (mergeMessage) {
    const match =
      /Merge branch '([^']+)'/.exec(mergeMessage) ??
      /Merge remote-tracking branch '([^']+)'/.exec(mergeMessage) ??
      /Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(mergeMessage);
    if (match) return match[1];
  }
  return "unnamed branch";
}

interface Chain {
  index: number;
  name: string;
  isHead: boolean;
  hashes: string[]; // newest first
  start2: number; // occupied span on its row, in half-columns
  end2: number;
  anchor: number; // the chain it branched from, or -1
  row: number;
}

/* ---------- line shapes ---------- */
// Every path uses the same command sequence (M L Q L Q L) so one shape can morph into another.
function straight(p: GraphNode, c: GraphNode): string {
  const a = p.x + (c.x - p.x) / 3;
  const b = p.x + ((c.x - p.x) * 2) / 3;
  return `M ${p.x} ${p.y} L ${a} ${p.y} Q ${a} ${p.y} ${a} ${p.y} L ${b} ${c.y} Q ${b} ${c.y} ${b} ${c.y} L ${c.x} ${c.y}`;
}

/** Along the row, a rounded turn, straight up or down at xv, a rounded turn, along the row. */
function elbow(p: GraphNode, c: GraphNode, xv: number): string {
  const s = c.y > p.y ? 1 : -1;
  const r = Math.min(CORNER, Math.abs(c.y - p.y) / 2);
  return (
    `M ${p.x} ${p.y} L ${xv - r} ${p.y} Q ${xv} ${p.y} ${xv} ${p.y + s * r} ` +
    `L ${xv} ${c.y - s * r} Q ${xv} ${c.y} ${xv + r} ${c.y} L ${c.x} ${c.y}`
  );
}

/* ---------- main entry ---------- */
export function layoutGraph(
  commits: Commit[],
  branches: Branch[],
  head: string | null = null,
  ids: Map<string, string> = new Map(),
): GraphLayout {
  const commitByHash = new Map(commits.map((c) => [c.hash, c] as const));
  const idOf = (hash: string) => ids.get(hash) ?? hash;

  /* 1. Split history into branch lines: follow first parents back from each tip. */
  const chains: Chain[] = [];
  const chainOf = new Map<string, number>();
  const claim = (tip: string, name: string, isHead: boolean) => {
    let hash: string | undefined = tip;
    let chain: Chain | null = null;
    while (hash !== undefined && !chainOf.has(hash)) {
      const commit = commitByHash.get(hash);
      if (!commit) break;
      if (!chain) {
        chain = { index: chains.length, name, isHead, hashes: [], start2: 0, end2: 0, anchor: -1, row: 0 };
        chains.push(chain);
      }
      chain.hashes.push(hash);
      chainOf.set(hash, chain.index);
      hash = commit.parents[0];
    }
  };

  const ordered = sortBranches(branches);
  ordered.forEach((b) => claim(b.commitHash, b.name, b.isHead));
  const mergedBy = new Map<string, string>();
  for (const c of commits) c.parents.slice(1).forEach((p) => mergedBy.set(p, c.message));
  for (const c of commits) if (!chainOf.has(c.hash)) claim(c.hash, inferLineName(c, mergedBy.get(c.hash)), false);

  /* 2. One column per commit, oldest on the left. */
  const colOf = new Map<string, number>();
  [...commits].reverse().forEach((c, col) => colOf.set(c.hash, col));
  const col = (hash: string) => colOf.get(hash) ?? 0;

  /* 3. How much of a row does each line need? From where it branches off to where it ends or merges. */
  for (const chain of chains) {
    const oldest = commitByHash.get(chain.hashes[chain.hashes.length - 1]) as Commit;
    const parent = oldest.parents[0];
    if (parent !== undefined && colOf.has(parent)) {
      chain.start2 = 2 * col(parent) + 1;
      chain.anchor = chainOf.get(parent) ?? -1;
    } else {
      chain.start2 = 2 * col(oldest.hash) - (parent !== undefined ? 2 : 0);
    }
    chain.end2 = 2 * col(chain.hashes[0]) + 1;
  }
  for (const c of commits) {
    c.parents.slice(1).forEach((p) => {
      const ci = chainOf.get(p);
      if (ci !== undefined) chains[ci].end2 = Math.max(chains[ci].end2, 2 * col(c.hash) - 1);
    });
  }

  /* 4. Pack lines into rows: nearest free row to where the line branched from; rows are reused. */
  const rowSpans: [number, number][][] = [];
  const fits = (row: number, s: number, e: number) =>
    (rowSpans[row] ?? []).every(([a, b]) => s - b >= 2 || a - e >= 2);
  const place = (chain: Chain, row: number) => {
    if (!rowSpans[row]) rowSpans[row] = [];
    rowSpans[row].push([chain.start2, chain.end2]);
    chain.row = row;
  };
  const queue = [...chains].sort((a, b) => a.start2 - b.start2 || a.index - b.index);
  if (chains.length > 0) place(chains[0], 0);
  for (const chain of queue) {
    if (chain.index === 0) continue;
    const anchorRow = chain.anchor >= 0 ? chains[chain.anchor].row : 0;
    let chosen = -1;
    for (let d = 0; chosen === -1; d++) {
      const candidates = d === 0 ? [anchorRow] : [anchorRow + d, anchorRow - d];
      for (const row of candidates) {
        if (row >= 0 && fits(row, chain.start2, chain.end2)) {
          chosen = row;
          break;
        }
      }
    }
    place(chain, chosen);
  }
  const rowCount = Math.max(1, rowSpans.length);

  /* 5. Balls. */
  const nodes: GraphNode[] = [...commits].reverse().map((commit, column) => {
    const lane = chainOf.get(commit.hash) ?? 0;
    const row = chains[lane]?.row ?? 0;
    const kind: StationKind =
      commit.parents.length === 0 ? "origin" : commit.parents.length > 1 ? "interchange" : "stop";
    return {
      id: idOf(commit.hash),
      commit,
      col: column,
      lane,
      row,
      x: PAD_L + column * COL_W,
      y: PAD_T + row * LANE_H,
      color: lineStyle(lane).color,
      kind,
      label: wrapLabel(commit.message),
      flags: [],
    };
  });
  const byHash = new Map(nodes.map((n) => [n.commit.hash, n] as const));

  /* 6. Lines. Turns happen only in the corridors between columns, where there is no text. */
  const crossing: GraphEdge[] = [];
  const along: GraphEdge[] = [];
  const childrenOf = new Map<string, string[]>();
  const forkSlot = new Map<string, number>();
  const mergeSlot = new Map<string, number>();

  for (const child of nodes) {
    child.commit.parents.forEach((parentHash, index) => {
      const parent = byHash.get(parentHash);
      const key = `${idOf(parentHash)}>${child.id}`;
      if (!parent) {
        along.push({
          key,
          d: `M ${child.x - COL_W * 0.55} ${child.y} L ${child.x} ${child.y}`,
          color: child.color,
          ghost: true,
          order: child.col,
        });
        return;
      }
      const kids = childrenOf.get(parentHash) ?? [];
      kids.push(child.commit.hash);
      childrenOf.set(parentHash, kids);

      const color = index > 0 ? parent.color : child.color; // a merged-in line keeps its own colour
      if (parent.row === child.row) {
        along.push({ key, d: straight(parent, child), color, ghost: false, order: child.col });
      } else if (index === 0) {
        // Branching off: turn just after the parent, then run along the new row.
        const k = forkSlot.get(parentHash) ?? 0;
        forkSlot.set(parentHash, k + 1);
        const xv = parent.x + CORRIDOR + Math.min(k, 1) * CORRIDOR_STEP;
        crossing.push({ key, d: elbow(parent, child, xv), color, ghost: false, order: child.col });
      } else {
        // Merging in: run along the old row, then turn just before the merge commit.
        const k = mergeSlot.get(child.commit.hash) ?? 0;
        mergeSlot.set(child.commit.hash, k + 1);
        const xv = child.x - CORRIDOR - Math.min(k, 1) * CORRIDOR_STEP;
        crossing.push({ key, d: elbow(parent, child, xv), color, ghost: false, order: child.col });
      }
    });
  }
  // Lines that change rows are drawn first, so the row they leave or join stays one clean colour.
  const edges = [...crossing, ...along];

  /* 7. Name flags: above a line's first commit, and above the commit each branch points at. */
  const pending = new Map<string, { name: string; style: LineStyle; isHead: boolean }[]>();
  const addFlag = (hash: string, name: string, style: LineStyle, isHead: boolean) => {
    const list = pending.get(hash) ?? [];
    const existing = list.find((f) => f.name === name);
    if (existing) {
      existing.isHead = existing.isHead || isHead;
    } else {
      list.push({ name, style, isHead });
    }
    pending.set(hash, list);
  };
  for (const chain of chains) {
    addFlag(chain.hashes[chain.hashes.length - 1], chain.name, lineStyle(chain.index), false);
  }
  for (const b of ordered) {
    const node = byHash.get(b.commitHash);
    if (!node) continue;
    const own = chains.find((c) => c.name === b.name);
    addFlag(b.commitHash, b.name, lineStyle(own ? own.index : node.lane), b.isHead);
  }
  for (const node of nodes) {
    const isHeadNode = node.commit.hash === head;
    const list = (pending.get(node.commit.hash) ?? []).slice(0, isHeadNode ? 2 : 3);
    node.flags = list.map((f, k) => {
      const name = fitText(f.name, FLAG_FONT, MAX_FLAG_W);
      return {
        name,
        w: textWidth(name, FLAG_FONT) + 22,
        dy: -(STATION_R + 27) - (isHeadNode ? 32 : 0) - k * 28,
        color: f.style.color,
        on: f.style.on,
        isHead: f.isHead,
      };
    });
  }

  const lanes: Lane[] = chains.map((chain) => {
    const style = lineStyle(chain.index);
    return {
      index: chain.index,
      name: chain.name,
      color: style.color,
      on: style.on,
      isHead: chain.isHead,
      y: PAD_T + chain.row * LANE_H,
    };
  });

  const lastCol = Math.max(0, nodes.length - 1);
  return {
    nodes,
    edges,
    lanes,
    width: PAD_L + lastCol * COL_W + PAD_R,
    height: PAD_T + (rowCount - 1) * LANE_H + PAD_B,
    byHash,
    childrenOf,
  };
}