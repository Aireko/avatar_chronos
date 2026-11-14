/** Line-oriented two-way diff for side-by-side panes (and the ticket's function diff). */

export type DiffRow =
  | { kind: "context"; text: string; oldLine: number; newLine: number }
  | { kind: "removed"; text: string; oldLine: number; newLine: null }
  | { kind: "added"; text: string; oldLine: null; newLine: number };

/**
 * Most edit steps Myers' search may take on one stretch before it gives up there and
 * splits the stretch on lines found once on each side instead. Its work grows with
 * (lines × steps) and its memory with steps², so this keeps a keystroke's diff quick.
 */
const MAX_STEPS = 1000;
/** Rough cap on lines × steps for one search (a few milliseconds of work). */
const MAX_WORK = 10_000_000;
/**
 * Last resort for a stretch with no unique lines: a full LCS table, up to 16 MB of it.
 * The cap is shared by all the tables one diff builds, so a big rewrite split into many
 * pieces costs no more than the single table the diff used to build.
 */
const MAX_CELLS = 4_000_000;
/** Cap on the searches' lines × steps across one whole diff, so a big rewrite split into pieces stays quick. */
const MAX_TOTAL_WORK = 3 * MAX_WORK;
/** What the running diffLines call may still spend (reset at its start; diffs are synchronous). */
let cellsLeft = MAX_CELLS;
let workLeft = MAX_TOTAL_WORK;

function splitLines(text: string | null): string[] {
  if (text == null || text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Diff two texts line by line (see diffLines). */
export function buildDiffRows(before: string | null, after: string | null): DiffRow[] {
  return diffLines(splitLines(before), splitLines(after));
}

/** One step of the edit script: keep, remove or add a line. */
const KEEP = 0;
const DEL = 1;
const ADD = 2;
type Op = typeof KEEP | typeof DEL | typeof ADD;

/**
 * Minimal line diff (Myers' O((N+M)·D) search), shared by the side-by-side panes and
 * the ticket's function diff. Lines are compared as integer ids, and the unchanged
 * head and tail of each stretch are matched first. A stretch with too many edits for
 * the search is split on lines that appear exactly once on each side (patience
 * anchors) and each piece is diffed on its own. A piece with no such line gets a
 * full LCS table if it is small enough, and is otherwise shown as one replaced block. Within each run of changes, removed lines
 * come before added ones.
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffRow[] {
  const ids = new Map<string, number>();
  const id = (text: string) => {
    let n = ids.get(text);
    if (n === undefined) ids.set(text, (n = ids.size));
    return n;
  };
  const x = Int32Array.from(a, id);
  const y = Int32Array.from(b, id);

  const ops: Op[] = [];
  cellsLeft = MAX_CELLS;
  workLeft = MAX_TOTAL_WORK;
  diffRange(x, 0, x.length, y, 0, y.length, ops);

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === KEEP) {
      rows.push({ kind: "context", text: a[i], oldLine: ++i, newLine: ++j });
      k++;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end] !== KEEP) end++;
    for (let q = k; q < end; q++) {
      if (ops[q] === DEL) rows.push({ kind: "removed", text: a[i], oldLine: ++i, newLine: null });
    }
    for (let q = k; q < end; q++) {
      if (ops[q] === ADD) rows.push({ kind: "added", text: b[j], oldLine: null, newLine: ++j });
    }
    k = end;
  }
  return rows;
}

/** Appends the edit script turning x[xLo, xHi) into y[yLo, yHi) to `out`. */
function diffRange(x: Int32Array, xLo: number, xHi: number, y: Int32Array, yLo: number, yHi: number, out: Op[]) {
  let head = 0;
  while (xLo + head < xHi && yLo + head < yHi && x[xLo + head] === y[yLo + head]) head++;
  let tail = 0;
  while (xHi - tail > xLo + head && yHi - tail > yLo + head && x[xHi - 1 - tail] === y[yHi - 1 - tail]) tail++;
  for (let k = 0; k < head; k++) out.push(KEEP);
  const aLo = xLo + head;
  const aHi = xHi - tail;
  const bLo = yLo + head;
  const bHi = yHi - tail;

  // One side empty, or too different to line up at all: a plain replaced block.
  if (
    aLo === aHi ||
    bLo === bHi ||
    (!myers(x, aLo, aHi, y, bLo, bHi, out) &&
      !anchored(x, aLo, aHi, y, bLo, bHi, out) &&
      !lcsTable(x, aLo, aHi, y, bLo, bHi, out))
  ) {
    for (let k = aLo; k < aHi; k++) out.push(DEL);
    for (let k = bLo; k < bHi; k++) out.push(ADD);
  }

  for (let k = 0; k < tail; k++) out.push(KEEP);
}

/**
 * Myers' greedy search for the shortest edit script, keeping each step's frontier so
 * the path can be walked back. Returns false, appending nothing, when the stretch
 * needs more edits than the budget allows.
 */
function myers(x: Int32Array, xLo: number, xHi: number, y: Int32Array, yLo: number, yHi: number, out: Op[]) {
  const n = xHi - xLo;
  const m = yHi - yLo;
  const limit = Math.min(n + m, MAX_STEPS, Math.max(1, Math.floor(Math.min(MAX_WORK, workLeft) / (n + m))));
  const o = limit + 1;
  // v[o + k] = furthest x reached on diagonal k (k = x - y).
  const v = new Int32Array(2 * limit + 3);
  // trace[d] = the frontier after step d, for diagonals -d..d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let px = k === -d || (k !== d && v[o + k - 1] < v[o + k + 1]) ? v[o + k + 1] : v[o + k - 1] + 1;
      let py = px - k;
      while (px < n && py < m && x[xLo + px] === y[yLo + py]) {
        px++;
        py++;
      }
      v[o + k] = px;
      if (px >= n && py >= m) {
        trace.push(v.slice(o - d, o + d + 1));
        walkBack(trace, n, m, out);
        workLeft -= (n + m) * (d + 1);
        return true;
      }
    }
    trace.push(v.slice(o - d, o + d + 1));
  }
  workLeft -= (n + m) * (limit + 1);
  return false;
}

/** Follows the saved frontiers from the end back to the start and appends the script. */
function walkBack(trace: readonly Int32Array[], n: number, m: number, out: Op[]) {
  const rev: Op[] = [];
  let px = n;
  let py = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = px - py;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // The matched run after this step's edit, then the edit itself.
    const afterX = down ? prevX : prevX + 1;
    while (px > afterX) {
      rev.push(KEEP);
      px--;
      py--;
    }
    rev.push(down ? ADD : DEL);
    px = prevX;
    py = prevY;
  }
  while (px > 0) {
    rev.push(KEEP);
    px--;
  }
  for (let k = rev.length - 1; k >= 0; k--) out.push(rev[k]);
}

/**
 * Splits a stretch on lines that occur exactly once on each side, keeping the longest
 * run of them that is in the same order on both (patience diff), and diffs the pieces
 * between them. Returns false, appending nothing, when there is no such line.
 */
function anchored(x: Int32Array, xLo: number, xHi: number, y: Int32Array, yLo: number, yHi: number, out: Op[]) {
  // The index of each line seen once on the left, or -1 for a repeated line.
  const left = new Map<number, number>();
  for (let i = xLo; i < xHi; i++) left.set(x[i], left.has(x[i]) ? -1 : i);
  // The same for the right, for lines that are unique on the left.
  const right = new Map<number, number>();
  for (let j = yLo; j < yHi; j++) {
    const i = left.get(y[j]);
    if (i !== undefined && i !== -1) right.set(y[j], right.has(y[j]) ? -1 : j);
  }
  // Unique on both sides, in left-hand order.
  const pairs: number[] = [];
  for (let i = xLo; i < xHi; i++) {
    const j = right.get(x[i]);
    if (j !== undefined && j !== -1) pairs.push(i, j);
  }
  const count = pairs.length / 2;
  if (count === 0) return false;

  // Longest run whose right-hand positions also increase (patience sorting).
  const tops: number[] = [];
  const back = new Int32Array(count).fill(-1);
  for (let p = 0; p < count; p++) {
    let lo = 0;
    let hi = tops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tops[mid] * 2 + 1] < pairs[p * 2 + 1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[p] = tops[lo - 1];
    tops[lo] = p;
  }
  const chain: number[] = [];
  for (let p = tops[tops.length - 1]; p !== -1; p = back[p]) chain.push(p);

  let i = xLo;
  let j = yLo;
  for (let c = chain.length - 1; c >= 0; c--) {
    const ai = pairs[chain[c] * 2];
    const bj = pairs[chain[c] * 2 + 1];
    diffRange(x, i, ai, y, j, bj, out);
    out.push(KEEP);
    i = ai + 1;
    j = bj + 1;
  }
  diffRange(x, i, xHi, y, j, yHi, out);
  return true;
}

/**
 * Longest-common-subsequence table over the whole stretch: quadratic, so only while the
 * diff's shared MAX_CELLS budget lasts. Returns false, appending nothing, past it.
 */
function lcsTable(x: Int32Array, xLo: number, xHi: number, y: Int32Array, yLo: number, yHi: number, out: Op[]) {
  const n = xHi - xLo;
  const m = yHi - yLo;
  if (n * m > cellsLeft) return false;
  cellsLeft -= n * m;
  // table[i * w + j] = length of the longest common run of x[i..] and y[j..]
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        x[xLo + i] === y[yLo + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[xLo + i] === y[yLo + j]) {
      out.push(KEEP);
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      out.push(DEL);
      i++;
    } else {
      out.push(ADD);
      j++;
    }
  }
  for (; i < n; i++) out.push(DEL);
  for (; j < m; j++) out.push(ADD);
  return true;
}

/** How many lines the right side gained and the left side lost. */
export function diffStats(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "added") added++;
    else if (row.kind === "removed") removed++;
  }
  return { added, removed };
}

/** Row index where each run of changed lines starts, in order (for "next change"). */
export function changeStarts(rows: readonly DiffRow[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== "context" && (i === 0 || rows[i - 1].kind === "context")) starts.push(i);
  }
  return starts;
}

/**
 * The change to jump to from row `current` (-1 before the first jump), stepping
 * forward or back through `starts` and wrapping around the ends.
 */
export function stepChange(starts: readonly number[], current: number, dir: 1 | -1): number | null {
  if (starts.length === 0) return null;
  if (dir === 1) return starts.find((s) => s > current) ?? starts[0];
  for (let k = starts.length - 1; k >= 0; k--) if (starts[k] < current) return starts[k];
  return starts[starts.length - 1];
}

/**
 * What a screen reader hears after a jump from row `from` (-1 before the first jump)
 * to the change starting at row `at`, which sits at 0-based working-tree `line`.
 */
export function describeChange(starts: readonly number[], from: number, at: number, dir: 1 | -1, line: number): string {
  const index = starts.indexOf(at);
  const text = `Change ${index + 1} of ${starts.length}, line ${line + 1}`;
  if (from === -1) return text;
  if (starts.length === 1) return `${text}, the only change`;
  if (dir === 1 ? at <= from : at >= from) return `${text}, wrapped to the ${dir === 1 ? "first" : "last"}`;
  return text;
}

/** Lines in a text, as the editor shows them: one more than its line breaks. */
export function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/* ---------- matching rows to the editable pane ----------
   The read-only pane shows every row (with blank spacers where lines were added);
   the editable pane is a plain textarea holding only working-tree lines, so it has
   no spacers for removed lines. These map a scroll position, counted in rows or
   lines, from one pane to the other, so both panes show the same code. */

export interface RowMap {
  /** lineOfRow[r] = working-tree lines in rows [0, r); length rows + 1. */
  lineOfRow: number[];
  /** rowOfLine[l] = the row showing working-tree line l; length lines + 1 (the last is rows.length). */
  rowOfLine: number[];
}

export function rowMap(rows: readonly DiffRow[]): RowMap {
  const lineOfRow = [0];
  const rowOfLine: number[] = [];
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].kind !== "removed") rowOfLine.push(r);
    lineOfRow.push(rowOfLine.length);
  }
  rowOfLine.push(rows.length);
  return { lineOfRow, rowOfLine };
}

/**
 * A row position (fractional; 0 is the top of the first row) to the matching line
 * position in the editable pane. Across removed rows the line holds still, since
 * the editable pane has nothing there. Positions outside the rows pass through.
 */
export function rowToLine(map: RowMap, pos: number): number {
  const rows = map.lineOfRow.length - 1;
  const lines = map.rowOfLine.length - 1;
  if (!(pos > 0)) return pos || 0;
  if (pos >= rows) return lines + (pos - rows);
  const r = Math.floor(pos);
  const hasLine = map.lineOfRow[r + 1] > map.lineOfRow[r];
  return map.lineOfRow[r] + (hasLine ? pos - r : 0);
}

/** A line position in the editable pane to the matching row position (inverse of rowToLine). */
export function lineToRow(map: RowMap, pos: number): number {
  const rows = map.lineOfRow.length - 1;
  const lines = map.rowOfLine.length - 1;
  if (!(pos > 0)) return pos || 0;
  if (pos >= lines) return rows + (pos - lines);
  const l = Math.floor(pos);
  return map.rowOfLine[l] + (pos - l);
}

/**
 * What to draw behind the editable pane, in working-tree line numbers (0-based):
 * runs of added lines, and gaps (between two lines) where lines were removed.
 */
export interface EditMark {
  kind: "added" | "gap";
  /** First added line, or the line the gap sits above. */
  line: number;
  /** Lines added, or lines removed at the gap. */
  count: number;
}

export function editMarks(rows: readonly DiffRow[]): EditMark[] {
  const marks: EditMark[] = [];
  let line = 0;
  for (const row of rows) {
    if (row.kind !== "context") {
      const kind = row.kind === "added" ? "added" : "gap";
      const last = marks[marks.length - 1];
      const end = last ? (last.kind === "added" ? last.line + last.count : last.line) : -1;
      if (last && last.kind === kind && end === line) last.count++;
      else marks.push({ kind, line, count: 1 });
    }
    if (row.kind !== "removed") line++;
  }
  return marks;
}
