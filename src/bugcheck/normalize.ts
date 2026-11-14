// Turns what the Rust PR Bug Check commands and events answered into the shapes
// in ./types.ts. A command that fails half-way can answer with null or a partial
// object (a null watch state once crashed the panel); here such answers become a
// BugCheckError (shown in the panel's error box) or safe defaults, never a throw
// while rendering. Events that can't be read are dropped (undefined).
import { bool, isRecord, list, num, numbers, oneOf, optNum, optStr, str, strings } from "../ai/coerce";
import type { AiErrorKind } from "../ai/types";
import type {
  BugCheckError,
  BugCheckErrorKind,
  BugCheckEvent,
  BugCheckReport,
  Finding,
  FindingCategory,
  GhStatus,
  LastReportInfo,
  PostResult,
  PrWithStatus,
  Severity,
  SkippedFile,
  Verdict,
  Verification,
  WatchConfig,
  WatcherEvent,
  WatchState,
} from "./types";

const ERROR_KINDS: readonly BugCheckErrorKind[] = [
  "gh_not_installed",
  "gh_not_authenticated",
  "not_found",
  "github_failed",
  "invalid_request",
  "busy",
  "cancelled",
  "stale_report",
  "ai_failed",
  "internal",
];
const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
const CATEGORIES: readonly FindingCategory[] = [
  "logic_bug",
  "state_leak",
  "unit_mismatch",
  "security",
  "concurrency",
  "error_handling",
  "performance",
  "other",
];
const VERDICTS: readonly Verdict[] = ["confirmed", "refuted", "uncertain", "failed"];

/** The error for an answer that does not have the expected shape. */
export function malformed(what: string): BugCheckError {
  return {
    kind: "internal",
    message: `The app returned an unexpected answer for ${what}`,
    hint: "Try again; if it keeps happening, restart the app",
  };
}

/** A BugCheckError nested in an answer: undefined when absent, a generic error when unreadable. */
export function normalizeError(value: unknown): BugCheckError | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return { kind: "internal", message: typeof value === "string" ? value : "Unknown error" };
  return {
    kind: oneOf(value.kind, ERROR_KINDS, "internal"),
    message: str(value.message, "Unknown error"),
    hint: optStr(value.hint),
    aiKind: optStr(value.aiKind) as AiErrorKind | undefined,
  };
}

/** Like normalizeError, for places where an error must be there. */
function requiredError(value: unknown): BugCheckError {
  return normalizeError(value) ?? { kind: "internal", message: "Unknown error" };
}

export function normalizeGhStatus(value: unknown): GhStatus {
  if (!isRecord(value)) throw malformed("the GitHub CLI status");
  return {
    installed: bool(value.installed),
    authenticated: bool(value.authenticated),
    user: optStr(value.user) || undefined,
    error: normalizeError(value.error),
  };
}

function normalizeLastReport(value: unknown): LastReportInfo | undefined {
  if (!isRecord(value)) return undefined;
  return {
    runId: str(value.runId),
    headSha: str(value.headSha),
    findingCount: Math.max(0, num(value.findingCount)),
    startedAt: str(value.startedAt),
    upToDate: bool(value.upToDate),
    posted: bool(value.posted),
  };
}

/** gh's author is a login string; an `{ login }` object is accepted too. */
function authorOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return str(value.login, "unknown");
  return "unknown";
}

function normalizePr(value: unknown): PrWithStatus | undefined {
  if (!isRecord(value)) return undefined;
  const number = optNum(value.number);
  if (number === undefined || !Number.isInteger(number) || number < 1) return undefined;
  return {
    number,
    title: str(value.title, "(no title)"),
    author: authorOf(value.author),
    headRefOid: str(value.headRefOid),
    headRefName: str(value.headRefName, "?"),
    baseRefName: str(value.baseRefName, "?"),
    isDraft: bool(value.isDraft),
    updatedAt: str(value.updatedAt),
    url: str(value.url),
    additions: Math.max(0, num(value.additions)),
    deletions: Math.max(0, num(value.deletions)),
    changedFiles: Math.max(0, num(value.changedFiles)),
    state: str(value.state),
    lastReport: normalizeLastReport(value.lastReport),
  };
}

/** The open PR list; entries without a usable PR number are dropped (and duplicates, which would share a key). */
export function normalizePrList(value: unknown): PrWithStatus[] {
  if (!Array.isArray(value)) throw malformed("the pull request list");
  const seen = new Set<number>();
  return list(value, normalizePr).filter((pr) => !seen.has(pr.number) && seen.add(pr.number));
}

function normalizeVerification(value: unknown): Verification | undefined {
  if (!isRecord(value)) return undefined;
  return { verdict: oneOf(value.verdict, VERDICTS, "failed"), reason: str(value.reason) };
}

export function normalizeFinding(value: unknown): Finding | undefined {
  if (!isRecord(value)) return undefined;
  const path = str(value.path, "(unknown file)");
  const line = Math.max(0, Math.round(num(value.line)));
  const title = str(value.title, "(untitled finding)");
  const startLine = optNum(value.startLine);
  return {
    // Ids key the list and the selection: derive a stable one if it is missing.
    id: str(value.id) || `${path}:${line}:${title}`,
    path,
    line,
    startLine: startLine !== undefined ? Math.round(startLine) : undefined,
    severity: oneOf(value.severity, SEVERITIES, "medium"),
    category: oneOf(value.category, CATEGORIES, "other"),
    title,
    explanation: str(value.explanation),
    suggestedFix: optStr(value.suggestedFix),
    confidence: Math.min(1, Math.max(0, num(value.confidence))),
    postable: bool(value.postable),
    snappedFrom: optNum(value.snappedFrom),
    rangeRejected: value.rangeRejected === true ? true : undefined,
    verification: normalizeVerification(value.verification),
  };
}

/** Findings with duplicate ids keep only the first (ids key the cards and the selection). */
function findings(value: unknown): Finding[] {
  const seen = new Set<string>();
  return list(value, normalizeFinding).filter((f) => !seen.has(f.id) && seen.add(f.id));
}

function normalizeSkipped(value: unknown): SkippedFile | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return undefined;
  return { path: value.path, reason: str(value.reason, "skipped") };
}

function normalizePostResultLoose(value: unknown): PostResult | undefined {
  if (!isRecord(value)) return undefined;
  return {
    reviewUrl: optStr(value.reviewUrl) || undefined,
    postedCount: Math.max(0, num(value.postedCount)),
    findingIds: strings(value.findingIds),
    postedAt: str(value.postedAt),
  };
}

export function normalizePostResult(value: unknown): PostResult {
  const result = normalizePostResultLoose(value);
  if (!result) throw malformed("posting the review");
  return result;
}

/** Empty optional lists stay absent, as Rust sends them. */
function optList<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

/** A stored or fresh report. It must name its repository and PR; the rest falls back to empty. */
export function normalizeReport(value: unknown): BugCheckReport {
  if (!isRecord(value)) throw malformed("the bug check report");
  const number = optNum(value.number);
  if (typeof value.repo !== "string" || number === undefined) throw malformed("the bug check report");
  return {
    runId: str(value.runId),
    repo: value.repo,
    number,
    title: str(value.title, "(no title)"),
    headSha: str(value.headSha),
    model: str(value.model, "unknown model"),
    startedAt: str(value.startedAt),
    durationMs: Math.max(0, num(value.durationMs)),
    filesReviewed: strings(value.filesReviewed),
    filesSkipped: list(value.filesSkipped, normalizeSkipped),
    findings: findings(value.findings),
    notes: strings(value.notes),
    posted: normalizePostResultLoose(value.posted),
    postedKeys: optList(strings(value.postedKeys)),
    postedEarlier: optList(strings(value.postedEarlier)),
    filtered: optList(findings(value.filtered)),
  };
}

function normalizeWatchConfig(value: unknown): WatchConfig | undefined {
  if (!isRecord(value) || typeof value.repo !== "string") return undefined;
  return {
    repo: value.repo,
    intervalMinutes: Math.min(120, Math.max(1, Math.round(num(value.intervalMinutes, 5)))),
    autoPost: bool(value.autoPost),
    includeDrafts: bool(value.includeDrafts),
    minConfidence: optNum(value.minConfidence),
    numCtx: optNum(value.numCtx),
  };
}

export function normalizeWatchState(value: unknown): WatchState {
  if (!isRecord(value)) throw malformed("the auto review state");
  return {
    config: normalizeWatchConfig(value.config),
    enabled: bool(value.enabled),
    lastPollAt: optStr(value.lastPollAt),
    lastError: normalizeError(value.lastError),
    queue: numbers(value.queue),
    current: optNum(value.current),
  };
}

/** One progress event of a run, or undefined when it can't be read. */
export function normalizeBugCheckEvent(value: unknown): BugCheckEvent | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "started":
      return {
        type: "started",
        runId: str(value.runId),
        repo: str(value.repo),
        number: num(value.number),
        headSha: str(value.headSha),
        totalChunks: Math.max(0, num(value.totalChunks)),
        filesReviewed: strings(value.filesReviewed),
        filesSkipped: list(value.filesSkipped, normalizeSkipped),
      };
    case "chunkStarted":
      return { type: "chunkStarted", index: num(value.index), files: strings(value.files) };
    case "verifying":
      return {
        type: "verifying",
        index: num(value.index),
        current: num(value.current),
        total: num(value.total),
        findingId: str(value.findingId),
      };
    case "finding":
    case "findingFiltered": {
      const finding = normalizeFinding(value.finding);
      return finding ? { type: value.type, finding } : undefined;
    }
    case "chunkDone":
      return { type: "chunkDone", index: num(value.index), findingCount: num(value.findingCount) };
    case "chunkFailed":
      return { type: "chunkFailed", index: num(value.index), error: requiredError(value.error) };
    case "done":
      try {
        return { type: "done", report: normalizeReport(value.report) };
      } catch {
        return undefined;
      }
    case "cancelled":
      return { type: "cancelled" };
    case "error":
      return { type: "error", error: requiredError(value.error) };
    default:
      return undefined;
  }
}

/** One auto-review event, or undefined when it can't be read. */
export function normalizeWatcherEvent(value: unknown): WatcherEvent | undefined {
  if (!isRecord(value)) return undefined;
  const repo = str(value.repo);
  const number = num(value.number);
  switch (value.type) {
    case "polled":
      return { type: "polled", repo, openPrs: Math.max(0, num(value.openPrs)), queued: numbers(value.queued) };
    case "reviewStarted":
      return { type: "reviewStarted", repo, number, runId: str(value.runId) };
    case "progress": {
      const event = normalizeBugCheckEvent(value.event);
      return event ? { type: "progress", repo, number, event } : undefined;
    }
    case "reviewDone":
      return {
        type: "reviewDone",
        repo,
        number,
        findingCount: Math.max(0, num(value.findingCount)),
        posted: bool(value.posted),
      };
    case "reviewFailed":
      return { type: "reviewFailed", repo, number, error: requiredError(value.error) };
    case "stopped":
      return { type: "stopped" };
    case "error":
      return { type: "error", error: requiredError(value.error) };
    default:
      return undefined;
  }
}
