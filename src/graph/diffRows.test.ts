import { describe, expect, it } from "vitest";
import {
  buildDiffRows,
  changeStarts,
  diffStats,
  editMarks,
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
