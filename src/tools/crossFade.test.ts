import { describe, expect, it } from "vitest";
import { crossFade } from "./crossFade";

describe("crossFade", () => {
  it("applies the change at once when view transitions are missing", () => {
    let runs = 0;
    expect(crossFade(() => runs++, {})).toBe(false);
    expect(runs).toBe(1);
  });

  it("skips the fade when the user prefers reduced motion", () => {
    let runs = 0;
    let started = 0;
    const env = { reducedMotion: true, startViewTransition: () => void started++ };
    expect(crossFade(() => runs++, env)).toBe(false);
    expect(runs).toBe(1);
    expect(started).toBe(0);
  });

  it("skips the fade while the window is hidden", () => {
    let runs = 0;
    let started = 0;
    const env = { hidden: true, startViewTransition: () => void started++ };
    expect(crossFade(() => runs++, env)).toBe(false);
    expect(runs).toBe(1);
    expect(started).toBe(0);
  });

  it("hands the change to the view transition", () => {
    let runs = 0;
    let pending: (() => void) | null = null;
    const env = {
      startViewTransition: (update: () => void) => {
        pending = update;
        return { ready: Promise.reject(new Error("skipped")), finished: Promise.resolve() };
      },
    };
    expect(crossFade(() => runs++, env)).toBe(true);
    expect(runs).toBe(0);
    pending!();
    expect(runs).toBe(1);
  });

  it("still applies the change, once, when starting the transition throws", () => {
    let runs = 0;
    const env = {
      startViewTransition: (update: () => void) => {
        update();
        throw new Error("InvalidStateError");
      },
    };
    expect(crossFade(() => runs++, env)).toBe(false);
    expect(runs).toBe(1);
  });
});
