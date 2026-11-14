import { describe, expect, it } from "vitest";
import { createBusyLatch } from "./panelHooks";

function record() {
  const calls: boolean[] = [];
  return { calls, latch: createBusyLatch((busy) => calls.push(busy)) };
}

describe("createBusyLatch", () => {
  it("reports only transitions, never the same value twice in a row", () => {
    const { calls, latch } = record();
    latch.set(true);
    latch.set(true);
    latch.set(false);
    latch.set(false);
    latch.set(true);
    expect(calls).toEqual([true, false, true]);
  });

  it("never opens with false: idle is the starting point", () => {
    const { calls, latch } = record();
    latch.set(false);
    latch.release();
    expect(calls).toEqual([]);
  });

  it("releases with false only while busy", () => {
    const { calls, latch } = record();
    latch.set(true);
    latch.release();
    latch.release();
    expect(calls).toEqual([true, false]);
  });

  it("reports busy again after a release (a StrictMode remount)", () => {
    const { calls, latch } = record();
    latch.set(true);
    latch.release();
    latch.set(true);
    expect(calls).toEqual([true, false, true]);
  });
});
