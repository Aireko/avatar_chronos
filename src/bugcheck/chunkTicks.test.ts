import { describe, expect, it } from "vitest";
import { MAX_TICKS, chunkTicks, ticksLabel } from "./chunkTicks";

describe("chunkTicks", () => {
  it("draws nothing until the chunk count is known", () => {
    expect(chunkTicks(undefined, {})).toBeUndefined();
  });

  it("draws nothing for an empty diff or an invalid count", () => {
    expect(chunkTicks(0, {})).toBeUndefined();
    expect(chunkTicks(-2, {})).toBeUndefined();
    expect(chunkTicks(2.5, {})).toBeUndefined();
  });

  it("falls back to a plain bar past the tick limit", () => {
    expect(chunkTicks(MAX_TICKS, {})).toHaveLength(MAX_TICKS);
    expect(chunkTicks(MAX_TICKS + 1, {})).toBeUndefined();
  });

  it("marks finished, failed, active and waiting chunks", () => {
    expect(chunkTicks(5, { 0: "done", 1: "failed" }, 2)).toEqual(["done", "failed", "active", "waiting", "waiting"]);
  });

  it("keeps a chunk's outcome even if it is still named as the active one", () => {
    expect(chunkTicks(2, { 1: "done" }, 1)).toEqual(["waiting", "done"]);
  });

  it("ignores outcomes and an active index outside the run", () => {
    expect(chunkTicks(2, { 5: "done" }, 7)).toEqual(["waiting", "waiting"]);
  });
});

describe("ticksLabel", () => {
  it("counts checked parts", () => {
    expect(ticksLabel(8, 3, 0)).toBe("3 of 8 parts checked");
    expect(ticksLabel(1, 0, 0)).toBe("0 of 1 part checked");
  });

  it("mentions failed parts", () => {
    expect(ticksLabel(8, 3, 1)).toBe("3 of 8 parts checked, 1 failed");
  });
});
