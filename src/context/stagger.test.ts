import { describe, expect, it } from "vitest";
import {
  STAGGER_MAX_STEPS,
  STAGGER_STEP_MS,
  sectionStarts,
  staggerDelayMs,
} from "./ContextViewsPanel";

describe("staggerDelayMs (brief items and relationship rows easing in)", () => {
  it("starts the first item at once and steps each next one by a small gap", () => {
    expect(staggerDelayMs(0)).toBe(0);
    expect(staggerDelayMs(1)).toBe(STAGGER_STEP_MS);
    expect(staggerDelayMs(3)).toBe(3 * STAGGER_STEP_MS);
  });

  it("caps the delay so a long list never keeps its last rows waiting", () => {
    const cap = STAGGER_MAX_STEPS * STAGGER_STEP_MS;
    expect(staggerDelayMs(STAGGER_MAX_STEPS)).toBe(cap);
    expect(staggerDelayMs(STAGGER_MAX_STEPS + 1)).toBe(cap);
    expect(staggerDelayMs(500)).toBe(cap);
    // The whole entrance stays quick: the cap is under the app's 280ms ceiling.
    expect(cap).toBeLessThanOrEqual(280);
  });

  it("treats odd input as the first item", () => {
    expect(staggerDelayMs(-4)).toBe(0);
    expect(staggerDelayMs(Number.NaN)).toBe(0);
    expect(staggerDelayMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(staggerDelayMs(2.7)).toBe(2 * STAGGER_STEP_MS);
  });

  it("takes a custom step and cap", () => {
    expect(staggerDelayMs(5, 10, 3)).toBe(30);
    expect(staggerDelayMs(2, 10, 3)).toBe(20);
    expect(staggerDelayMs(5, 10, 0)).toBe(0);
    expect(staggerDelayMs(5, -10, 3)).toBe(0);
  });
});

describe("sectionStarts (one running order through the brief)", () => {
  it("gives each section the index its first item has in the whole brief", () => {
    expect(sectionStarts([3, 0, 2, 4])).toEqual([0, 3, 3, 5]);
  });

  it("handles an empty brief and ignores negative counts", () => {
    expect(sectionStarts([])).toEqual([]);
    expect(sectionStarts([2, -1, 1])).toEqual([0, 2, 2]);
  });
});
