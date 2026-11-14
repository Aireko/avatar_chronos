import { describe, expect, it } from "vitest";
import { CROSS_FADING_ATTR, crossFade } from "./crossFade";

/** A stand-in for <html> that records the cross-fade flag. */
function fakeRoot() {
  const attrs = new Set<string>();
  return {
    attrs,
    setAttribute: (name: string) => void attrs.add(name),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
}

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

  it("switches element transitions off until the fade has finished", async () => {
    const root = fakeRoot();
    let pending: (() => void) | null = null;
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const env = {
      root,
      startViewTransition: (update: () => void) => {
        pending = update;
        return { finished };
      },
    };
    expect(crossFade(() => {}, env)).toBe(true);
    expect(root.attrs.has(CROSS_FADING_ATTR)).toBe(true);
    pending!();
    // Still fading: the new frame must not run its own colour transitions yet.
    expect(root.attrs.has(CROSS_FADING_ATTR)).toBe(true);
    finish();
    await finished;
    await Promise.resolve();
    expect(root.attrs.has(CROSS_FADING_ATTR)).toBe(false);
  });

  it("clears the flag when a skipped transition rejects", async () => {
    const root = fakeRoot();
    const finished = Promise.reject(new Error("skipped"));
    const env = { root, startViewTransition: (update: () => void) => (update(), { finished }) };
    crossFade(() => {}, env);
    await finished.catch(() => {});
    await Promise.resolve();
    expect(root.attrs.has(CROSS_FADING_ATTR)).toBe(false);
  });

  it("clears the flag at once when starting the transition throws", () => {
    const root = fakeRoot();
    const env = {
      root,
      startViewTransition: () => {
        throw new Error("InvalidStateError");
      },
    };
    let runs = 0;
    expect(crossFade(() => runs++, env)).toBe(false);
    expect(runs).toBe(1);
    expect(root.attrs.has(CROSS_FADING_ATTR)).toBe(false);
  });

  it("never sets the flag when there is no fade", () => {
    const root = fakeRoot();
    crossFade(() => {}, { root, reducedMotion: true, startViewTransition: () => {} });
    expect(root.attrs.size).toBe(0);
  });

  it("keeps the flag while a newer fade runs, when an older one finishes first", async () => {
    const root = fakeRoot();
    const finishes: Array<() => void> = [];
    const env = {
      root,
      startViewTransition: () => ({ finished: new Promise<void>((resolve) => finishes.push(resolve)) }),
    };
    crossFade(() => {}, env);
    crossFade(() => {}, env);
    // The second switch skips the first fade: its clean-up must leave the flag alone.
    finishes[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.attrs.has(CROSS_FADING_ATTR)).toBe(true);
    finishes[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.attrs.has(CROSS_FADING_ATTR)).toBe(false);
  });
});
