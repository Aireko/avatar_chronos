import { describe, expect, it } from "vitest";
import type { Commit } from "../backend";
import { findJumpTarget, findMatches, matchCommit, matchSummary, parseFindQuery, stepMatch } from "./findCommits";

function commit(hash: string, author: string, message: string): Commit {
  return { hash, shortHash: hash.slice(0, 7), parents: [], author, timestamp: 0, message, refs: [], filesChanged: [] };
}

const commits = [
  commit("a1b2c3d4e5", "Jane Doe", "Fix the login redirect"),
  commit("ff00aa11bb", "Bob Stone", "Add a login page"),
  commit("0123456789", "jane roe", "Update README"),
];

describe("parseFindQuery", () => {
  it("splits plain words and author filters, lower-cased", () => {
    expect(parseFindQuery("  Login  author:Jane fix ")).toEqual({ authors: ["jane"], words: ["login", "fix"] });
  });

  it("keeps quoted phrases together, for words and authors", () => {
    expect(parseFindQuery('author:"Jane Doe" "login redirect"')).toEqual({
      authors: ["jane doe"],
      words: ["login redirect"],
    });
  });

  it('applies a bare "author:" to the next term', () => {
    expect(parseFindQuery("author: bob page")).toEqual({ authors: ["bob"], words: ["page"] });
    expect(parseFindQuery('AUTHOR: "Jane Doe"')).toEqual({ authors: ["jane doe"], words: [] });
  });

  it("tolerates an unfinished quote and empty filters", () => {
    expect(parseFindQuery('"login re')).toEqual({ authors: [], words: ["login re"] });
    expect(parseFindQuery('author:"" author:')).toEqual({ authors: [], words: [] });
    expect(parseFindQuery("")).toEqual({ authors: [], words: [] });
  });
});

describe("matchCommit / findMatches", () => {
  it("matches words in the message, the author, or a hash prefix", () => {
    expect(findMatches(commits, "login")).toEqual(["a1b2c3d4e5", "ff00aa11bb"]);
    expect(findMatches(commits, "STONE")).toEqual(["ff00aa11bb"]);
    expect(findMatches(commits, "a1B2")).toEqual(["a1b2c3d4e5"]);
  });

  it("only matches a hash at its start", () => {
    expect(findMatches(commits, "c3d4")).toEqual([]);
  });

  it("requires every term", () => {
    expect(findMatches(commits, "login author:jane")).toEqual(["a1b2c3d4e5"]);
    expect(findMatches(commits, "author:jane")).toEqual(["a1b2c3d4e5", "0123456789"]);
    expect(findMatches(commits, "author:jane readme")).toEqual(["0123456789"]);
    expect(findMatches(commits, "author:bob readme")).toEqual([]);
  });

  it("does not match the author filter against the message", () => {
    expect(findMatches(commits, "author:login")).toEqual([]);
  });

  it("matches nothing for an empty query", () => {
    expect(findMatches(commits, "   ")).toEqual([]);
    expect(matchCommit(commits[0], { authors: [], words: [] })).toBe(false);
  });
});

describe("stepMatch", () => {
  it("wraps around in both directions", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
  });

  it("starts at the first or last match when not on one", () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(7, 3, 1)).toBe(0);
  });

  it("returns -1 without matches", () => {
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});

describe("matchSummary", () => {
  it("says where you are", () => {
    expect(matchSummary(1, 12, true)).toBe("2 of 12");
    expect(matchSummary(-1, 12, true)).toBe("12 matches");
    expect(matchSummary(-1, 1, true)).toBe("1 match");
    expect(matchSummary(-1, 0, true)).toBe("No matches");
    expect(matchSummary(-1, 0, false)).toBe("");
  });
});

describe("findJumpTarget", () => {
  it("stays put when nothing matches", () => {
    expect(findJumpTarget([], null)).toBeNull();
    expect(findJumpTarget([], "a")).toBeNull();
  });

  it("stays on the selected commit while it still matches", () => {
    expect(findJumpTarget(["a", "b", "c"], "b")).toBeNull();
  });

  it("goes to the first match otherwise", () => {
    expect(findJumpTarget(["a", "b"], null)).toBe("a");
    expect(findJumpTarget(["a", "b"], "z")).toBe("a");
  });
});
