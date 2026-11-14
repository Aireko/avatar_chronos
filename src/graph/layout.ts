import type { Branch, Commit } from "../backend";

/* ---------- geometry ---------- */
export const COL_W = 200; // distance between commits along a row
export const LANE_H = 124; // distance between rows
export const STATION_R = 11; // commit circle radius
export const PAD_L = 110;
export const PAD_R = 240;
export const PAD_T = 150; // room above the top row for names, the head note and the action bar
export const PAD_B = 84;

const CORRIDOR = 84; // lines may only turn up/down this far from a column centre...
const CORRIDOR_STEP = 12; // ...or one step further, so two turns never share a path
const CORNER = 30; // how wide a turn sweeps
const WOBBLE = 0; // how far a "straight" pen stroke may drift, in pixels
const MAX_LABEL_W = 140; // commit messages stay narrower than the corridor
const MAX_FLAG_W = 120; // so do branch names

const LABEL_FONT = '400 16px "Patrick Hand", "Comic Sans MS", cursive';
const FLAG_FONT = '400 19px "Patrick Hand", "Comic Sans MS", cursive';

/* ---------- pen colours: defined per theme in graph.css ---------- */
export interface LineStyle {
  color: string;
  on: string;
}

export const LINES: LineStyle[] = Array.from({ length: 8 }, (_, i) => ({
  color: `var(--pen-${i})`,
  on: "var(--paper)",
}));
export const lineStyle = (index: number) => LINES[index % LINES.length];

/* ---------- types ---------- */
export interface Lane {
  index: number;
  name: string;
  color: string;
  on: string;
  isHead: boolean;
  y: number;
  tip: string; // hash of the line's newest commit
}

export type StationKind = "stop" | "interchange" | "origin";

export interface Flag {
  name: string;
  w: number;
  dy: number;
  color: string;
  isCurrent: boolean; // the checked-out branch
}

export interface GraphNode {
  id: string; // stable identity, so a replayed commit keeps its circle across a rebase
  commit: Commit;
  col: number;
  lane: number; // which branch line it belongs to
  row: number; // which row it is drawn on (rows are shared between branches)
  x: number;
  y: number;
  color: string;
  kind: StationKind;
  shape: string; // hand-drawn circle outline
  halo: string; // highlighter blob shown when selected
  label: string[];
  flags: Flag[];
}

export interface GraphEdge {
  key: string;
  d: string;
  color: string;
  ghost: boolean; // leads to history older than what is loaded
  order: number; // column of the newer end, used to time the draw-in
  lane: number; // the branch line whose colour it carries
}

/** Where a vertical line passes over a row line that belongs to another branch. */
export interface Bridge {
  key: string;
  x: number;
  y: number;
  color: string;
  order: number;
  lane: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bridges: Bridge[];
  lanes: Lane[];
  width: number;
  height: number;
  byHash: Map<string, GraphNode>;
  childrenOf: Map<string, string[]>;
}

/* ---------- hand-drawn shapes ---------- */
/** Repeatable "randomness": the same key always gives the same wobble. Returns -0.5 to 0.5. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  if (h === 0) h = 1;
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296 - 0.5;
  };
}

const n1 = (v: number) => Math.round(v * 10) / 10;

/** One pen stroke from A to B that bows very slightly to one side. */
function bow(ax: number, ay: number, bx: number, by: number, rnd: () => number): string {
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const drift = rnd() * 2 * WOBBLE * Math.min(1, len / 60);
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  return `Q ${n1((ax + bx) / 2 + nx * drift)} ${n1((ay + by) / 2 + ny * drift)} ${n1(bx)} ${n1(by)}`;
}

/** A circle drawn by hand: a closed curve through points that are not quite on the circle. */
function blob(radius: number, rnd: () => number, points = 9): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2 + rnd() * 0.25;
    const r = radius * (1.06 + rnd() * 0.16);
    pts.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  const mid = (a: [number, number], b: [number, number]) => `${n1((a[0] + b[0]) / 2)} ${n1((a[1] + b[1]) / 2)}`;
  let d = `M ${mid(pts[points - 1], pts[0])}`;
  for (let i = 0; i < points; i++) {
    d += ` Q ${n1(pts[i][0])} ${n1(pts[i][1])} ${mid(pts[i], pts[(i + 1) % points])}`;
  }
  return `${d} Z`;
}

/* ---------- text helpers (measured in real pixels) ---------- */
let measureCtx: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * 8;
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
 * A rebase gives replayed commits new hashes. To let their circles glide instead
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

interface Spec {
  key: string;
  parent: GraphNode;
  child: GraphNode;
  color: string;
  kind: "along" | "fork" | "merge";
  lane: number; // whose colour the line is drawn in
  xv: number; // x of the vertical run, for lines that change rows
}

/* ---------- line shapes ---------- */
// Every path is "M" followed by five strokes, so one shape can morph into another.
function straight(p: GraphNode, c: GraphNode, rnd: () => number): string {
  let d = `M ${p.x} ${p.y}`;
  let ax = p.x;
  let ay = p.y;
  for (let i = 1; i <= 5; i++) {
    const bx = p.x + ((c.x - p.x) * i) / 5;
    const by = p.y + ((c.y - p.y) * i) / 5;
    d += ` ${bow(ax, ay, bx, by, rnd)}`;
    ax = bx;
    ay = by;
  }
  return d;
}

/** Along the row, a sweeping turn, up or down at xv, a sweeping turn, along the row. */
function elbow(p: GraphNode, c: GraphNode, xv: number, rnd: () => number): string {
  const s = c.y > p.y ? 1 : -1;
  const r = Math.min(CORNER, Math.abs(c.y - p.y) / 2);
  const x = xv;
  return [
    `M ${p.x} ${p.y}`,
    bow(p.x, p.y, x - r, p.y, rnd),
    `Q ${n1(x)} ${p.y} ${n1(x)} ${n1(p.y + s * r)}`,
    bow(x, p.y + s * r, x, c.y - s * r, rnd),
    `Q ${n1(x)} ${c.y} ${n1(x + r)} ${c.y}`,
    bow(x + r, c.y, c.x, c.y, rnd),
  ].join(" ");
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
  [...commits].reverse().forEach((c, column) => colOf.set(c.hash, column));
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

  /* 5. Commit circles. */
  const nodes: GraphNode[] = [...commits].reverse().map((commit, column) => {
    const lane = chainOf.get(commit.hash) ?? 0;
    const row = chains[lane]?.row ?? 0;
    const id = idOf(commit.hash);
    const kind: StationKind =
      commit.parents.length === 0 ? "origin" : commit.parents.length > 1 ? "interchange" : "stop";
    return {
      id,
      commit,
      col: column,
      lane,
      row,
      x: PAD_L + column * COL_W,
      y: PAD_T + row * LANE_H,
      color: lineStyle(lane).color,
      kind,
      shape: blob(STATION_R, rng(`circle:${id}`)),
      halo: blob(STATION_R + 11, rng(`halo:${id}`), 7),
      label: wrapLabel(commit.message),
      flags: [],
    };
  });
  const byHash = new Map(nodes.map((n) => [n.commit.hash, n] as const));

  /* 6. Lines. Turns happen only in the corridors between columns, where there is no text. */
  const specs: Spec[] = [];
  const ghosts: GraphEdge[] = [];
  const childrenOf = new Map<string, string[]>();
  for (const child of nodes) {
    child.commit.parents.forEach((parentHash, index) => {
      const parent = byHash.get(parentHash);
      const key = `${idOf(parentHash)}>${child.id}`;
      if (!parent) {
        ghosts.push({
          key,
          d: `M ${child.x - COL_W * 0.5} ${child.y} L ${child.x} ${child.y}`,
          color: child.color,
          ghost: true,
          order: child.col,
          lane: child.lane,
        });
        return;
      }
      const kids = childrenOf.get(parentHash) ?? [];
      kids.push(child.commit.hash);
      childrenOf.set(parentHash, kids);
      specs.push({
        key,
        parent,
        child,
        color: index > 0 ? parent.color : child.color, // a merged-in line keeps its own colour
        kind: parent.row === child.row ? "along" : index === 0 ? "fork" : "merge",
        lane: index > 0 ? parent.lane : child.lane,
        xv: 0,
      });
    });
  }

  // When several lines leave (or join) the same commit in the same direction, the one that
  // travels furthest turns first. That way none of them has to cross another's row.
  const groups = new Map<string, Spec[]>();
  for (const s of specs) {
    if (s.kind === "along") continue;
    const owner = s.kind === "fork" ? s.parent.commit.hash : s.child.commit.hash;
    const direction = s.child.row > s.parent.row ? "down" : "up";
    const groupKey = `${s.kind}:${owner}:${direction}`;
    const list = groups.get(groupKey) ?? [];
    list.push(s);
    groups.set(groupKey, list);
  }
  const reach = (s: Spec) => Math.abs(s.child.row - s.parent.row);
  groups.forEach((list) => {
    list.sort((a, b) => reach(b) - reach(a));
    list.forEach((s, k) => {
      const step = Math.min(k, 1) * CORRIDOR_STEP;
      s.xv = s.kind === "fork" ? s.parent.x + CORRIDOR + step : s.child.x - CORRIDOR - step;
    });
  });

  // How far each branch line reaches along its row, so crossings can be found.
  const extent: [number, number][] = chains.map((chain) => {
    const xs = chain.hashes.map((h) => byHash.get(h)?.x ?? 0);
    return [Math.min(...xs), Math.max(...xs)];
  });
  for (const s of specs) {
    if (s.kind === "along") continue;
    for (const lane of [s.parent.lane, s.child.lane]) {
      extent[lane][0] = Math.min(extent[lane][0], s.xv);
      extent[lane][1] = Math.max(extent[lane][1], s.xv);
    }
  }
  const rowExtents: [number, number][][] = [];
  chains.forEach((chain, i) => {
    if (!rowExtents[chain.row]) rowExtents[chain.row] = [];
    rowExtents[chain.row].push(extent[i]);
  });

  const crossing: GraphEdge[] = [];
  const along: GraphEdge[] = [];
  const bridges: Bridge[] = [];
  for (const s of specs) {
    const rnd = rng(`line:${s.key}`);
    if (s.kind === "along") {
      along.push({
        key: s.key,
        d: straight(s.parent, s.child, rnd),
        color: s.color,
        ghost: false,
        order: s.child.col,
        lane: s.lane,
      });
      continue;
    }
    crossing.push({
      key: s.key,
      d: elbow(s.parent, s.child, s.xv, rnd),
      color: s.color,
      ghost: false,
      order: s.child.col,
      lane: s.lane,
    });
    const lo = Math.min(s.parent.row, s.child.row) + 1;
    const hi = Math.max(s.parent.row, s.child.row) - 1;
    for (let row = lo; row <= hi; row++) {
      if ((rowExtents[row] ?? []).some(([a, b]) => a < s.xv - 1 && b > s.xv + 1)) {
        bridges.push({
          key: `${s.key}@${row}`,
          x: s.xv,
          y: PAD_T + row * LANE_H,
          color: s.color,
          order: s.child.col,
          lane: s.lane,
        });
      }
    }
  }
  // Lines that change rows are drawn first, so the row they leave or join stays one clean colour.
  const edges = [...ghosts, ...crossing, ...along];

  /* 7. Names: above a line's first commit, and above the commit each branch points at. */
  const pending = new Map<string, { name: string; color: string; isCurrent: boolean }[]>();
  const addFlag = (hash: string, name: string, color: string, isCurrent: boolean) => {
    const list = pending.get(hash) ?? [];
    const existing = list.find((f) => f.name === name);
    if (existing) {
      existing.isCurrent = existing.isCurrent || isCurrent;
    } else {
      list.push({ name, color, isCurrent });
    }
    pending.set(hash, list);
  };
  for (const b of ordered) {
    const node = byHash.get(b.commitHash);
    if (!node) continue;
    const own = chains.find((c) => c.name === b.name);
    addFlag(b.commitHash, b.name, lineStyle(own ? own.index : node.lane).color, b.isHead);
  }
  for (const chain of chains) {
    addFlag(chain.hashes[chain.hashes.length - 1], chain.name, lineStyle(chain.index).color, false);
  }
  for (const node of nodes) {
    const isHeadNode = node.commit.hash === head;
    const lift = isHeadNode ? 32 : 0; // leave room for the "head" note
    node.flags = (pending.get(node.commit.hash) ?? []).slice(0, isHeadNode ? 2 : 3).map((f, k) => {
      const name = fitText(f.name, FLAG_FONT, MAX_FLAG_W);
      return {
        name,
        w: textWidth(name, FLAG_FONT),
        dy: -(STATION_R + 16) - lift - k * 25,
        color: f.color,
        isCurrent: f.isCurrent,
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
      tip: chain.hashes[0],
    };
  });

  const lastCol = Math.max(0, nodes.length - 1);
  return {
    nodes,
    edges,
    bridges,
    lanes,
    width: PAD_L + lastCol * COL_W + PAD_R,
    height: PAD_T + (rowCount - 1) * LANE_H + PAD_B,
    byHash,
    childrenOf,
  };
}

/* ---------- draw-in ---------- */
/** The columns that are drawn in one after another when a map opens. Everything else is simply there. */
export interface DrawWindow {
  from: number;
  to: number;
  step: number; // ms between neighbouring columns
}

const DRAW_SPAN_MAX = 24; // columns either side of the focus, however far out the map is zoomed
const DRAW_TOTAL_MS = 840; // the whole stagger fits in this, however many columns are on screen

/**
 * Only the columns around `focusCol` that fit in a `viewWidth`-pixel window are staggered,
 * so opening a history of thousands of commits still animates a dozen or so.
 */
export function drawInWindow(focusCol: number, lastCol: number, viewWidth: number, zoom = 1): DrawWindow {
  if (lastCol < 0) return { from: 0, to: -1, step: 0 };
  const focus = Math.min(lastCol, Math.max(0, focusCol));
  const half = Math.min(DRAW_SPAN_MAX, Math.ceil(viewWidth / (COL_W * Math.max(0.1, zoom)) / 2) + 1);
  const from = Math.max(0, focus - half);
  const to = Math.min(lastCol, focus + half);
  const step = Math.floor(Math.min(70, DRAW_TOTAL_MS / Math.max(1, to - from)));
  return { from, to, step };
}

/** Delay for something in column `col`, or null when it lies outside the window and should not animate. */
export function drawDelay(win: DrawWindow, col: number): number | null {
  if (col < win.from || col > win.to) return null;
  return (col - win.from) * win.step;
}

/* ---------- landing mark ---------- */
/**
 * A loop scribbled round a commit with a marker: a little more than one turn, opening
 * outwards, so the pen's start and end overlap like a real hand-drawn circle.
 */
export function scribbleLoop(radius: number, seed: string, turns = 1.18): string {
  const rnd = rng(`loop:${seed}`);
  const count = Math.max(6, Math.round(12 * turns));
  const start = -Math.PI * 0.62;
  const pts: [number, number][] = [];
  for (let i = 0; i <= count; i++) {
    const angle = start + (i / count) * turns * Math.PI * 2 + rnd() * 0.12;
    const r = radius * (0.95 + (i / count) * 0.14 + rnd() * 0.08);
    pts.push([Math.cos(angle) * r, Math.sin(angle) * r * 0.92]);
  }
  const p = (q: [number, number]) => `${n1(q[0])} ${n1(q[1])}`;
  const mid = (a: [number, number], b: [number, number]) => `${n1((a[0] + b[0]) / 2)} ${n1((a[1] + b[1]) / 2)}`;
  let d = `M ${p(pts[0])}`;
  for (let i = 1; i < pts.length - 1; i++) d += ` Q ${p(pts[i])} ${mid(pts[i], pts[i + 1])}`;
  return `${d} L ${p(pts[pts.length - 1])}`;
}

/* ---------- camera ---------- */
/** Where the map looks: content point (x, y), in unzoomed sheet pixels, seen at `zoom`. */
export interface CameraShot {
  zoom: number;
  x: number;
  y: number;
}

/** Cubic ease-out over 0..1 (clamped, since a frame's timestamp can fall just outside). */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

/**
 * The camera part way (`t`, 0..1) through a glide. Zoom changes geometrically, so each
 * moment of the glide feels like the same amount of zoom whether going in or out.
 */
export function cameraAt(from: CameraShot, to: CameraShot, t: number): CameraShot {
  const e = easeOut(t);
  const zoom = from.zoom > 0 && to.zoom > 0 ? from.zoom * (to.zoom / from.zoom) ** e : to.zoom;
  return {
    zoom,
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
  };
}

/** How long a glide takes: a zoom or short hop takes `base` ms, longer pans up to `max`. */
export function glideMs(from: CameraShot, to: CameraShot, base = 200, max = 280): number {
  const screenDistance = Math.hypot(to.x - from.x, to.y - from.y) * to.zoom;
  return Math.round(Math.min(max, base + screenDistance * 0.05));
}

/**
 * The zoom at which a `w`×`h` drawing fits a `viewW`×`viewH` view with `margin` px clear
 * on every side, rounded down to a whole percent and kept within [min, max].
 */
export function fitZoom(
  w: number,
  h: number,
  viewW: number,
  viewH: number,
  margin: number,
  min: number,
  max: number,
): number {
  const z = Math.min((viewW - 2 * margin) / Math.max(1, w), (viewH - 2 * margin) / Math.max(1, h));
  if (!Number.isFinite(z)) return min;
  return Math.min(max, Math.max(min, Math.floor(z * 100) / 100));
}

/**
 * Where to centre one axis when fitting [from, to] into `view` px at `zoom`: the middle when it
 * fits, otherwise as close to `current` as possible while still filling the view.
 */
export function fitAxis(from: number, to: number, view: number, margin: number, zoom: number, current: number): number {
  const half = Math.max(0, view / 2 - margin) / zoom;
  if (to - from <= half * 2) return (from + to) / 2;
  return Math.min(to - half, Math.max(from + half, current));
}

/**
 * The zoom factor for one Ctrl+wheel event. A mouse notch (about 100px) is a step of about
 * 12%, like the zoom keys; a trackpad pinch sends many small deltas that add up smoothly.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const capped = Math.max(-240, Math.min(240, px));
  return Math.exp(-capped * 0.00115);
}

/* ---------- minimap overview ---------- */
/** One branch line squeezed to a single stroke, for the minimap's whole-history strip. */
export interface LaneSpan {
  key: string;
  color: string;
  x1: number;
  x2: number;
  y: number;
}

/** The stretch of each branch line on each row, oldest to newest commit. */
export function laneSpans(nodes: Pick<GraphNode, "lane" | "row" | "x" | "y" | "color">[]): LaneSpan[] {
  const spans = new Map<string, LaneSpan>();
  for (const node of nodes) {
    const key = `${node.lane}:${node.row}`;
    const span = spans.get(key);
    if (!span)
      spans.set(key, {
        key,
        color: node.color,
        x1: node.x,
        x2: node.x,
        y: node.y,
      });
    else {
      span.x1 = Math.min(span.x1, node.x);
      span.x2 = Math.max(span.x2, node.x);
    }
  }
  return [...spans.values()];
}

/** The on-screen part of a scrolled axis, as fractions (0..1) of its whole length. */
export function visibleWindow(scroll: number, view: number, content: number): { start: number; size: number } {
  if (content <= 0 || view >= content) return { start: 0, size: 1 };
  const size = view / content;
  return { start: Math.min(1 - size, Math.max(0, scroll / content)), size };
}

/** The scroll position that puts the start of the on-screen window at fraction `start`. */
export function scrollForWindow(start: number, view: number, content: number): number {
  return Math.min(Math.max(0, content - view), Math.max(0, start * content));
}
