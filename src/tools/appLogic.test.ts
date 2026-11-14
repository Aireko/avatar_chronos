import { describe, expect, it } from "vitest";
import type { ChronosGraph, Commit } from "../backend";
import { cdHint, historyChanged, isBareCd, isToolSwap, onWindows, shellHints } from "./appLogic";

function commit(hash: string): Commit {
  return { hash, shortHash: hash, parents: [], author: "a", timestamp: 0, message: hash, refs: [], filesChanged: [] };
}

function graph(over: Partial<ChronosGraph> = {}): ChronosGraph {
  return {
    repoPath: "/r",
    head: "b",
    generatedAt: 0,
    branches: [{ name: "main", commitHash: "b", isHead: true }],
    commits: [commit("a"), commit("b")],
    mergeAnalysis: {
      active: false,
      sourceBranch: null,
      targetBranch: null,
      mergeBase: null,
      canAutoMerge: false,
      conflicts: [],
    },
    ...over,
  };
}

describe("historyChanged", () => {
  it("is false for the same history loaded again", () => {
    expect(historyChanged(graph(), graph({ generatedAt: 5 }))).toBe(false);
  });

  it("notices a new commit, a moved HEAD, a moved branch and another repository", () => {
    expect(historyChanged(graph(), graph({ commits: [commit("a"), commit("b"), commit("c")] }))).toBe(true);
    expect(historyChanged(graph(), graph({ head: "a" }))).toBe(true);
    expect(
      historyChanged(graph(), graph({ branches: [{ name: "main", commitHash: "a", isHead: true }] })),
    ).toBe(true);
    expect(historyChanged(graph(), graph({ repoPath: "/other" }))).toBe(true);
    expect(historyChanged(undefined, graph())).toBe(true);
  });

  it("notices a rewritten commit even when the count is the same", () => {
    expect(historyChanged(graph(), graph({ commits: [commit("a"), commit("b2")] }))).toBe(true);
  });
});

describe("isToolSwap", () => {
  it("is only a swap between two different open tools", () => {
    expect(isToolSwap(null, "ai")).toBe(false);
    expect(isToolSwap("ai", null)).toBe(false);
    expect(isToolSwap("ai", "ai")).toBe(false);
    expect(isToolSwap("ai", "people")).toBe(true);
  });
});

describe("terminal hints", () => {
  it("suggests commands that exist in the shell that runs them", () => {
    expect(onWindows("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true);
    expect(onWindows("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe(false);
    expect(shellHints(true).intro).toContain("`dir`");
    expect(shellHints(true).intro).not.toContain("`ls`");
    expect(shellHints(false).intro).toContain("`ls`");
    expect(shellHints(true).placeholder).not.toMatch(/^ls/);
  });

  it("spots a cd that would do nothing", () => {
    expect(isBareCd("cd src")).toBe(true);
    expect(isBareCd("  CD ..")).toBe(true);
    expect(isBareCd("cd")).toBe(true);
    expect(isBareCd("cd\\")).toBe(true);
    expect(isBareCd("cd src && dir")).toBe(false);
    expect(isBareCd("cd src; ls")).toBe(false);
    expect(isBareCd("cdk deploy")).toBe(false);
    expect(isBareCd("git status")).toBe(false);
  });

  it("offers a chained command that works instead", () => {
    expect(cdHint("cd src/app", true)).toContain("cd src/app && dir");
    expect(cdHint("cd /d C:\\work", true)).toContain("cd C:\\work && dir");
    expect(cdHint("cd", false)).toContain("cd src && ls");
  });
});
