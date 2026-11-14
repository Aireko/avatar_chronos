import { describe, expect, it } from "vitest";
import type { MergeConflict } from "../backend";
import {
  ResolutionError,
  applyResolutions,
  classifyResolution,
  collisionItems,
  conflictId,
  countStatuses,
  groupByFile,
  isFileLevel,
  isValidBranchName,
  parseConflictMarkers,
  shortDiff,
  unquoteGitPath,
  type RegionEntry,
} from "./resolution";

const conflict = (over: Partial<MergeConflict> = {}): MergeConflict => ({
  filePath: "src/a.c",
  symbolName: "f",
  resolutionStatus: "TRUE_COLLISION",
  oursRange: [1, 1],
  theirsRange: [1, 1],
  baseSnippet: "",
  oursSnippet: "",
  theirsSnippet: "",
  ...over,
});

const entry = (over: Partial<RegionEntry> = {}): RegionEntry => ({
  id: "e1",
  label: "f",
  oursSnippet: "  return 1;",
  theirsSnippet: "  return 2;",
  text: "",
  ...over,
});

const region = (ours: string, theirs: string, name = "HEAD") =>
  [
    "<<<<<<< " + name,
    ...(ours === "" ? [] : [ours]),
    "=======",
    ...(theirs === "" ? [] : [theirs]),
    ">>>>>>> feature",
  ].join("\n");

const FILE = ["int f(void) {", region("  return 1;", "  return 2;"), "}", ""].join("\n");

describe("isValidBranchName", () => {
  it("accepts the usual names", () => {
    for (const n of ["main", "feature/x-1.2", "release_3", "a/b/c"]) expect(isValidBranchName(n)).toBe(true);
  });
  it("rejects anything git could read as an option, a range or a shell word", () => {
    for (const n of ["", "-x", "--exec=1", "a b", "a..b", "a;b", "a$(b)", 'a"b']) expect(isValidBranchName(n)).toBe(false);
  });
});

describe("counts and grouping", () => {
  const list = [
    conflict({ resolutionStatus: "CLEAN", symbolName: "a" }),
    conflict({ resolutionStatus: "AUTO_RESOLVABLE", symbolName: "b", filePath: "src/b.c" }),
    conflict({ symbolName: "c" }),
    conflict({ symbolName: "d" }),
  ];
  it("counts each status", () => expect(countStatuses(list)).toEqual({ clean: 1, auto: 1, collision: 2 }));
  it("groups by file, files sorted", () => {
    const groups = groupByFile(list);
    expect(groups.map((g) => g.filePath)).toEqual(["src/a.c", "src/b.c"]);
    expect(groups[0].conflicts.map((c) => c.symbolName)).toEqual(["a", "c", "d"]);
  });
  it("lists only the collisions, with ids that keep their analysis position", () => {
    const items = collisionItems(list);
    expect(items.map((i) => i.id)).toEqual([conflictId(list[2], 2), conflictId(list[3], 3)]);
    expect(items.every((i) => !i.fileLevel)).toBe(true);
  });
  it("calls a conflict without symbol and snippets a whole-file conflict", () => {
    expect(isFileLevel(conflict({ symbolName: null }))).toBe(true);
    expect(isFileLevel(conflict({ symbolName: null, oursSnippet: "x" }))).toBe(false);
    expect(isFileLevel(conflict({ symbolName: "f" }))).toBe(false);
  });
});

describe("unquoteGitPath", () => {
  it("leaves plain paths alone", () => expect(unquoteGitPath("src/a.c")).toBe("src/a.c"));
  it("decodes octal bytes as UTF-8 and escapes", () => {
    expect(unquoteGitPath('"caf\\303\\251.c"')).toBe("café.c");
    expect(unquoteGitPath('"a\\"b\\\\c\\td"')).toBe('a"b\\c\td');
  });
});

describe("parseConflictMarkers", () => {
  it("reads one region with its labels", () => {
    const p = parseConflictMarkers(FILE);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0]).toMatchObject({ start: 1, end: 5, ours: ["  return 1;"], theirs: ["  return 2;"], base: null });
    expect(p.regions[0].oursLabel).toBe("HEAD");
    expect(p.regions[0].theirsLabel).toBe("feature");
  });
  it("reads several regions in one file", () => {
    const text = ["a", region("1", "2"), "b", region("3", "4"), "c"].join("\n");
    expect(parseConflictMarkers(text).regions.map((r) => r.start)).toEqual([1, 7]);
  });
  it("reads the base section of diff3 style", () => {
    const text = ["<<<<<<< HEAD", "o", "||||||| base", "b", "=======", "t", ">>>>>>> x"].join("\n");
    expect(parseConflictMarkers(text).regions[0]).toMatchObject({ ours: ["o"], base: ["b"], theirs: ["t"] });
  });
  it("detects CRLF files", () => expect(parseConflictMarkers(FILE.replace(/\n/g, "\r\n")).eol).toBe("\r\n"));
  it("finds nothing in a file without markers, and ignores a stray ======= line", () => {
    expect(parseConflictMarkers("Title\n=======\ntext\n").regions).toEqual([]);
  });
  it("throws for a region that never closes or that nests", () => {
    expect(() => parseConflictMarkers("<<<<<<< HEAD\na\n=======\nb\n")).toThrow(ResolutionError);
    expect(() => parseConflictMarkers("<<<<<<< HEAD\n<<<<<<< HEAD\n")).toThrow(ResolutionError);
  });
});

describe("classifyResolution", () => {
  it("recognises the quick actions, ignoring trailing whitespace", () => {
    expect(classifyResolution("a  \n", "a", "b")).toBe("ours");
    expect(classifyResolution("b", "a", "b")).toBe("theirs");
    expect(classifyResolution("a\nb", "a", "b")).toBe("both");
    expect(classifyResolution("something else", "a", "b")).toBe("custom");
  });
});

describe("applyResolutions", () => {
  it("replaces a region with the user's text and keeps the rest", () => {
    const r = applyResolutions(FILE, [entry({ text: "  return 3;" })]);
    expect(r.text).toBe("int f(void) {\n  return 3;\n}\n");
    expect(r.applied).toEqual(["e1"]);
    expect(r.skipped).toEqual([]);
  });

  it("applies one quick action to a region shared by functions resolved the same way", () => {
    const a = entry({ id: "1", label: "one", text: "  return 1;" });
    const b = entry({ id: "2", label: "two", text: "  return 1;" });
    const r = applyResolutions(FILE, [a, b]);
    expect(r.text).toBe("int f(void) {\n  return 1;\n}\n");
    expect(r.applied).toEqual(["1", "2"]);
  });

  it("applies Take ours / theirs / both per region", () => {
    expect(applyResolutions(FILE, [entry({ text: "  return 1;" })]).text).toBe("int f(void) {\n  return 1;\n}\n");
    expect(applyResolutions(FILE, [entry({ text: "  return 2;" })]).text).toBe("int f(void) {\n  return 2;\n}\n");
    expect(applyResolutions(FILE, [entry({ text: "  return 1;\n  return 2;" })]).text).toBe(
      "int f(void) {\n  return 1;\n  return 2;\n}\n",
    );
  });

  it("handles several conflicts in one file, each to its own function", () => {
    const text = ["x", region("  a = 1;", "  a = 2;"), "y", region("  b = 1;", "  b = 2;"), "z", ""].join("\n");
    const r = applyResolutions(text, [
      entry({ id: "A", label: "A", oursSnippet: "  a = 1;", theirsSnippet: "  a = 2;", text: "  a = 9;" }),
      entry({ id: "B", label: "B", oursSnippet: "  b = 1;", theirsSnippet: "  b = 2;", text: "  b = 1;" }),
    ]);
    expect(r.text).toBe("x\n  a = 9;\ny\n  b = 1;\nz\n");
    expect(r.applied).toEqual(["A", "B"]);
  });

  it("replaces from the first to the last region of one function, text between included", () => {
    const text = [region("  p = 1;", "  p = 2;"), "  mid;", region("  q = 1;", "  q = 2;"), ""].join("\n");
    const r = applyResolutions(text, [
      entry({ oursSnippet: "  p = 1;\n  mid;\n  q = 1;", theirsSnippet: "  p = 2;\n  q = 2;", text: "  merged;" }),
    ]);
    expect(r.text).toBe("  merged;\n");
  });

  it("matches a git region larger than the snippet, so a deleted function can be removed or kept", () => {
    const text = ["void g(void)", region("{\n  work();\n  more();\n}", ""), "tail", ""].join("\n");
    const e = entry({ oursSnippet: "  work();", theirsSnippet: "", text: "" });
    expect(applyResolutions(text, [e]).text).toBe("void g(void)\ntail\n"); // theirs = deleted
    const keep = applyResolutions(text, [{ ...e, text: "  work();" }]);
    expect(keep.text).toBe("void g(void)\n{\n  work();\n  more();\n}\ntail\n"); // ours = whole function
  });

  it("keeps the file's CRLF line endings", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    expect(applyResolutions(crlf, [entry({ text: "  return 3;" })]).text).toBe("int f(void) {\r\n  return 3;\r\n}\r\n");
  });

  it("reports a function with no markers in the file as skipped, and changes nothing", () => {
    const r = applyResolutions("int f(void) { return 1; }\n", [entry({ text: "x" })], "a.c");
    expect(r.text).toBe("int f(void) { return 1; }\n");
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it("skips a function that has no region while still applying the others", () => {
    const r = applyResolutions(FILE, [entry({ text: "  return 3;" }), entry({ id: "e2", label: "other", oursSnippet: "zzz", theirsSnippet: "yyy" })]);
    expect(r.applied).toEqual(["e1"]);
    expect(r.skipped.map((s) => s.id)).toEqual(["e2"]);
  });

  it("refuses a region that matches no resolved function", () => {
    expect(() => applyResolutions(FILE, [entry({ oursSnippet: "  nothing_alike();", theirsSnippet: "  neither();" })], "a.c")).toThrow(
      /doesn't match any function/,
    );
  });

  it("refuses a region that fits two functions equally well", () => {
    expect(() => applyResolutions(FILE, [entry({ id: "1", label: "one" }), entry({ id: "2", label: "two" })], "a.c")).toThrow(
      /several functions/,
    );
  });

  it("refuses interleaved regions of two functions", () => {
    const text = [region("  a1;", "  a2;"), region("  b1;", "  b2;"), region("  a1b;", "  a2b;"), ""].join("\n");
    const A = entry({ id: "A", label: "A", oursSnippet: "  a1;\n  a1b;", theirsSnippet: "  a2;\n  a2b;" });
    const B = entry({ id: "B", label: "B", oursSnippet: "  b1;", theirsSnippet: "  b2;" });
    expect(() => applyResolutions(text, [A, B], "a.c")).toThrow(/interleaved/);
  });

  it("throws on a damaged file instead of editing it", () => {
    expect(() => applyResolutions("<<<<<<< HEAD\nx\n", [entry()])).toThrow(ResolutionError);
  });
});

describe("shortDiff", () => {
  it("keeps changed lines with context and folds the rest into gaps", () => {
    const rows = shortDiff("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nd\nE\nf\ng\nh", 1);
    expect(rows.map((r) => r.kind)).toEqual(["gap", "context", "removed", "added", "context", "gap"]);
    expect(rows[0]).toEqual({ kind: "gap", hidden: 3 });
  });
  it("is one gap when nothing changed", () => {
    expect(shortDiff("a\nb", "a\nb")).toEqual([{ kind: "gap", hidden: 2 }]);
  });
});