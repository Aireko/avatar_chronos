import { describe, expect, it } from "vitest";
import {
  fetchDryRunHasUpdates,
  parseStatusBranchLine,
  readAutoFetch,
  syncBubbleLabel,
  syncHintFor,
  writeAutoFetch,
} from "./branchSync";

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

describe("fetchDryRunHasUpdates", () => {
  it("detects tip moves and new branches", () => {
    expect(
      fetchDryRunHasUpdates("", "From github.com:org/repo\n   abcdef0..1234567  main       -> origin/main\n"),
    ).toBe(true);
    expect(fetchDryRunHasUpdates(" * [new branch]      feat -> origin/feat\n")).toBe(true);
    expect(fetchDryRunHasUpdates("", "From github.com:org/repo\n")).toBe(false);
  });
});

describe("syncHintFor", () => {
  const base = {
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    hasOrigin: true,
    fetchNeeded: false,
  };

  it("offers Pull when behind", () => {
    expect(syncHintFor({ ...base, behind: 3 })).toEqual({ kind: "pull", behind: 3 });
  });

  it("offers Fetch only when a dry-run found updates", () => {
    expect(syncHintFor(base)).toBeNull();
    expect(syncHintFor({ ...base, fetchNeeded: true })).toEqual({ kind: "fetch" });
  });

  it("prefers Pull over Fetch", () => {
    expect(syncHintFor({ ...base, behind: 2, fetchNeeded: true })).toEqual({ kind: "pull", behind: 2 });
  });
});

describe("syncBubbleLabel", () => {
  it("names Fetch and Pull", () => {
    expect(syncBubbleLabel({ kind: "fetch" })).toBe("Fetch");
    expect(syncBubbleLabel({ kind: "pull", behind: 1 })).toBe("Pull · 1 behind");
    expect(syncBubbleLabel({ kind: "pull", behind: 4 })).toBe("Pull · 4 behind");
  });
});

describe("auto-fetch preference", () => {
  it("defaults off and round-trips", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(readAutoFetch(storage)).toBe(false);
    writeAutoFetch(true, storage);
    expect(readAutoFetch(storage)).toBe(true);
    writeAutoFetch(false, storage);
    expect(readAutoFetch(storage)).toBe(false);
  });
});
