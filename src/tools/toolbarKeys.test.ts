import { describe, expect, it } from "vitest";
import { branchKeyLabel, branchMenuOrder, branchNameProblem, isRepoShortcut, rovingIndex } from "./toolbarKeys";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isRepoShortcut", () => {
  it("takes Ctrl or Cmd with O or L", () => {
    expect(isRepoShortcut(key("o", { ctrlKey: true }))).toBe(true);
    expect(isRepoShortcut(key("L", { ctrlKey: true }))).toBe(true);
    expect(isRepoShortcut(key("l", { metaKey: true }))).toBe(true);
  });

  it("ignores the plain letters and other modifiers", () => {
    expect(isRepoShortcut(key("o"))).toBe(false);
    expect(isRepoShortcut(key("o", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isRepoShortcut(key("l", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isRepoShortcut(key("f", { ctrlKey: true }))).toBe(false);
  });
});

describe("rovingIndex", () => {
  it("walks down and up, wrapping round", () => {
    expect(rovingIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(rovingIndex(0, 3, "ArrowDown")).toBe(1);
    expect(rovingIndex(2, 3, "ArrowDown")).toBe(0);
    expect(rovingIndex(0, 3, "ArrowUp")).toBe(2);
    expect(rovingIndex(-1, 3, "ArrowUp")).toBe(2);
    expect(rovingIndex(2, 3, "ArrowUp")).toBe(1);
  });

  it("jumps to the ends", () => {
    expect(rovingIndex(1, 4, "Home")).toBe(0);
    expect(rovingIndex(1, 4, "End")).toBe(3);
  });

  it("does nothing for other keys or an empty list", () => {
    expect(rovingIndex(1, 4, "Enter")).toBeNull();
    expect(rovingIndex(-1, 0, "ArrowDown")).toBeNull();
  });
});

describe("branchKeyLabel", () => {
  it("names the branch, or says it is detached", () => {
    expect(branchKeyLabel("main", null)).toBe("main");
    expect(branchKeyLabel(null, null)).toBe("(detached)");
  });

  it("says what it is doing while git runs", () => {
    expect(branchKeyLabel("main", "switch")).toBe("Switching…");
    expect(branchKeyLabel("main", "create")).toBe("Creating…");
  });
});

describe("branchMenuOrder", () => {
  it("puts the current branch first and keeps the rest in order", () => {
    expect(branchMenuOrder(["a", "main", "b"], "main")).toEqual(["main", "a", "b"]);
  });

  it("leaves the list as it is when detached or the branch is unknown", () => {
    expect(branchMenuOrder(["a", "b"], null)).toEqual(["a", "b"]);
    expect(branchMenuOrder(["a", "b"], "c")).toEqual(["a", "b"]);
  });
});

describe("branchNameProblem", () => {
  it("accepts ordinary names and an empty field", () => {
    expect(branchNameProblem("feature/ui-2", [])).toBeNull();
    expect(branchNameProblem("  ", [])).toBeNull();
  });

  it("rejects what git or the switcher would refuse", () => {
    expect(branchNameProblem("has space", [])).not.toBeNull();
    expect(branchNameProblem("-x", [])).not.toBeNull();
    expect(branchNameProblem("a..b", [])).not.toBeNull();
    expect(branchNameProblem("a/", [])).not.toBeNull();
    expect(branchNameProblem("x.lock", [])).not.toBeNull();
  });

  it("notices a branch that already exists", () => {
    expect(branchNameProblem("main", ["main"])).toMatch(/already/);
  });
});
