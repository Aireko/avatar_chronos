import { describe, expect, it } from "vitest";
import type { CallTreeEdge, CallTreeNode, CallTreeOk } from "../backend";
import { exactName, fit, layoutCallTree, numberLines, NODE_H, NODE_W, supportsCallGraph } from "./callTree";

const revision = { repositoryId: "repo", commitSha: "0".repeat(40) };

const node = (
  id: string,
  name: string,
  side: CallTreeNode["side"],
  depth: number,
  parent: string | null,
  hasMore = false,
): CallTreeNode => ({
  id,
  side,
  depth,
  parent,
  hasMore,
  symbol: { revision, id: name },
  name,
  qualifiedName: name,
  kind: "function",
  filePath: "a.c",
  startLine: 1,
  endLine: 2,
  startByte: 0,
  endByte: 10,
});

const edge = (
  id: string,
  from: string,
  to: string | null,
  side: CallTreeEdge["side"],
  state: CallTreeEdge["state"] = "resolved",
  callCount = 1,
  calleeText = "x",
): CallTreeEdge => ({
  id,
  from,
  to,
  side,
  state,
  calleeText,
  callCount,
  callSites: [],
  candidateCount: state === "ambiguous" ? 3 : 0,
  candidates: [],
});

function sample(): CallTreeOk {
  return {
    schemaVersion: 1,
    status: "ok",
    revision,
    maxDepth: 2,
    maxNodes: 48,
    truncated: false,
    coverage: "complete",
    root: "n0",
    nodes: [
      node("n0", "root", "root", 0, null),
      node("n1", "callerB", "caller", 1, "n0"),
      node("n2", "callerE", "caller", 1, "n0"),
      node("n3", "callerC", "caller", 2, "n1", true),
      node("n4", "calleeE", "callee", 1, "n0"),
      node("n5", "calleeF", "callee", 1, "n0"),
      node("n6", "calleeG", "callee", 2, "n4"),
    ],
    edges: [
      edge("e0", "n1", "n0", "caller"),
      edge("e1", "n0", "n2", "caller"),
      edge("e2", "n3", "n1", "caller"),
      edge("e3", "n0", "n0", "callee"),
      edge("e4", "n0", "n4", "callee"),
      edge("e5", "n0", "n5", "callee", "resolved", 2),
      edge("e6", "n4", "n0", "callee"),
      edge("e7", "n4", "n6", "callee"),
      edge("e8", "n0", null, "callee", "unresolved", 2, "missing"),
      edge("e9", "n0", null, "callee", "ambiguous", 1, "save"),
      edge("e10", "n0", null, "callee", "unresolved", 1, "a"),
      edge("e11", "n0", null, "callee", "unresolved", 1, "b"),
    ],
  };
}

describe("layoutCallTree", () => {
  const layout = layoutCallTree(sample());
  const at = (id: string) => layout.nodes.find((n) => n.node.id === id)!;

  it("puts callers on the left, callees on the right and deeper hops further out", () => {
    expect(at("n1").cx).toBeLessThan(at("n0").cx);
    expect(at("n3").cx).toBeLessThan(at("n1").cx);
    expect(at("n4").cx).toBeGreaterThan(at("n0").cx);
    expect(at("n6").cx).toBeGreaterThan(at("n4").cx);
    expect(at("n1").cx).toBe(at("n2").cx);
  });

  it("never overlaps two boxes and keeps everything inside the canvas", () => {
    const boxes = [...layout.nodes.map((n) => [n.cx, n.cy]), ...layout.ghosts.map((g) => [g.cx, g.cy])];
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i][0] - NODE_W / 2).toBeGreaterThanOrEqual(0);
      expect(boxes[i][1] - NODE_H / 2).toBeGreaterThanOrEqual(0);
      expect(boxes[i][0] + NODE_W / 2).toBeLessThanOrEqual(layout.width);
      expect(boxes[i][1] + NODE_H / 2).toBeLessThanOrEqual(layout.height);
      for (let j = i + 1; j < boxes.length; j++) {
        const apart = Math.abs(boxes[i][0] - boxes[j][0]) >= NODE_W || Math.abs(boxes[i][1] - boxes[j][1]) >= NODE_H;
        expect(apart).toBe(true);
      }
    }
  });

  it("shows three unresolved calls per function and folds the rest into one box", () => {
    expect(layout.ghosts).toHaveLength(4);
    expect(layout.ghosts[3].edgeIds).toHaveLength(1);
    const ambiguous = layout.ghosts.find((g) => g.state === "ambiguous");
    expect(ambiguous?.candidates).toBe(3);
    expect(layout.ghosts.find((g) => g.label === "missing")?.callCount).toBe(2);
  });

  it("tells tree edges from edges back to a box that is already drawn", () => {
    const kind = (id: string) => layout.edges.find((e) => e.id === id)?.kind;
    expect(kind("e0")).toBe("tree");
    expect(kind("e4")).toBe("tree");
    expect(kind("e7")).toBe("tree");
    expect(kind("e1")).toBe("back");
    expect(kind("e6")).toBe("back");
    expect(layout.edges.find((e) => e.id === "e3")?.loops).toBe(true);
    expect(layout.edges.filter((e) => e.kind === "ghost")).toHaveLength(4);
  });

  it("lays out a function that has no neighbours", () => {
    const solo = layoutCallTree({ ...sample(), nodes: [node("n0", "root", "root", 0, null)], edges: [] });
    expect(solo.nodes).toHaveLength(1);
    expect(solo.hasCallers).toBe(false);
    expect(solo.hasCallees).toBe(false);
    expect(solo.width).toBeGreaterThan(NODE_W);
  });
});

describe("helpers", () => {
  it("names a definition by qualified name and start line", () => {
    expect(exactName({ qualifiedName: "A::run", startLine: 2 })).toBe("A::run#2");
  });

  it("knows which files the indexer parses", () => {
    expect(supportsCallGraph("src/App.tsx")).toBe(true);
    expect(supportsCallGraph("lib/B.RS")).toBe(true);
    expect(supportsCallGraph("tool.py")).toBe(false);
  });

  it("shortens with an ellipsis only when needed", () => {
    expect(fit("abcdefghij", 5)).toBe("abcd…");
    expect(fit("abc", 5)).toBe("abc");
  });

  it("numbers source from the function's first line and marks the call-site lines", () => {
    const { lines, clipped } = numberLines("a\r\nb\r\nc\r\n", 10, [{ startLine: 11, endLine: 11 }]);
    expect(lines.map((l) => l.number)).toEqual([10, 11, 12]);
    expect(lines.map((l) => l.hit)).toEqual([false, true, false]);
    expect(clipped).toBe(0);
    expect(numberLines("1\n2\n3", 1, [], 2).clipped).toBe(1);
  });
});
