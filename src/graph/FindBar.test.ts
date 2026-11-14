import { describe, expect, it } from "vitest";
import { stepCue } from "./FindBar";

describe("stepCue", () => {
  it("ticks forward and back for one step among the same matches", () => {
    expect(stepCue(2, 12, 3, 12)).toBe("next");
    expect(stepCue(3, 12, 2, 12)).toBe("prev");
  });

  it("treats the wrap at either end as a single step", () => {
    expect(stepCue(11, 12, 0, 12)).toBe("next");
    expect(stepCue(0, 12, 11, 12)).toBe("prev");
  });

  it("reads two matches as forward, since both ways land on the same one", () => {
    expect(stepCue(0, 2, 1, 2)).toBe("next");
    expect(stepCue(1, 2, 0, 2)).toBe("next");
  });

  it("is plain for anything that isn't one step", () => {
    expect(stepCue(2, 12, 7, 12)).toBeNull(); // a jump (a click on the map)
    expect(stepCue(2, 12, 3, 13)).toBeNull(); // new matches
    expect(stepCue(-1, 12, 0, 12)).toBeNull(); // landing on a match
    expect(stepCue(4, 12, -1, 12)).toBeNull(); // leaving the matches
    expect(stepCue(0, 1, 0, 1)).toBeNull(); // one match: nowhere to go
    expect(stepCue(3, 12, 3, 12)).toBeNull(); // no move
    expect(stepCue(-1, 0, -1, 0)).toBeNull(); // no matches
  });
});
