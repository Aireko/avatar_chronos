import { describe, expect, it } from "vitest";
import { buildDiffRows, changeStarts, diffStats, stepChange } from "./diffRows";

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
