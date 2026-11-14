import { describe, expect, it } from "vitest";
import {
  normalizeBugCheckEvent,
  normalizeError,
  normalizeFinding,
  normalizeGhStatus,
  normalizePostResult,
  normalizePrList,
  normalizeReport,
  normalizeWatcherEvent,
  normalizeWatchState,
} from "./normalize";

describe("normalizeWatchState", () => {
  it("rejects a null state with a BugCheckError (the crash this guards against)", () => {
    expect(() => normalizeWatchState(null)).toThrow();
    try {
      normalizeWatchState(null);
    } catch (error) {
      expect(error).toMatchObject({ kind: "internal", message: expect.any(String) });
    }
  });

  it("fills a partial state", () => {
    const state = normalizeWatchState({ enabled: true, queue: [3, "x", null, 4], config: { repo: "a/b", intervalMinutes: 0 } });
    expect(state).toMatchObject({ enabled: true, queue: [3, 4], current: undefined });
    expect(state.config).toMatchObject({ repo: "a/b", intervalMinutes: 1, autoPost: false, includeDrafts: false });
    expect(normalizeWatchState({}).queue).toEqual([]);
    expect(normalizeWatchState({ config: { intervalMinutes: 5 } }).config).toBeUndefined();
  });
});

describe("normalizeError", () => {
  it("keeps known kinds and reads unknown shapes", () => {
    expect(normalizeError(undefined)).toBeUndefined();
    expect(normalizeError({ kind: "stale_report", message: "old" })).toMatchObject({ kind: "stale_report" });
    expect(normalizeError({ kind: "weird" })).toMatchObject({ kind: "internal", message: "Unknown error" });
  });
});

describe("normalizeGhStatus", () => {
  it("rejects null and fills a partial status", () => {
    expect(() => normalizeGhStatus(null)).toThrow();
    expect(normalizeGhStatus({ installed: true, user: "" })).toEqual({
      installed: true,
      authenticated: false,
      user: undefined,
      error: undefined,
    });
  });
});

describe("normalizePrList", () => {
  it("rejects a non-list and drops rows without a usable number or with a duplicate one", () => {
    expect(() => normalizePrList(null)).toThrow();
    const prs = normalizePrList([
      { number: 7, title: "Fix", author: { login: "ada" } },
      { number: "8" },
      null,
      { number: 7, title: "Again" },
      { number: 9, lastReport: { findingCount: "2" } },
    ]);
    expect(prs.map((pr) => pr.number)).toEqual([7, 9]);
    expect(prs[0]).toMatchObject({ author: "ada", additions: 0, url: "", isDraft: false });
    expect(prs[1].lastReport).toMatchObject({ findingCount: 0, upToDate: false });
  });
});

describe("normalizeFinding", () => {
  it("fills unknown severity, category and a missing id", () => {
    const finding = normalizeFinding({ path: "a.ts", line: 4, title: "Oops", severity: "huge", confidence: 3 });
    expect(finding).toMatchObject({
      id: "a.ts:4:Oops",
      severity: "medium",
      category: "other",
      confidence: 1,
      postable: false,
      explanation: "",
    });
    expect(normalizeFinding(null)).toBeUndefined();
    expect(normalizeFinding({ verification: { verdict: "maybe" } })?.verification).toEqual({ verdict: "failed", reason: "" });
  });
});

describe("normalizeReport", () => {
  it("needs a repository and a PR number", () => {
    expect(() => normalizeReport(null)).toThrow();
    expect(() => normalizeReport({ repo: "a/b" })).toThrow();
  });

  it("fills every list and keeps the first of duplicate findings", () => {
    const report = normalizeReport({
      repo: "a/b",
      number: 3,
      findings: [{ id: "x", title: "one" }, { id: "x", title: "two" }, 5],
      filesSkipped: [{ path: "big.bin" }, { reason: "no path" }],
      filtered: [],
      posted: { findingIds: ["x", 1] },
    });
    expect(report.findings.map((f) => f.title)).toEqual(["one"]);
    expect(report).toMatchObject({ headSha: "", notes: [], filesReviewed: [], filtered: undefined, postedEarlier: undefined });
    expect(report.filesSkipped).toEqual([{ path: "big.bin", reason: "skipped" }]);
    expect(report.posted).toMatchObject({ findingIds: ["x"], postedCount: 0 });
  });
});

describe("normalizePostResult", () => {
  it("rejects null and keeps only string ids", () => {
    expect(() => normalizePostResult(null)).toThrow();
    expect(normalizePostResult({ postedCount: 2, findingIds: ["a", null], reviewUrl: "" })).toEqual({
      reviewUrl: undefined,
      postedCount: 2,
      findingIds: ["a"],
      postedAt: "",
    });
  });
});

describe("events", () => {
  it("drops unreadable run events and fills partial ones", () => {
    expect(normalizeBugCheckEvent(null)).toBeUndefined();
    expect(normalizeBugCheckEvent({ type: "mystery" })).toBeUndefined();
    expect(normalizeBugCheckEvent({ type: "finding", finding: null })).toBeUndefined();
    expect(normalizeBugCheckEvent({ type: "started", runId: "r" })).toMatchObject({
      totalChunks: 0,
      filesReviewed: [],
      filesSkipped: [],
    });
    expect(normalizeBugCheckEvent({ type: "chunkFailed", index: 1 })).toMatchObject({ error: { kind: "internal" } });
  });

  it("drops unreadable watcher events and fills partial ones", () => {
    expect(normalizeWatcherEvent(undefined)).toBeUndefined();
    expect(normalizeWatcherEvent({ type: "progress", event: null })).toBeUndefined();
    expect(normalizeWatcherEvent({ type: "polled", repo: "a/b" })).toEqual({ type: "polled", repo: "a/b", openPrs: 0, queued: [] });
    expect(normalizeWatcherEvent({ type: "reviewFailed", number: 2, error: null })).toMatchObject({
      error: { message: "Unknown error" },
    });
  });
});
