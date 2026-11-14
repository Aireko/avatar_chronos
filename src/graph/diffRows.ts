/** Line-oriented two-way diff for side-by-side panes. */

export type DiffRow =
  | { kind: "context"; text: string; oldLine: number; newLine: number }
  | { kind: "removed"; text: string; oldLine: number; newLine: null }
  | { kind: "added"; text: string; oldLine: null; newLine: number };

/** Above this many LCS cells (16 MB of table) the middle is shown as one replaced block. */
const MAX_CELLS = 4_000_000;

function splitLines(text: string | null): string[] {
  if (text == null || text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * LCS diff on line arrays. The unchanged head and tail are matched first, so the
 * table only covers the edited middle; a huge middle falls back to "all removed,
 * then all added" instead of freezing the editor.
 */
export function buildDiffRows(before: string | null, after: string | null): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  const same = (text: string) => void rows.push({ kind: "context", text, oldLine: ++oldLine, newLine: ++newLine });
  const removed = (text: string) => void rows.push({ kind: "removed", text, oldLine: ++oldLine, newLine: null });
  const added = (text: string) => void rows.push({ kind: "added", text, oldLine: null, newLine: ++newLine });

  for (let k = 0; k < head; k++) same(a[k]);

  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  if (x.length * y.length > MAX_CELLS) {
    for (const text of x) removed(text);
    for (const text of y) added(text);
  } else {
    // table[i * w + j] = length of the longest common run of x[i..] and y[j..]
    const w = y.length + 1;
    const table = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        table[i * w + j] =
          x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        same(x[i]);
        i++;
        j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
        removed(x[i++]);
      } else {
        added(y[j++]);
      }
    }
    while (i < x.length) removed(x[i++]);
    while (j < y.length) added(y[j++]);
  }

  for (let k = a.length - tail; k < a.length; k++) same(a[k]);
  return rows;
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
