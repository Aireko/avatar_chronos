import { describe, expect, it } from "vitest";
import { COL_W, LANE_H, PAD_L, PAD_T } from "./layout";
import { miniColumns, stepMapFocus } from "./MiniMap";

/** Commits in column order: `rows[i]` is the row commit i is drawn on. */
function nodes(rows: number[]) {
  return rows.map((row, col) => ({ col, row, x: PAD_L + col * COL_W, y: PAD_T + row * LANE_H }));
}

describe("moving the keyboard around the editor's commit map", () => {
  const map = nodes([0, 0, 1, 0, 2, 1]);

  it("steps one column older or newer with Left and Right, and stops at either end", () => {
    expect(stepMapFocus(map, map[2], "ArrowLeft")).toBe(map[1]);
    expect(stepMapFocus(map, map[2], "ArrowRight")).toBe(map[3]);
    expect(stepMapFocus(map, map[0], "ArrowLeft")).toBeNull();
    expect(stepMapFocus(map, map[5], "ArrowRight")).toBeNull();
  });

  it("jumps to the oldest and newest commit with Home and End", () => {
    expect(stepMapFocus(map, map[3], "Home")).toBe(map[0]);
    expect(stepMapFocus(map, map[3], "End")).toBe(map[5]);
    expect(stepMapFocus(map, map[0], "Home")).toBeNull();
  });

  it("goes to the nearest commit drawn above or below with Up and Down", () => {
    // From row 0, column 3: row 1 has commits in columns 2 and 5; column 2 is nearer.
    expect(stepMapFocus(map, map[3], "ArrowDown")).toBe(map[2]);
    expect(stepMapFocus(map, map[2], "ArrowUp")).toBe(map[1]);
    expect(stepMapFocus(map, map[4], "ArrowUp")).toBe(map[5]);
    // Nothing above the top row, nothing below the bottom one.
    expect(stepMapFocus(map, map[0], "ArrowUp")).toBeNull();
    expect(stepMapFocus(map, map[4], "ArrowDown")).toBeNull();
  });

  it("ignores other keys", () => {
    expect(stepMapFocus(map, map[2], "Enter")).toBeNull();
    expect(stepMapFocus(map, map[2], "PageDown")).toBeNull();
  });

  it("finds the commit even when the list is not indexed by column", () => {
    const short = map.slice(2);
    expect(stepMapFocus(short, short[1], "ArrowLeft")).toBe(short[0]);
  });
});

describe("drawing only the part of the editor's commit map in view", () => {
  const SCALE = 0.42; // the map's scale, as in MiniMap.tsx

  it("covers every column on screen, at any scroll position", () => {
    const viewW = 520;
    for (let left = 0; left < 40_000; left += 997) {
      const r = miniColumns(left, viewW, 9_999);
      const first = Math.floor((left / SCALE - PAD_L) / COL_W);
      const last = Math.ceil(((left + viewW) / SCALE - PAD_L) / COL_W);
      expect(r.from).toBeLessThanOrEqual(Math.max(0, first));
      expect(r.to).toBeGreaterThanOrEqual(Math.min(9_999, last));
    }
  });

  it("draws far fewer columns than a long history holds", () => {
    const r = miniColumns(20_000, 520, 49_999);
    expect(r.to - r.from + 1).toBeLessThan(200);
  });

  it("draws nothing for an empty history", () => {
    const r = miniColumns(0, 520, -1);
    expect(r.to).toBeLessThan(r.from);
  });
});
