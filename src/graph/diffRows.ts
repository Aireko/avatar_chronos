/** Line-oriented two-way diff for side-by-side panes. */

export type DiffRow =
  | { kind: "context"; text: string; oldLine: number; newLine: number }
  | { kind: "removed"; text: string; oldLine: number; newLine: null }
  | { kind: "added"; text: string; oldLine: null; newLine: number };

function splitLines(text: string | null): string[] {
  if (text == null || text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers-style LCS on line arrays; keeps memory reasonable for typical source files. */
export function buildDiffRows(before: string | null, after: string | null): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // DP table of LCS lengths (row-by-row to save memory)
  const prev = new Uint16Array(m + 1);
  const cur = new Uint16Array(m + 1);
  const choose = new Uint8Array((n + 1) * (m + 1)); // 0=diag, 1=up, 2=left

  for (let i = 1; i <= n; i++) {
    cur[0] = 0;
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = (prev[j - 1] + 1) as number;
        choose[i * (m + 1) + j] = 0;
      } else if (prev[j] >= cur[j - 1]) {
        cur[j] = prev[j];
        choose[i * (m + 1) + j] = 1;
      } else {
        cur[j] = cur[j - 1];
        choose[i * (m + 1) + j] = 2;
      }
    }
    prev.set(cur);
  }

  const rows: DiffRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && choose[i * (m + 1) + j] === 0) {
      rows.push({ kind: "context", text: a[i - 1], oldLine: i, newLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || choose[i * (m + 1) + j] === 2)) {
      rows.push({ kind: "added", text: b[j - 1], oldLine: null, newLine: j });
      j--;
    } else {
      rows.push({ kind: "removed", text: a[i - 1], oldLine: i, newLine: null });
      i--;
    }
  }
  rows.reverse();
  return rows;
}
