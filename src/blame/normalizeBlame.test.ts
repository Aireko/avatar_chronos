import { describe, expect, it } from "vitest";
import { contributorsInRange } from "./contributors";
import { normalizeBlameReport } from "./normalizeBlame";

describe("normalizeBlameReport", () => {
  it("rejects null and answers without a path", () => {
    expect(() => normalizeBlameReport(null)).toThrow(/unexpected answer/);
    expect(() => normalizeBlameReport({ revision: "abc" })).toThrow();
  });

  it("fills missing lists and drops unreadable entries", () => {
    const report = normalizeBlameReport({
      path: "src/a.c",
      totalLines: "12",
      commits: [{ hash: "c1", author: "Ada", email: "ada@example.com", time: 10 }, { author: "no hash" }, null],
      ranges: [{ start: 1, end: 3, commit: "c1" }, { start: 5, end: 2, commit: "c1" }, { start: 1 }],
      symbols: [{ name: "main", kind: "lambda", startLine: 1, endLine: 3 }, { name: "bad" }],
    });
    expect(report).toMatchObject({ revision: "", repoPath: "", totalLines: 0, authors: [] });
    expect(report.commits).toEqual([
      { hash: "c1", author: "Ada", email: "ada@example.com", time: 10, summary: "", lines: 0 },
    ]);
    expect(report.ranges).toEqual([{ start: 1, end: 3, commit: "c1" }]);
    expect(report.symbols).toEqual([{ name: "main", kind: "function", startLine: 1, endLine: 3 }]);
  });

  it("gives contributorsInRange something it can always read", () => {
    const report = normalizeBlameReport({ path: "x", commits: null, ranges: [{ start: 1, end: 2, commit: "gone" }] });
    expect(contributorsInRange(report, 1, 2)).toEqual([]);
  });
});
