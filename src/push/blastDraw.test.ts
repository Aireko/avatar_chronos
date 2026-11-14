import { describe, expect, it } from "vitest";
import { type BNode, EDGE_LEAD, EDGE_MS, EDGE_STEP, MAX_DELAY, MAX_STAGGER, NODE_STEP, drawDelays, listDelay } from "./blast";

const node = (id: string, role: BNode["role"]): Pick<BNode, "id" | "role"> => ({ id, role });

describe("drawDelays", () => {
  it("lands the changed functions first, one after another", () => {
    const d = drawDelays([node("a", "changed"), node("b", "changed")], []);
    expect(d.nodes).toEqual({ a: 0, b: NODE_STEP });
    expect(d.edges).toEqual([]);
  });

  it("starts the lines after the changed functions and lands neighbours as their line arrives", () => {
    const nodes = [node("c1", "caller"), node("t", "changed"), node("x1", "callee")];
    const edges = [
      { from: "c1", to: "t" },
      { from: "t", to: "x1" },
    ];
    const d = drawDelays(nodes, edges);
    expect(d.nodes.t).toBe(0);
    expect(d.edges).toEqual([EDGE_LEAD, EDGE_LEAD + EDGE_STEP]);
    expect(d.nodes.c1).toBe(Math.round(EDGE_LEAD + EDGE_MS * 0.7));
    expect(d.nodes.x1).toBe(Math.round(EDGE_LEAD + EDGE_STEP + EDGE_MS * 0.7));
    // Every neighbour lands after the changed function it hangs off.
    expect(d.nodes.c1).toBeGreaterThan(d.nodes.t);
  });

  it("uses a neighbour's earliest line", () => {
    const nodes = [node("t1", "changed"), node("t2", "changed"), node("c", "caller")];
    const edges = [
      { from: "c", to: "t1" },
      { from: "c", to: "t2" },
    ];
    const d = drawDelays(nodes, edges);
    expect(d.nodes.c).toBe(Math.round(d.edges[0] + EDGE_MS * 0.7));
  });

  it("caps the stagger and the delay on big maps", () => {
    const nodes = [
      ...Array.from({ length: 8 }, (_, i) => node(`t${i}`, "changed")),
      ...Array.from({ length: 12 }, (_, i) => node(`c${i}`, "caller")),
    ];
    const edges = Array.from({ length: 40 }, (_, i) => ({ from: `c${i % 12}`, to: `t${i % 8}` }));
    const d = drawDelays(nodes, edges);
    const all = [...Object.values(d.nodes), ...d.edges];
    expect(Math.max(...all)).toBeLessThanOrEqual(MAX_DELAY);
    expect(d.nodes.t7).toBe(MAX_STAGGER * NODE_STEP);
    expect(d.edges[39]).toBe(d.edges[MAX_STAGGER]);
  });

  it("never lands a neighbour before its line reaches it, even when capped", () => {
    const nodes = [
      ...Array.from({ length: 8 }, (_, i) => node(`t${i}`, "changed")),
      ...Array.from({ length: 12 }, (_, i) => node(`c${i}`, "caller")),
    ];
    const edges = Array.from({ length: 12 }, (_, i) => ({ from: `c${i}`, to: `t${i % 8}` }));
    const d = drawDelays(nodes, edges);
    edges.forEach((e, i) => {
      expect(d.nodes[e.from]).toBe(Math.round(d.edges[i] + EDGE_MS * 0.7));
      expect(d.nodes[e.from]).toBeLessThanOrEqual(MAX_DELAY);
    });
  });

  it("still places neighbours that have no line", () => {
    const d = drawDelays([node("t", "changed"), node("a", "callee"), node("b", "callee")], []);
    expect(d.nodes.a).toBe(EDGE_LEAD);
    expect(d.nodes.b).toBe(EDGE_LEAD + NODE_STEP);
  });
});

describe("listDelay", () => {
  it("staggers the first items and caps the rest", () => {
    expect(listDelay(0)).toBe(0);
    expect(listDelay(2)).toBe(100);
    expect(listDelay(50)).toBe(MAX_STAGGER * 50);
    expect(listDelay(-1)).toBe(0);
  });
});
