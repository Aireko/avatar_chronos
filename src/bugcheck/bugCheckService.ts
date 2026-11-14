// The single frontend entry point for PR Bug Check.
//
// Every call goes through a Tauri command in src-tauri/src/review/commands.rs.
// GitHub is reached only through the `gh` CLI in Rust, and PR code is analysed
// only by the local AI service (Ollama + Qwen 3.5) in Rust. The webview never
// talks to GitHub or Ollama directly: do not add `fetch()` calls for either.
//
// Every method rejects with a `BugCheckError` (see ./types.ts). Use
// `isBugCheckError()` and `bugCheckErrorMessage()` to inspect or display it.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BugCheckError,
  BugCheckErrorKind,
  BugCheckEvent,
  BugCheckOptions,
  BugCheckReport,
  GhStatus,
  PostResult,
  PrWithStatus,
  WatchConfig,
  WatcherEvent,
  WatchState,
} from "./types";
import {
  normalizeBugCheckEvent,
  normalizeGhStatus,
  normalizePostResult,
  normalizePrList,
  normalizeReport,
  normalizeWatcherEvent,
  normalizeWatchState,
} from "./normalize";

export type * from "./types";

/** The app-wide Tauri event the auto-review watcher emits. */
export const WATCHER_EVENT = "pr-bug-check://event";

/** Same rule as Rust: `owner/name`, each part starting with a letter or digit. */
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Highest PR number Rust accepts. */
export const MAX_PR_NUMBER = 10_000_000;

/** Callbacks and cancellation for `run`. */
export interface RunOptions {
  /** Engine options; Rust fills in defaults for missing fields. */
  options?: BugCheckOptions;
  /** Receives every progress event: started, chunkStarted, verifying, finding, findingFiltered, chunkDone, chunkFailed, done, cancelled, error. */
  onEvent?: (event: BugCheckEvent) => void;
  /**
   * Aborting it cancels the run (the promise then rejects with kind
   * "cancelled"). The run id is only known once the `started` event arrives;
   * an abort before that is remembered and sent as soon as it is known.
   */
  signal?: AbortSignal;
}

export interface BugCheckService {
  /** Is the gh CLI installed and logged in. Never rejects for "missing" or "logged out": see `error`. */
  ghStatus(): Promise<GhStatus>;
  /** Open PRs of `repo` (up to 50), each with a summary of its last stored check. */
  listPrs(repo: string): Promise<PrWithStatus[]>;
  /** Checks one PR (open, closed or merged) with the local model. Resolves to the stored report. */
  run(repo: string, number: number, options?: RunOptions): Promise<BugCheckReport>;
  /** Cancels a run by id. Resolves to whether it was running. */
  cancel(runId: string): Promise<boolean>;
  /** The last stored report of a PR, if any. */
  getReport(repo: string, number: number): Promise<BugCheckReport | null>;
  /**
   * Posts the given findings of the stored report as one review with inline
   * comments. Only call this after the user explicitly confirmed. Rejects
   * with `stale_report` when the PR changed since the check.
   */
  post(repo: string, number: number, findingIds: string[]): Promise<PostResult>;
  /** Current auto-review state. */
  watchGet(): Promise<WatchState>;
  /** Starts (or reconfigures) auto review. Persisted: it resumes on the next app start. */
  watchStart(config: WatchConfig): Promise<WatchState>;
  /** Stops auto review. */
  watchStop(): Promise<WatchState>;
  /**
   * Subscribes to watcher events. Returns an unlisten function that is safe
   * to call at any time (also before the subscription is established).
   * Outside the desktop app it does nothing.
   */
  onWatcherEvent(handler: (event: WatcherEvent) => void): () => void;
}

const ERROR_KINDS: ReadonlySet<string> = new Set<BugCheckErrorKind>([
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
]);

/** True when `error` has the shape of a `BugCheckError`. */
export function isBugCheckError(error: unknown): error is BugCheckError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as BugCheckError).kind === "string" &&
    ERROR_KINDS.has((error as BugCheckError).kind) &&
    typeof (error as BugCheckError).message === "string"
  );
}

/** Normalises any rejection (BugCheckError, Tauri IPC error string, Error) into a BugCheckError. */
export function toBugCheckError(error: unknown): BugCheckError {
  if (isBugCheckError(error)) return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    const { message, hint } = error as { message: string; hint?: unknown };
    return { kind: "internal", message, hint: typeof hint === "string" ? hint : undefined };
  }
  return { kind: "internal", message: String(error) };
}

/** Turns whatever a call rejected with into one readable line: message plus hint. */
export function bugCheckErrorMessage(error: unknown): string {
  const e = toBugCheckError(error);
  return e.hint ? `${e.message}. ${e.hint}` : e.message;
}

/** Client-side check of an `owner/name` string, matching the Rust validation. */
export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

/** Client-side check of a PR number, matching the Rust validation. */
export function isValidPrNumber(number: number): boolean {
  return Number.isInteger(number) && number >= 1 && number <= MAX_PR_NUMBER;
}

const NOT_IN_APP: BugCheckError = {
  kind: "internal",
  message: "PR Bug Check is only available inside the desktop app",
  hint: "Start the app with 'npm run tauri:dev' instead of opening the Vite page in a browser",
};

const CANCELLED: BugCheckError = { kind: "cancelled", message: "The bug check was cancelled" };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NOT_IN_APP;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toBugCheckError(error);
  }
}

// Every answer and event is normalised (./normalize.ts): a null or partial answer from a
// command that failed half-way rejects with a BugCheckError instead of crashing the panel.
export const bugCheckService: BugCheckService = {
  ghStatus: async () => normalizeGhStatus(await call<GhStatus>("bug_check_gh_status")),

  listPrs: async (repo) => normalizePrList(await call<PrWithStatus[]>("bug_check_list_prs", { repo })),

  // `async` so a synchronous failure (the Channel constructor outside Tauri)
  // becomes a rejected promise, never a thrown exception.
  async run(repo, number, { options, onEvent, signal } = {}) {
    if (!isTauri()) throw NOT_IN_APP;
    if (signal?.aborted) throw CANCELLED;

    let runId: string | undefined;
    let cancelSent = false;
    const sendCancel = () => {
      if (cancelSent || !runId) return;
      cancelSent = true;
      void call<boolean>("bug_check_cancel", { runId }).catch(() => {});
    };
    // Before `started` arrives there is no run id yet: the abort is remembered
    // through `signal.aborted` and sent from the event handler below.
    const onAbort = () => sendCancel();
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<BugCheckEvent>();
    channel.onmessage = (raw) => {
      const event = normalizeBugCheckEvent(raw);
      if (!event) return;
      if (event.type === "started") {
        runId = event.runId || undefined;
        if (signal?.aborted) sendCancel();
      }
      onEvent?.(event);
    };

    try {
      const report = await call<BugCheckReport>("bug_check_run", {
        repo,
        number,
        options: options ?? null,
        onEvent: channel,
      });
      // An aborted call never resolves as a success, even if it finished first.
      if (signal?.aborted) throw CANCELLED;
      return normalizeReport(report);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  },

  cancel: (runId) => call<boolean>("bug_check_cancel", { runId }),

  getReport: async (repo, number) => {
    const report = await call<BugCheckReport | null>("bug_check_get_report", { repo, number });
    return report == null ? null : normalizeReport(report);
  },

  post: async (repo, number, findingIds) =>
    normalizePostResult(await call<PostResult>("bug_check_post", { repo, number, findingIds })),

  watchGet: async () => normalizeWatchState(await call<WatchState>("bug_check_watch_get")),

  watchStart: async (config) => normalizeWatchState(await call<WatchState>("bug_check_watch_start", { config })),

  watchStop: async () => normalizeWatchState(await call<WatchState>("bug_check_watch_stop")),

  onWatcherEvent(handler) {
    if (!isTauri()) return () => {};
    let stopped = false;
    let unlisten: (() => void) | undefined;
    listen<WatcherEvent>(WATCHER_EVENT, (event) => {
      if (stopped) return;
      const payload = normalizeWatcherEvent(event.payload);
      if (payload) handler(payload);
    }).then(
      (fn) => {
        if (stopped) fn();
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      stopped = true;
      unlisten?.();
      unlisten = undefined;
    };
  },
};
