import { describe, expect, it } from "vitest";
import {
  buildDiffRows,
  changeStarts,
  describeChange,
  diffLines,
  diffStats,
  editMarks,
  lineCount,
  lineToRow,
  rowMap,
  rowToLine,
  stepChange,
} from "./diffRows";
import { functionDiffText } from "./functionDiff";

const kinds = (before: string | null, after: string | null) => buildDiffRows(before, after).map((r) => r.kind[0]).join("");

describe("buildDiffRows", () => {
  it("returns nothing for two empty sides", () => {
    expect(buildDiffRows(null, null)).toEqual([]);
    expect(buildDiffRows("", "")).toEqual([]);
  });

  it("marks a new file as all added and a deleted file as all removed", () => {
    expect(kinds(null, "a\nb\n")).toBe("aa");
    expect(kinds("a\nb\n", null)).toBe("rr");
  });

  it("keeps the unchanged head and tail and numbers both sides", () => {
    const rows = buildDiffRows("one\ntwo\nthree\nfour\n", "one\nTWO\nthree\nfour\nfive\n");
    expect(rows.map((r) => r.kind[0]).join("")).toBe("cracca");
    expect(rows).toEqual([
      { kind: "context", text: "one", oldLine: 1, newLine: 1 },
      { kind: "removed", text: "two", oldLine: 2, newLine: null },
      { kind: "added", text: "TWO", oldLine: null, newLine: 2 },
      { kind: "context", text: "three", oldLine: 3, newLine: 3 },
      { kind: "context", text: "four", oldLine: 4, newLine: 4 },
      { kind: "added", text: "five", oldLine: null, newLine: 5 },
    ]);
  });

  it("finds the common lines inside an edited middle", () => {
    expect(kinds("a\nx\nb\ny\nc", "a\nb\nz\nc")).toBe("crcrac");
  });

  it("falls back to a replaced block when the middle is huge", () => {
    const before = Array.from({ length: 2100 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 2100 }, (_, i) => `new ${i}`).join("\n");
    const rows = buildDiffRows(`top\n${before}\nend`, `top\n${after}\nend`);
    expect(rows[0].kind).toBe("context");
    expect(rows[rows.length - 1]).toEqual({ kind: "context", text: "end", oldLine: 2102, newLine: 2102 });
    expect(diffStats(rows)).toEqual({ added: 2100, removed: 2100 });
    expect(rows[1].kind).toBe("removed");
    expect(rows[2101].kind).toBe("added");
  });

  it("keeps a long file's scattered edits small instead of rewriting the whole file", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[3] = "changed near the top";
    after[4996] = "changed near the bottom";
    const rows = diffLines(before, after);
    expect(diffStats(rows)).toEqual({ added: 2, removed: 2 });
    expect(changeStarts(rows)).toEqual([3, 4997]);
    expect(rows).toHaveLength(5002);
  });

  it("lines up unique lines when there are too many edits to search", () => {
    // Every other line changes (3,000 edits), but the kept lines are unique anchors.
    const before = Array.from({ length: 3000 }, (_, i) => (i % 2 ? `old ${i}` : `keep ${i}`));
    const after = Array.from({ length: 3000 }, (_, i) => (i % 2 ? `new ${i}` : `keep ${i}`));
    const rows = diffLines(before, after);
    expect(diffStats(rows)).toEqual({ added: 1500, removed: 1500 });
    expect(rows.filter((r) => r.kind === "context")).toHaveLength(1500);
    expect(rows.slice(0, 4).map((r) => r.kind[0]).join("")).toBe("crac");
  });

  it("still rebuilds both sides of a big rewrite once the diff's search budget runs out", () => {
    // 20,000 lines all rewritten from a few repeated lines, with a unique line kept every
    // 2,000: ten big pieces with nothing to anchor on, more than the shared budgets cover.
    const before = Array.from({ length: 20000 }, (_, i) => (i % 2000 ? `old ${i % 7}` : `keep ${i}`));
    const after = Array.from({ length: 20000 }, (_, i) => (i % 2000 ? `new ${i % 7}` : `keep ${i}`));
    const rows = diffLines(before, after);
    expect(rows.filter((r) => r.kind !== "added").map((r) => r.text)).toEqual(before);
    expect(rows.filter((r) => r.kind !== "removed").map((r) => r.text)).toEqual(after);
    expect(rows.filter((r) => r.kind === "context").map((r) => r.text)).toEqual(before.filter((t) => t.startsWith("keep")));
  });

  it("finds a longest common subsequence and rebuilds both sides", () => {
    // Small seeded random texts from a tiny alphabet (lots of repeats), checked against a plain LCS table.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const lcs = (a: string[], b: string[]) => {
      const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
          t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
      return t[0][0];
    };
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: rand(14) }, () => "abcd"[rand(4)]);
      const b = Array.from({ length: rand(14) }, () => "abcd"[rand(4)]);
      const rows = diffLines(a, b);
      expect(rows.filter((r) => r.kind !== "added").map((r) => r.text)).toEqual(a);
      expect(rows.filter((r) => r.kind !== "removed").map((r) => r.text)).toEqual(b);
      expect(rows.filter((r) => r.kind === "context")).toHaveLength(lcs(a, b));
      // Within a run of changes, removed lines always come first.
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1].kind === "added" && rows[i].kind === "removed").toBe(false);
    }
  });
});

describe("change navigation", () => {
  const rows = buildDiffRows("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\nf\n");

  it("counts added and removed lines", () => {
    expect(diffStats(rows)).toEqual({ added: 3, removed: 2 });
  });

  it("finds where each run of changes starts", () => {
    expect(changeStarts(rows)).toEqual([1, 5]);
    expect(changeStarts(buildDiffRows("same\n", "same\n"))).toEqual([]);
  });

  it("steps forward and back, wrapping at the ends", () => {
    const starts = [1, 5];
    expect(stepChange(starts, -1, 1)).toBe(1);
    expect(stepChange(starts, 1, 1)).toBe(5);
    expect(stepChange(starts, 5, 1)).toBe(1);
    expect(stepChange(starts, 5, -1)).toBe(1);
    expect(stepChange(starts, 1, -1)).toBe(5);
    expect(stepChange(starts, -1, -1)).toBe(5);
    expect(stepChange([], 0, 1)).toBeNull();
  });

  it("describes each jump for screen readers, including wrapping round", () => {
    const starts = [1, 5, 9];
    expect(describeChange(starts, -1, 1, 1, 1)).toBe("Change 1 of 3, line 2");
    expect(describeChange(starts, 1, 5, 1, 4)).toBe("Change 2 of 3, line 5");
    expect(describeChange(starts, 9, 1, 1, 1)).toBe("Change 1 of 3, line 2, wrapped to the first");
    expect(describeChange(starts, 1, 9, -1, 7)).toBe("Change 3 of 3, line 8, wrapped to the last");
    expect(describeChange(starts, 9, 5, -1, 4)).toBe("Change 2 of 3, line 5");
    expect(describeChange([4], 4, 4, 1, 3)).toBe("Change 1 of 1, line 4, the only change");
  });
});

describe("lineCount", () => {
  it("counts lines the way the editor's gutter numbers them", () => {
    for (const text of ["", "a", "a\n", "a\nb", "a\nb\n", "\n\n\n", "x\r\ny"]) {
      expect(lineCount(text)).toBe(text.split("\n").length);
    }
  });
});

describe("functionDiffText (shares the line diff)", () => {
  it("is empty when nothing changed", () => {
    expect(functionDiffText("a.ts", "fn", "x\n", "x\n", 1, 1)).toBe("");
  });

  it("writes hunks with context and real line numbers, across CRLF files", () => {
    const before = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\r\n")}\r\n`;
    const after = `${before.replace("line 3", "LINE 3").replace("line 15\r\n", "")}tail\n`;
    expect(functionDiffText("a.ts", "fn", before, after, 10, 12)).toMatchInlineSnapshot(`
      "diff --git a/a.ts b/a.ts
      @@ -10,7 +12,7 @@ fn
       line 0
       line 1
       line 2
      -line 3
      +LINE 3
       line 4
       line 5
       line 6
      @@ -22,8 +24,8 @@ fn
       line 12
       line 13
       line 14
      -line 15
       line 16
       line 17
       line 18
       line 19
      +tail
      "
    `);
  });

  it("treats a missing side as empty", () => {
    expect(functionDiffText("a.ts", "fn", null, "a\nb", 1, 5)).toMatchInlineSnapshot(`
      "diff --git a/a.ts b/a.ts
      @@ -1,0 +5,2 @@ fn
      +a
      +b
      "
    `);
  });
});

describe("matching rows to the editable pane", () => {
  // rows: c(a) r(b) r(c) a(X) c(d) a(Y) c(e)  ->  working tree: a X d Y e
  const rows = buildDiffRows("a\nb\nc\nd\ne\n", "a\nX\nd\nY\ne\n");
  const map = rowMap(rows);

  it("indexes lines by row and rows by line", () => {
    expect(rows.map((r) => r.kind[0]).join("")).toBe("crracac");
    expect(map.lineOfRow).toEqual([0, 1, 1, 1, 2, 3, 4, 5]);
    expect(map.rowOfLine).toEqual([0, 3, 4, 5, 6, 7]);
  });

  it("holds the line still across removed rows and keeps the fraction elsewhere", () => {
    expect(rowToLine(map, 0)).toBe(0);
    expect(rowToLine(map, 0.5)).toBe(0.5);
    expect(rowToLine(map, 1)).toBe(1);
    expect(rowToLine(map, 2.5)).toBe(1);
    expect(rowToLine(map, 3.25)).toBe(1.25);
    expect(rowToLine(map, 6.5)).toBe(4.5);
  });

  it("maps lines back to the rows that show them", () => {
    expect(lineToRow(map, 0.5)).toBe(0.5);
    expect(lineToRow(map, 1)).toBe(3);
    expect(lineToRow(map, 1.25)).toBe(3.25);
    expect(lineToRow(map, 4.5)).toBe(6.5);
    for (const pos of [0, 0.4, 1, 1.7, 3, 4.9]) expect(rowToLine(map, lineToRow(map, pos))).toBeCloseTo(pos);
  });

  it("passes positions above and below the rows through", () => {
    expect(rowToLine(map, -0.4)).toBe(-0.4);
    expect(lineToRow(map, -0.4)).toBe(-0.4);
    expect(rowToLine(map, 9)).toBe(7);
    expect(lineToRow(map, 7)).toBe(9);
    const empty = rowMap([]);
    expect(rowToLine(empty, 2)).toBe(2);
    expect(lineToRow(empty, 2)).toBe(2);
  });

  it("marks added runs and the gaps left by removed lines", () => {
    expect(editMarks(rows)).toEqual([
      { kind: "gap", line: 1, count: 2 },
      { kind: "added", line: 1, count: 1 },
      { kind: "added", line: 3, count: 1 },
    ]);
    expect(editMarks(buildDiffRows("a\nb\n", "a\nb\nc\nd\n"))).toEqual([{ kind: "added", line: 2, count: 2 }]);
    expect(editMarks(buildDiffRows("a\nb\nc\n", "c\n"))).toEqual([{ kind: "gap", line: 0, count: 2 }]);
    expect(editMarks(buildDiffRows("same\n", "same\n"))).toEqual([]);
  });
});
