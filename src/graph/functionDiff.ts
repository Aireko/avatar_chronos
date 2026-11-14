import { diffLines } from "./diffRows";

interface Op {
  t: " " | "-" | "+";
  text: string;
}

const CONTEXT = 3;
const MARK = { context: " ", removed: "-", added: "+" } as const;

function splitLines(text: string | null): string[] {
  if (!text) return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/** The shared line diff (diffRows.ts), as unified-diff operations. */
function lineOps(a: string[], b: string[]): Op[] {
  return diffLines(a, b).map((row) => ({ t: MARK[row.kind], text: row.text }));
}

export function functionDiffText(
  path: string,
  name: string,
  before: string | null,
  after: string | null,
  beforeStart: number,
  afterStart: number,
): string {
  const ops = lineOps(splitLines(before), splitLines(after));
  if (!ops.some((op) => op.t !== " ")) return "";

  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = beforeStart;
  let n = afterStart;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(n);
    if (op.t !== "+") o++;
    if (op.t !== "-") n++;
  }

  const out = [`diff --git a/${path} b/${path}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === " ") {
      i++;
      continue;
    }
    let last = i;
    let j = i + 1;
    while (j < ops.length) {
      if (ops[j].t !== " ") {
        last = j;
        j++;
        continue;
      }
      let k = j;
      while (k < ops.length && ops[k].t === " ") k++;
      if (k < ops.length && k - j <= 2 * CONTEXT) j = k;
      else break;
    }
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(ops.length, last + 1 + CONTEXT);
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op.t !== "+").length;
    const newCount = slice.filter((op) => op.t !== "-").length;
    out.push(`@@ -${oldNo[from]},${oldCount} +${newNo[from]},${newCount} @@ ${name}`);
    for (const op of slice) out.push(`${op.t}${op.text}`);
    i = to;
  }
  return `${out.join("\n")}\n`;
}