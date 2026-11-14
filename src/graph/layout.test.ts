import { describe, expect, it } from "vitest";
import {
  COL_W,
  cameraAt,
  drawDelay,
  drawInWindow,
  easeOut,
  fitAxis,
  fitZoom,
  glideMs,
  laneSpans,
  scribbleLoop,
  scrollForWindow,
  visibleWindow,
  wheelZoomFactor,
} from "./layout";

describe("drawInWindow", () => {
  it("staggers only the columns around the focus that fit on screen", () => {
    const win = drawInWindow(5000, 9999, COL_W * 10);
    expect(win.from).toBe(5000 - 6);
    expect(win.to).toBe(5000 + 6);
    expect(drawDelay(win, win.from)).toBe(0);
    expect(drawDelay(win, win.from + 2)).toBe(2 * win.step);
    expect(drawDelay(win, win.from - 1)).toBeNull();
    expect(drawDelay(win, win.to + 1)).toBeNull();
  });

  it("clamps to the ends of the history", () => {
    const win = drawInWindow(9999, 9999, COL_W * 10);
    expect(win.to).toBe(9999);
    expect(win.from).toBe(9999 - 6);
    const small = drawInWindow(0, 2, 4000);
    expect(small).toMatchObject({ from: 0, to: 2 });
  });

  it("caps the span and the total stagger when zoomed far out", () => {
    const win = drawInWindow(500, 1000, 4000, 0.1);
    expect(win.to - win.from).toBeLessThanOrEqual(48);
    expect((win.to - win.from) * win.step).toBeLessThanOrEqual(840);
  });

  it("draws nothing for an empty history", () => {
    const win = drawInWindow(0, -1, 1000);
    expect(drawDelay(win, 0)).toBeNull();
  });
});

describe("scribbleLoop", () => {
  it("is the same loop for the same commit, and a different one for another", () => {
    expect(scribbleLoop(30, "a")).toBe(scribbleLoop(30, "a"));
    expect(scribbleLoop(30, "a")).not.toBe(scribbleLoop(30, "b"));
  });

  it("is an open pen stroke that stays near its radius", () => {
    const d = scribbleLoop(30, "abc");
    expect(d.startsWith("M ")).toBe(true);
    expect(d).not.toContain("Z");
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      const r = Math.hypot(nums[i], nums[i + 1]);
      expect(r).toBeLessThan(30 * 1.3);
      expect(r).toBeGreaterThan(30 * 0.75);
    }
  });
});

describe("camera glide", () => {
  const from = { zoom: 0.5, x: 100, y: 200 };
  const to = { zoom: 2, x: 300, y: 600 };

  it("starts and ends exactly on its shots", () => {
    expect(cameraAt(from, to, 0)).toEqual(from);
    expect(cameraAt(from, to, 1)).toEqual(to);
    expect(cameraAt(from, to, 1.4)).toEqual(to);
    expect(cameraAt(from, to, -0.2)).toEqual(from);
  });

  it("zooms geometrically and eases out", () => {
    const mid = cameraAt({ zoom: 1, x: 0, y: 0 }, { zoom: 4, x: 0, y: 0 }, 0.5);
    expect(mid.zoom).toBeCloseTo(4 ** easeOut(0.5));
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });

  it("takes longer for longer pans, within the motion budget", () => {
    expect(glideMs(from, from)).toBe(200);
    expect(glideMs({ zoom: 1, x: 0, y: 0 }, { zoom: 1, x: 600, y: 0 })).toBe(230);
    expect(glideMs({ zoom: 1, x: 0, y: 0 }, { zoom: 1, x: 90000, y: 0 })).toBe(280);
  });
});

describe("fitting the whole history", () => {
  it("fits the tighter side, rounded down, within the zoom range", () => {
    expect(fitZoom(1000, 400, 1040, 2000, 20, 0.45, 1)).toBe(1);
    expect(fitZoom(2000, 400, 1040, 2000, 20, 0.45, 1)).toBe(0.5);
    expect(fitZoom(3000, 400, 1040, 2000, 20, 0.45, 1)).toBe(0.45);
    expect(fitZoom(1000, 1000, 799, 799, 0, 0.1, 1)).toBe(0.79);
  });

  it("centres an axis that fits, and stays near the current spot when it does not", () => {
    expect(fitAxis(0, 400, 1000, 20, 1, 9999)).toBe(200);
    // 5000px at zoom 0.5 is 2500px: too wide for a 1000px view, so keep near where we are.
    expect(fitAxis(0, 5000, 1000, 0, 0.5, 3000)).toBe(3000);
    expect(fitAxis(0, 5000, 1000, 0, 0.5, 50)).toBe(1000);
    expect(fitAxis(0, 5000, 1000, 0, 0.5, 9000)).toBe(4000);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in for wheel up and out for wheel down, about 12% a notch", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeCloseTo(1 / 1.12, 1);
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1);
  });

  it("treats line and page deltas like pixels and caps huge jumps", () => {
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48));
    expect(wheelZoomFactor(10000)).toBe(wheelZoomFactor(240));
    expect(wheelZoomFactor(1, 2)).toBe(wheelZoomFactor(240));
  });
});

describe("minimap overview", () => {
  it("squeezes each branch row to one stroke from its oldest to newest commit", () => {
    const spans = laneSpans([
      { lane: 0, row: 0, x: 300, y: 10, color: "a" },
      { lane: 0, row: 0, x: 100, y: 10, color: "a" },
      { lane: 1, row: 1, x: 200, y: 50, color: "b" },
      { lane: 0, row: 0, x: 500, y: 10, color: "a" },
    ]);
    expect(spans).toEqual([
      { key: "0:0", color: "a", x1: 100, x2: 500, y: 10 },
      { key: "1:1", color: "b", x1: 200, x2: 200, y: 50 },
    ]);
  });

  it("measures the on-screen window as fractions and scrolls back to it", () => {
    expect(visibleWindow(250, 250, 1000)).toEqual({ start: 0.25, size: 0.25 });
    expect(visibleWindow(0, 1200, 1000)).toEqual({ start: 0, size: 1 });
    expect(visibleWindow(900, 250, 1000).start).toBe(0.75);
    expect(scrollForWindow(0.25, 250, 1000)).toBe(250);
    expect(scrollForWindow(-0.1, 250, 1000)).toBe(0);
    expect(scrollForWindow(0.9, 250, 1000)).toBe(750);
    expect(scrollForWindow(0.5, 1200, 1000)).toBe(0);
  });
});
