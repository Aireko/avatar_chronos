// TypeScript mirrors of the JSON shapes exchanged with the Rust PR Bug Check
// module in src-tauri/src/review/. Field names are camelCase because the Rust
// types use `#[serde(rename_all = "camelCase")]`. Optional (`?`) fields are
// omitted by Rust when they are `None`.
//
// Keep this file in sync with src-tauri/src/review/ when a shape changes.
import type { AiErrorKind } from "../ai/types";

/** Mirrors `review::error::BugCheckErrorKind` (serialized as snake_case strings). */
export type BugCheckErrorKind =
  | "gh_not_installed"
  | "gh_not_authenticated"
  | "not_found"
  | "github_failed"
  | "invalid_request"
  | "busy"
  | "cancelled"
  | "stale_report"
  | "ai_failed"
  | "internal";

/**
 * Mirrors `review::error::BugCheckError`: what every `bug_check_*` command rejects
 * with. Errors from the local AI service arrive with kind `ai_failed`; their
 * message and hint (for example "Start Ollama ...") are kept and the original
 * AI kind is in `aiKind`. An AI `cancelled` arrives as plain `cancelled`.
 */
export interface BugCheckError {
  kind: BugCheckErrorKind;
  /** Human-readable description. Never contains PR code or model output. */
  message: string;
  /** Actionable next step for the user, when there is one. */
  hint?: string;
  /** For `ai_failed`: the original `AiErrorKind` (`ollama_unreachable`, `model_not_installed`, ...). */
  aiKind?: AiErrorKind;
}

/** Mirrors `review::types::GhStatus`. */
export interface GhStatus {
  /** `gh --version` succeeded. */
  installed: boolean;
  /** `gh auth status` succeeded. */
  authenticated: boolean;
  /** The GitHub login gh is signed in as. */
  user?: string;
  error?: BugCheckError;
}

/**
 * Mirrors `review::types::PullRequestSummary` (from `gh pr list/view --json ...`).
 * Field names follow gh, except `author`, which is the login only.
 */
export interface PullRequestSummary {
  number: number;
  title: string;
  /** The author's GitHub login. */
  author: string;
  /** Head commit SHA (`headRefOid`). */
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  /** RFC 3339 timestamp. */
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  state: string;
}

/** Mirrors `review::types::PrFile`: a changed file of a PR. Not sent to the frontend today. */
export interface PrFile {
  path: string;
  /** `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`. */
  status: string;
  /** The unified diff. Absent for binary or very large files. */
  patch?: string;
  additions: number;
  deletions: number;
  /** The old path of a renamed or copied file. */
  previousPath?: string;
}

/** Mirrors `review::types::LastReportInfo`: the stored report of a PR, in brief. */
export interface LastReportInfo {
  runId: string;
  /** The head commit the report was made for. */
  headSha: string;
  findingCount: number;
  /** RFC 3339 UTC timestamp. */
  startedAt: string;
  /** `headSha` equals the PR's current head commit. */
  upToDate: boolean;
  /** Comments from this report were posted to GitHub. */
  posted: boolean;
}

/** Mirrors `review::types::PrWithStatus` (flattened): a PR plus its last check. */
export interface PrWithStatus extends PullRequestSummary {
  lastReport?: LastReportInfo;
}

/** Mirrors `review::types::BugCheckOptions`. Every field has a Rust-side default. */
export interface BugCheckOptions {
  /** Let Qwen 3.5 reason before answering. Slower; default false. */
  think?: boolean;
  /**
   * Context window in tokens, 4096..=262144; default 16384. It must fit the
   * prompt, a diff part of at least 4096 bytes and the answer, so in practice
   * at least 8192 (rejected with `invalid_request` otherwise).
   */
  numCtx?: number;
  /** Findings below this confidence (0..=1) are dropped; default 0.5. */
  minConfidence?: number;
  /**
   * Max annotated diff bytes per model call, 4096..=196608; default 24576.
   * Lowered to what fits `numCtx` next to the prompt and the answer budget.
   */
  chunkBytes?: number;
  /**
   * Double-check every finding with a second, skeptical model call and drop
   * the ones it refutes or cannot confirm. Default true; costs one extra model
   * call per finding.
   */
  verify?: boolean;
}

/** Mirrors `review::types::Verdict`. */
export type Verdict = "confirmed" | "refuted" | "uncertain" | "failed";

/** Mirrors `review::types::Verification`: the double-check's verdict on a finding. */
export interface Verification {
  /**
   * `confirmed`: the model named a concrete input that triggers the bug.
   * `refuted` / `uncertain`: filtered out (see `BugCheckReport.filtered`).
   * `failed`: the double-check itself failed, so the finding was kept unchecked.
   */
  verdict: Verdict;
  /** One or two sentences (at most 600 characters), or why the check failed. */
  reason: string;
}

export type Severity = "critical" | "high" | "medium" | "low";

export type FindingCategory =
  | "logic_bug"
  | "state_leak"
  | "unit_mismatch"
  | "security"
  | "concurrency"
  | "error_handling"
  | "performance"
  | "other";

/** Mirrors `review::types::Finding`. Line numbers are on the new (RIGHT) side of the diff. */
export interface Finding {
  /** Stable id (hash of path, line and title). */
  id: string;
  path: string;
  line: number;
  /** First line of a multi-line range (`startLine < line`, same hunk). */
  startLine?: number;
  severity: Severity;
  category: FindingCategory;
  /** At most 120 characters. */
  title: string;
  /** At most 4000 characters. */
  explanation: string;
  /** Replacement for new-side lines `startLine..=line` (or just `line`). */
  suggestedFix?: string;
  /** 0..1 */
  confidence: number;
  /** The line is a commentable line of the diff, so it can be posted inline. */
  postable: boolean;
  /**
   * The line the model cited, when it was moved to the nearest commentable
   * line. A snapped finding's fix is posted as a plain code block, never as a
   * one-click GitHub suggestion.
   */
  snappedFrom?: number;
  /**
   * The model gave an invalid multi-line `startLine` that was dropped; the fix
   * was written for that range, so it is posted as a plain code block, never as
   * a one-click suggestion. Absent when false.
   */
  rangeRejected?: boolean;
  /** The double-check's verdict. Absent when the run had it off (or for older reports). */
  verification?: Verification;
}

/** Mirrors `review::types::SkippedFile`. */
export interface SkippedFile {
  path: string;
  reason: string;
}

/** Mirrors `review::types::PostResult`. */
export interface PostResult {
  /** Link to the review on GitHub, when GitHub returned one. */
  reviewUrl?: string;
  /** Inline comments posted by this call (use `findingIds.length` for the total). */
  postedCount: number;
  /** Every finding id posted for this report so far (this call and earlier ones). */
  findingIds: string[];
  /** When the review was posted (RFC 3339, UTC). */
  postedAt: string;
}

/** Mirrors `review::types::BugCheckReport`. */
export interface BugCheckReport {
  runId: string;
  /** `owner/name` */
  repo: string;
  number: number;
  title: string;
  /** The PR head commit that was checked. */
  headSha: string;
  model: string;
  /** RFC 3339 UTC timestamp. */
  startedAt: string;
  durationMs: number;
  filesReviewed: string[];
  filesSkipped: SkippedFile[];
  findings: Finding[];
  /** Non-fatal problems, e.g. a chunk whose model output could not be parsed. */
  notes: string[];
  /** Present once comments from this report were posted (kept by a re-run on the same head commit). */
  posted?: PostResult;
  /**
   * Line-independent keys (path + normalized title) of every finding posted on
   * this PR so far, across checks and commits. Absent when empty.
   */
  postedKeys?: string[];
  /**
   * Ids of findings in this report that were already posted for an earlier
   * check of the PR (same path and title). They are not posted again. Absent when empty.
   */
  postedEarlier?: string[];
  /**
   * Findings the double-check refuted or could not confirm, each with its
   * `verification` reason. Shown for transparency; never posted. Absent when empty.
   */
  filtered?: Finding[];
}

/** Mirrors `review::types::BugCheckEvent` (internally tagged by `type`). Chunk indexes start at 0. */
export type BugCheckEvent =
  | {
      type: "started";
      runId: string;
      repo: string;
      number: number;
      headSha: string;
      totalChunks: number;
      filesReviewed: string[];
      filesSkipped: SkippedFile[];
    }
  | { type: "chunkStarted"; index: number; files: string[] }
  | { type: "finding"; finding: Finding }
  /** The double-check of finding `current` of `total` (1-based) in chunk `index` started. */
  | { type: "verifying"; index: number; current: number; total: number; findingId: string }
  /** The double-check refuted the finding or could not confirm it. */
  | { type: "findingFiltered"; finding: Finding }
  | { type: "chunkDone"; index: number; findingCount: number }
  | { type: "chunkFailed"; index: number; error: BugCheckError }
  | { type: "done"; report: BugCheckReport }
  | { type: "cancelled" }
  | { type: "error"; error: BugCheckError };

/** Mirrors `review::types::WatchConfig`. */
export interface WatchConfig {
  /** `owner/name` */
  repo: string;
  /** 1..=120, default 5. */
  intervalMinutes: number;
  /** Post postable findings without review. Default false. */
  autoPost: boolean;
  /** Also review draft PRs. Default false. */
  includeDrafts: boolean;
  minConfidence?: number;
  numCtx?: number;
}

/** Mirrors `review::types::WatchState`. */
export interface WatchState {
  /** The last config used (kept after stopping). */
  config?: WatchConfig;
  enabled: boolean;
  /** RFC 3339 UTC timestamp of the last successful or failed poll. */
  lastPollAt?: string;
  lastError?: BugCheckError;
  /** PR numbers waiting for review, in order. */
  queue: number[];
  /** The PR being reviewed right now. */
  current?: number;
}

/**
 * Mirrors `review::types::WatcherEvent`, emitted app-wide as the Tauri event
 * `pr-bug-check://event` (internally tagged by `type`).
 */
export type WatcherEvent =
  | { type: "polled"; repo: string; openPrs: number; queued: number[] }
  | { type: "reviewStarted"; repo: string; number: number; runId: string }
  | { type: "progress"; repo: string; number: number; event: BugCheckEvent }
  /** The review finished and its report is stored. */
  | { type: "reviewDone"; repo: string; number: number; findingCount: number; posted: boolean }
  /** The review failed or was cancelled (not by stopping auto mode); retried on the next poll. */
  | { type: "reviewFailed"; repo: string; number: number; error: BugCheckError }
  | { type: "stopped" }
  | { type: "error"; error: BugCheckError };
