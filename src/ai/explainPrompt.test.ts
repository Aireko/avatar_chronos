import { describe, expect, it } from "vitest";
import type { Commit, FileChange } from "../backend";
import { EXPLAIN_SYSTEM, FILE_LIST_LIMIT, buildExplainPrompt, formatCommitDate, truncatePatch } from "./explainPrompt";

function file(path: string, additions: number, deletions: number, extra: Partial<FileChange> = {}): FileChange {
  return { path, oldPath: null, status: "M", additions, deletions, symbolsTouched: [], ...extra };
}

const commit: Commit = {
  hash: "abcdef1234567890",
  shortHash: "abcdef1",
  parents: ["1111111"],
  author: "Jane Doe",
  timestamp: 1_700_000_000,
  message: "Fix the login redirect",
  refs: [],
  filesChanged: [file("src/login.ts", 3, 1), file("src/new.ts", 10, 0, { oldPath: "src/old.ts", status: "R" })],
};

describe("formatCommitDate", () => {
  it("is UTC and locale-independent", () => {
    expect(formatCommitDate(1_700_000_000)).toBe("2023-11-14 22:13 UTC");
  });
});

describe("truncatePatch", () => {
  it("leaves short text alone", () => {
    expect(truncatePatch("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  it("cuts at a line break near the limit", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(50)}`;
    expect(truncatePatch(text, 100)).toEqual({ text: "a".repeat(90), truncated: true });
  });

  it("cuts mid-line when no line break is close", () => {
    const text = `ab\n${"c".repeat(200)}`;
    const cut = truncatePatch(text, 100);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toHaveLength(100);
  });
});

describe("buildExplainPrompt", () => {
  it("includes the message, author, date, files with counts and the patch", () => {
    const { prompt, system } = buildExplainPrompt({ commit, patch: "diff --git a/src/login.ts b/src/login.ts\n+x\n" });
    expect(system).toBe(EXPLAIN_SYSTEM);
    expect(prompt).toContain("Fix the login redirect");
    expect(prompt).toContain("Author: Jane Doe");
    expect(prompt).toContain("Date: 2023-11-14 22:13 UTC");
    expect(prompt).toContain("Commit: abcdef1234567890");
    expect(prompt).toContain("Changed files (2 files, +13 -1):");
    expect(prompt).toContain("- src/login.ts (modified, +3 -1)");
    expect(prompt).toContain("- src/old.ts -> src/new.ts (renamed, +10 -0)");
    expect(prompt).toContain("diff --git a/src/login.ts b/src/login.ts\n+x");
    expect(prompt).not.toContain("truncated");
  });

  it("truncates a long patch with a note", () => {
    const patch = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n");
    const { prompt } = buildExplainPrompt({ commit, patch, limit: 1000 });
    expect(prompt).toContain("+line 0");
    expect(prompt).not.toContain("+line 1999");
    expect(prompt).toMatch(/truncated to the first [\d,]+ of [\d,]+ characters/);
    expect(prompt.length).toBeLessThan(2500);
  });

  it("notes when the backend already cut the output", () => {
    const { prompt } = buildExplainPrompt({ commit, patch: "+small", patchTruncated: true });
    expect(prompt).toContain("cut short");
  });

  it("explains from the metadata when the patch could not be read", () => {
    const { prompt } = buildExplainPrompt({ commit, patch: null });
    expect(prompt).toContain("could not be read");
    expect(prompt).toContain("Author: Jane Doe");
    expect(prompt).not.toContain("<<<");
  });

  it("handles an empty patch, merges, root commits and empty file lists", () => {
    const merge = { ...commit, parents: ["a", "b"], filesChanged: [] };
    const { prompt } = buildExplainPrompt({ commit: merge, patch: "  \n" });
    expect(prompt).toContain("merge commit with 2 parents");
    expect(prompt).toContain("Changed files: none.");
    expect(prompt).toContain("printed no patch");
    expect(buildExplainPrompt({ commit: { ...commit, parents: [] }, patch: null }).prompt).toContain("first commit");
  });

  it("cuts a very long file list short", () => {
    const many = { ...commit, filesChanged: Array.from({ length: FILE_LIST_LIMIT + 5 }, (_, i) => file(`f${i}.ts`, 1, 0)) };
    const { prompt } = buildExplainPrompt({ commit: many, patch: null });
    expect(prompt).toContain(`f${FILE_LIST_LIMIT - 1}.ts`);
    expect(prompt).not.toContain(`f${FILE_LIST_LIMIT}.ts`);
    expect(prompt).toContain("...and 5 more files");
  });
});
