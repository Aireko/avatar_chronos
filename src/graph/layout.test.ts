import { describe, expect, it } from "vitest";
import { COL_W, drawDelay, drawInWindow } from "./layout";

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
