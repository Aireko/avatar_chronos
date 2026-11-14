import { describe, expect, it } from "vitest";
import { parseStatusBranchLine, syncBubbleLabel, syncHintFor } from "./branchSync";

describe("parseStatusBranchLine", () => {
  it("reads a branch with no upstream", () => {
    expect(parseStatusBranchLine("## feature/x")).toEqual({
      branch: "feature/x",
      upstream: null,
      ahead: 0,
      behind: 0,
    });
  });

  it("reads tracking with no drift", () => {
    expect(parseStatusBranchLine("## main...origin/main")).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    });
  });

  it("reads ahead and behind", () => {
    expect(parseStatusBranchLine("## main...origin/main [ahead 1, behind 2]\n M src/a.ts")).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
    });
  });

  it("reads behind alone", () => {
    expect(parseStatusBranchLine("## debug/x...origin/debug/x [behind 4]")).toEqual({
      branch: "debug/x",
      upstream: "origin/debug/x",
      ahead: 0,
      behind: 4,
    });
  });

  it("keeps dots inside the branch name", () => {
    expect(parseStatusBranchLine("## release-1.2...origin/release-1.2 [ahead 2]")).toEqual({
      branch: "release-1.2",
      upstream: "origin/release-1.2",
      ahead: 2,
      behind: 0,
    });
  });

  it("ignores detached HEAD", () => {
    expect(parseStatusBranchLine("## HEAD (no branch)")).toEqual({
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("syncHintFor", () => {
  const tracked = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0 };

  it("offers Pull when behind", () => {
    expect(syncHintFor({ ...tracked, behind: 3 }, true)).toEqual({ kind: "pull", behind: 3 });
  });

  it("offers Fetch until the first fetch of the session", () => {
    expect(syncHintFor(tracked, false)).toEqual({ kind: "fetch" });
    expect(syncHintFor(tracked, true)).toBeNull();
  });

  it("stays quiet without an upstream", () => {
    expect(syncHintFor({ branch: "local", upstream: null, ahead: 0, behind: 0 }, false)).toBeNull();
  });
});

describe("syncBubbleLabel", () => {
  it("names Fetch and Pull", () => {
    expect(syncBubbleLabel({ kind: "fetch" })).toBe("Fetch");
    expect(syncBubbleLabel({ kind: "pull", behind: 1 })).toBe("Pull · 1 behind");
    expect(syncBubbleLabel({ kind: "pull", behind: 4 })).toBe("Pull · 4 behind");
  });
});
