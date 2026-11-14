interface Op {
  t: " " | "-" | "+";
  text: string;
}

const CONTEXT = 3;
const MAX_CELLS = 4_000_000;

function splitLines(text: string | null): string[] {
  if (!text) return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

function diffLines(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const ops: Op[] = a.slice(0, head).map((text) => ({ t: " ", text }));
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);

  if (x.length * y.length > MAX_CELLS) {
    x.forEach((text) => ops.push({ t: "-", text }));
    y.forEach((text) => ops.push({ t: "+", text }));
  } else {
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
        ops.push({ t: " ", text: x[i] });
        i++;
        j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
        ops.push({ t: "-", text: x[i++] });
      } else {
        ops.push({ t: "+", text: y[j++] });
      }
    }
    while (i < x.length) ops.push({ t: "-", text: x[i++] });
    while (j < y.length) ops.push({ t: "+", text: y[j++] });
  }

  a.slice(a.length - tail).forEach((text) => ops.push({ t: " ", text }));
  return ops;
}

export function functionDiffText(
  path: string,
  name: string,
  before: string | null,
  after: string | null,
  beforeStart: number,
  afterStart: number,
): string {
  const ops = diffLines(splitLines(before), splitLines(after));
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