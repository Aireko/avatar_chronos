import { describe, expect, it } from "vitest";
import type { BlameReport } from "../backend";
import {
  MAX_MAILTO_LENGTH,
  buildDraft,
  contributorsInRange,
  isUndeliverable,
  draftBody,
  draftSubject,
  isBot,
  isMailable,
  isNoReply,
  mailtoUrl,
  repoName,
  type DraftContext,
} from "./contributors";

const sha = (c: string) => c.repeat(40);

// 25-line file: base commit by Chronos (1-25), then Ada changed lines 3 and 9
// in two commits with differently cased emails, and Bob changed 15.
const report: BlameReport = {
  repoPath: "C:/src/minikv",
  path: "src/kv.c",
  revision: sha("f"),
  totalLines: 25,
  authors: [],
  commits: [
    { hash: sha("d"), author: "Ada Lovelace", email: "ada@example.com", time: 400, summary: "fix beta", lines: 1 },
    { hash: sha("c"), author: "Bob Ng", email: "bob@example.com", time: 300, summary: "tweak gamma", lines: 1 },
    { hash: sha("b"), author: "Ada L.", email: "Ada@Example.com", time: 200, summary: "fix alpha", lines: 1 },
    { hash: sha("a"), author: "Chronos Test", email: "chronos@example.com", time: 100, summary: "base", lines: 22 },
  ],
  ranges: [
    { start: 1, end: 2, commit: sha("a") },
    { start: 3, end: 3, commit: sha("b") },
    { start: 4, end: 8, commit: sha("a") },
    { start: 9, end: 9, commit: sha("d") },
    { start: 10, end: 14, commit: sha("a") },
    { start: 15, end: 15, commit: sha("c") },
    { start: 16, end: 25, commit: sha("a") },
  ],
  symbols: [{ name: "alpha", kind: "function", startLine: 1, endLine: 5 }],
};

describe("contributorsInRange", () => {
  it("counts the whole file and merges emails case-insensitively", () => {
    const people = contributorsInRange(report, 1, 25);
    expect(people.map((p) => [p.name, p.lines, p.commits])).toEqual([
      ["Chronos Test", 22, 1],
      ["Ada Lovelace", 2, 2], // name and email come from the newest commit
      ["Bob Ng", 1, 1],
    ]);
    expect(people[1].latest.summary).toBe("fix beta");
  });

  it("only counts lines inside the range", () => {
    const people = contributorsInRange(report, 1, 5);
    expect(people.map((p) => [p.name, p.lines])).toEqual([
      ["Chronos Test", 4],
      ["Ada L.", 1],
    ]);
  });

  it("returns nobody for an empty range", () => {
    expect(contributorsInRange(report, 30, 40)).toEqual([]);
  });

  it("merges a commit without an email into the same-named person's emailed group", () => {
    const mixed: BlameReport = {
      ...report,
      commits: report.commits.map((c) => (c.hash === sha("c") ? { ...c, author: "Chronos Test", email: "" } : c)),
    };
    const people = contributorsInRange(mixed, 1, 25);
    expect(people.map((p) => [p.name, p.lines, p.commits])).toEqual([
      ["Chronos Test", 23, 2],
      ["Ada Lovelace", 2, 2],
    ]);
  });

  it("falls back to the name when there is no email", () => {
    const noEmail: BlameReport = {
      ...report,
      commits: report.commits.map((c) => ({ ...c, email: "" })),
    };
    expect(contributorsInRange(noEmail, 1, 25).map((p) => p.name)).toEqual([
      "Chronos Test",
      "Ada Lovelace",
      "Bob Ng",
      "Ada L.",
    ]);
  });
});

describe("email checks", () => {
  it("knows which addresses can receive mail", () => {
    expect(isMailable("ada@example.com")).toBe(true);
    expect(isMailable("not.committed.yet")).toBe(false);
    expect(isMailable("")).toBe(false);
    expect(isMailable("ada@localhost")).toBe(false);
  });

  it("flags no-reply addresses and bots", () => {
    expect(isNoReply("12345+ada@users.noreply.github.com")).toBe(true);
    expect(isNoReply("noreply@github.com")).toBe(true);
    expect(isNoReply("do-not-reply@example.com")).toBe(true);
    expect(isNoReply("ada@example.com")).toBe(false);
    expect(isNoReply("snoreply.fan@example.com")).toBe(false);
    expect(isUndeliverable("12345+ada@users.noreply.github.com")).toBe(true);
    expect(isUndeliverable("noreply@github.com")).toBe(false);
    expect(isBot("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toBe(true);
    expect(isBot("Ada", "ada@example.com")).toBe(false);
  });
});

describe("email draft", () => {
  const ctx: DraftContext = {
    repoName: "minikv",
    path: "src/kv.c",
    feature: "alpha",
    start: 1,
    end: 5,
    totalLines: 25,
    question: "Why add 2?",
  };
  const [, ada] = contributorsInRange(report, 1, 25);

  it("names the feature, lines, commit and question", () => {
    expect(draftSubject(ctx)).toBe("Question about alpha in src/kv.c (minikv)");
    const body = draftBody(ada, ctx);
    expect(body).toContain("Hi Ada,");
    expect(body).toContain("alpha in src/kv.c (lines 1-5) in minikv");
    expect(body).toContain('dddddd');
    expect(body).toContain('"fix beta"');
    expect(body).toContain("Why add 2?");
    expect(body).toContain("\r\n"); // RFC 6068 line breaks
  });

  it("uses a placeholder when no question was typed, and the file name for whole-file scope", () => {
    const body = draftBody(ada, { ...ctx, feature: null, start: 1, end: 25, question: "  " });
    expect(body).toContain("looking at src/kv.c in minikv");
    expect(body).toContain("[Your question]");
  });

  it("keeps the whole link under the length limit without splitting characters", () => {
    const long = { ...ctx, question: "Why? 🙂 ".repeat(400) };
    const draft = buildDraft(ada, long);
    expect(draft.shortened).toBe(true);
    expect(draft.url.length).toBeLessThanOrEqual(MAX_MAILTO_LENGTH);
    const body = new URL(draft.url).searchParams.get("body")!; // throws on a broken surrogate pair
    expect(body).toContain("[...]");
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("leaves short questions alone", () => {
    const draft = buildDraft(ada, ctx);
    expect(draft.shortened).toBe(false);
    expect(new URL(draft.url).searchParams.get("body")).toContain("Why add 2?");
  });

  it("builds an encoded mailto URL", () => {
    const url = mailtoUrl("a+b@example.com", "Q & A?", "line 1\r\nline 2");
    expect(url).toBe("mailto:a%2Bb@example.com?subject=Q%20%26%20A%3F&body=line%201%0D%0Aline%202");
  });

  it("takes the repository name from a Windows or POSIX path", () => {
    expect(repoName("C:\\Users\\me\\minikv\\")).toBe("minikv");
    expect(repoName("/home/me/minikv")).toBe("minikv");
  });
});
