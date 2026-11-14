import { describe, expect, it } from "vitest";
import { fitMapBox, MAP_MAX, MAP_MIN, nudgeMapBox, type MapBox } from "./MiniMap";

const box: MapBox = { right: 16, bottom: 16, w: 520, h: 340 };
const room = { w: 1200, h: 800 };

describe("moving the editor's commit map from the keyboard", () => {
  it("moves with the arrow keys (the box is measured from the bottom-right corner)", () => {
    expect(nudgeMapBox(box, "ArrowLeft", false, room)).toEqual({ ...box, right: 32 });
    expect(nudgeMapBox(box, "ArrowUp", false, room)).toEqual({ ...box, bottom: 32 });
    expect(nudgeMapBox({ ...box, right: 40 }, "ArrowRight", false, room)).toEqual({ ...box, right: 24 });
    expect(nudgeMapBox({ ...box, bottom: 40 }, "ArrowDown", false, room)).toEqual({ ...box, bottom: 24 });
  });

  it("resizes with Shift: Right and Up grow it", () => {
    expect(nudgeMapBox(box, "ArrowRight", true, room)).toEqual({ ...box, w: 536 });
    expect(nudgeMapBox(box, "ArrowLeft", true, room)).toEqual({ ...box, w: 504 });
    expect(nudgeMapBox(box, "ArrowUp", true, room)).toEqual({ ...box, h: 356 });
    expect(nudgeMapBox(box, "ArrowDown", true, room)).toEqual({ ...box, h: 324 });
  });

  it("ignores other keys", () => {
    expect(nudgeMapBox(box, "Enter", false, room)).toBeNull();
    expect(nudgeMapBox(box, "a", true, room)).toBeNull();
  });

  it("stays inside the editor and within its size limits", () => {
    expect(nudgeMapBox({ ...box, right: 8 }, "ArrowRight", false, room)?.right).toBe(8);
    expect(nudgeMapBox({ ...box, right: 1200 - 520 - 8 }, "ArrowLeft", false, room)?.right).toBe(672);
    expect(nudgeMapBox({ ...box, bottom: 800 - 340 - 8 }, "ArrowUp", false, room)?.bottom).toBe(452);
    expect(nudgeMapBox({ ...box, w: MAP_MIN.w }, "ArrowLeft", true, room)?.w).toBe(MAP_MIN.w);
    expect(nudgeMapBox({ ...box, h: MAP_MAX.h }, "ArrowUp", true, room)?.h).toBe(MAP_MAX.h);
  });

  it("lets a map folded down to its bar move right up to the top", () => {
    const folded = { ...box, bottom: 700 };
    expect(nudgeMapBox(folded, "ArrowUp", false, room)?.bottom).toBe(452);
    expect(nudgeMapBox(folded, "ArrowUp", false, room, 34)?.bottom).toBe(716);
  });

  it("keeps the edge margin when the editor is smaller than the map", () => {
    expect(fitMapBox({ ...box, right: 100, bottom: 100 }, { w: 300, h: 150 })).toEqual({
      ...box,
      right: 8,
      bottom: 8,
    });
    expect(fitMapBox({ ...box, right: 5000 }, null).right).toBe(5000);
  });
});
