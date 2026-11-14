import { describe, expect, it } from "vitest";
import { busyFinishedNote, headText, pauseCopy, pausedOp, withBusy } from "./appStatus";

describe("pausedOp", () => {
  it("finds no paused operation", () => {
    expect(pausedOp(false, false)).toBeNull();
  });
  it("finds a paused rebase or merge", () => {
    expect(pausedOp(true, false)).toBe("rebase");
    expect(pausedOp(false, true)).toBe("merge");
  });
  it("prefers the rebase when both refs exist", () => {
    expect(pausedOp(true, true)).toBe("rebase");
  });
});

describe("pauseCopy", () => {
  it("names the operation and its abort key", () => {
    expect(pauseCopy("rebase").abort).toBe("Abort rebase");
    expect(pauseCopy("merge").abort).toBe("Abort merge");
    expect(pauseCopy("merge").title).toMatch(/merge is paused/);
    expect(pauseCopy("rebase").label).toBe("Rebase paused");
  });
});

describe("headText", () => {
  it("says the branch, noting a paused merge", () => {
    expect(headText("main", null)).toBe("On main");
    expect(headText("main", "merge")).toBe("On main (merging)");
  });
  it("explains a detached HEAD", () => {
    expect(headText(null, "rebase")).toBe("Rebasing (paused)");
    expect(headText(null, null)).toBe("Detached HEAD");
  });
});

describe("withBusy", () => {
  it("keeps the same set when nothing changes", () => {
    const set: ReadonlySet<string> = new Set(["ai"]);
    expect(withBusy(set, "ai", true)).toBe(set);
    expect(withBusy(set, "reviews", false)).toBe(set);
  });
  it("adds and removes without touching the original", () => {
    const set: ReadonlySet<string> = new Set(["ai"]);
    const more = withBusy(set, "reviews", true);
    expect([...more].sort()).toEqual(["ai", "reviews"]);
    expect(set.size).toBe(1);
    expect([...withBusy(more, "ai", false)]).toEqual(["reviews"]);
  });
});

describe("busyFinishedNote", () => {
  it("announces a job that finished out of sight", () => {
    expect(busyFinishedNote("Local AI", true, false, false)).toBe("Local AI finished working.");
  });
  it("stays quiet when the user is watching, nothing ran, or it is still running", () => {
    expect(busyFinishedNote("Local AI", true, false, true)).toBeNull();
    expect(busyFinishedNote("Local AI", false, false, false)).toBeNull();
    expect(busyFinishedNote("Local AI", true, true, false)).toBeNull();
  });
});
