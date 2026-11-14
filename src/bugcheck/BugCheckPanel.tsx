// PR Bug Check panel: lists open PRs of a GitHub repository, checks one with
// the local Qwen 3.5 model, shows the findings and, after an explicit
// confirmation, posts the selected ones as inline review comments. It also
// controls the auto-review watcher.
//
// Everything goes through ./bugCheckService.ts; see docs/pr-bug-check.md.
import {
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { runShellCommand } from "../backend";
import { useBusySignal, usePaneReturn } from "../ai/panelHooks";
import { bugCheckService, isValidPrNumber, isValidRepo, toBugCheckError } from "./bugCheckService";
import { type ChunkOutcome, chunkTicks, ticksLabel } from "./chunkTicks";
import { githubRepoFromRemote } from "./originRepo";
import type {
  BugCheckError,
  BugCheckEvent,
  BugCheckOptions,
  BugCheckReport,
  Finding,
  FindingCategory,
  GhStatus,
  PostResult,
  PrWithStatus,
  Severity,
  WatchConfig,
  WatcherEvent,
  WatchState,
} from "./types";
import "./BugCheckPanel.css";

/** The repository the user last typed in; used when the open repository has no GitHub origin. */
const REPO_KEY = "prBugCheck.repo";
const MAX_COMMENTS_PER_REVIEW = 50;
const MAX_ACTIVITY = 8;

const CATEGORY_LABELS: Record<FindingCategory, string> = {
  logic_bug: "Logic bug",
  state_leak: "State leak",
  unit_mismatch: "Unit mismatch",
  security: "Security",
  concurrency: "Concurrency",
  error_handling: "Error handling",
  performance: "Performance",
  other: "Other",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

/** Items of a list that ease in one after another; past this many they all share the last delay. */
const MAX_STAGGER = 6;

/** The --i custom property the CSS uses to stagger a list item's entrance. */
function stagger(index: number): CSSProperties {
  return { "--i": Math.min(index, MAX_STAGGER) } as CSSProperties;
}

/** The saved repository, or "" (never some unrelated default: the user types one in). */
function loadRepo(): string {
  try {
    const saved = localStorage.getItem(REPO_KEY);
    return saved && isValidRepo(saved) ? saved : "";
  } catch {
    return "";
  }
}

function saveRepo(repo: string) {
  try {
    localStorage.setItem(REPO_KEY, repo);
  } catch {
    // Storage unavailable: the repo is simply not remembered.
  }
}

function formatTime(iso?: string): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function lineLabel(finding: Finding): string {
  return finding.startLine !== undefined && finding.startLine !== finding.line
    ? `lines ${finding.startLine}-${finding.line}`
    : `line ${finding.line}`;
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** GitHub repository names are case-insensitive. */
function sameRepo(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

function clampInterval(minutes: number): number {
  return Math.min(120, Math.max(1, Math.round(minutes) || 5));
}

/** Ids of findings of `report` that were already posted (by this check, or for an earlier one). */
function postedIdsOf(report: BugCheckReport | undefined): Set<string> {
  return new Set([...(report?.posted?.findingIds ?? []), ...(report?.postedEarlier ?? [])]);
}

/** Opens a GitHub link in the system browser (inside the app) or a new tab (in a browser). */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  // No address (a partial answer): plain text rather than a link to nowhere.
  if (!/^https?:\/\//i.test(href)) return <>{children}</>;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return;
    event.preventDefault();
    void openUrl(href).catch(() => {});
  };
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" onClick={onClick}>
      {children}
    </a>
  );
}

function ErrorBox({ error, extra }: { error: BugCheckError; extra?: string }) {
  return (
    <div className="bc-error" role="alert">
      <strong>{error.message}</strong>
      <span className="bc-muted">
        {" "}
        ({error.kind}
        {error.aiKind ? `: ${error.aiKind}` : ""})
      </span>
      {error.hint && <div className="bc-hint">{error.hint}</div>}
      {extra && <div className="bc-hint">{extra}</div>}
    </div>
  );
}

/** Live state of the active manual run, built from engine events. */
interface RunProgress {
  repo: string;
  number: number;
  runId?: string;
  totalChunks?: number;
  /** Index (0-based) of the chunk being reviewed. */
  chunk?: number;
  chunkFiles: string[];
  chunksDone: number;
  chunksFailed: number;
  /** How each finished chunk ended, by index: one tick each on the progress track. */
  settled: Record<number, ChunkOutcome>;
  findings: number;
  /** Findings the double-check filtered out so far. */
  filtered: number;
  /** The double-check in progress: finding `current` of `total` in the current chunk. */
  verifying?: { current: number; total: number };
  filesReviewed: number;
  filesSkipped: number;
  cancelling: boolean;
}

function freshProgress(repo: string, number: number): RunProgress {
  return {
    repo,
    number,
    chunkFiles: [],
    chunksDone: 0,
    chunksFailed: 0,
    settled: {},
    findings: 0,
    filtered: 0,
    filesReviewed: 0,
    filesSkipped: 0,
    cancelling: false,
  };
}

function applyEvent(progress: RunProgress, event: BugCheckEvent): RunProgress {
  switch (event.type) {
    case "started":
      return {
        ...progress,
        runId: event.runId,
        totalChunks: event.totalChunks,
        filesReviewed: event.filesReviewed.length,
        filesSkipped: event.filesSkipped.length,
      };
    case "chunkStarted":
      return { ...progress, chunk: event.index, chunkFiles: event.files, verifying: undefined };
    case "verifying":
      return { ...progress, verifying: { current: event.current, total: event.total } };
    case "finding":
      return { ...progress, findings: progress.findings + 1 };
    case "findingFiltered":
      return { ...progress, filtered: progress.filtered + 1 };
    case "chunkDone":
      return {
        ...progress,
        chunksDone: progress.chunksDone + 1,
        settled: { ...progress.settled, [event.index]: "done" },
        verifying: undefined,
      };
    case "chunkFailed":
      return {
        ...progress,
        chunksDone: progress.chunksDone + 1,
        chunksFailed: progress.chunksFailed + 1,
        settled: { ...progress.settled, [event.index]: "failed" },
        verifying: undefined,
      };
    default:
      return progress;
  }
}

function progressLine(progress: RunProgress): string {
  if (progress.totalChunks === undefined) return "Fetching the PR and its diff from GitHub...";
  if (progress.totalChunks === 0) return "Nothing to review in this diff.";
  const current = progress.chunk !== undefined ? progress.chunk + 1 : 0;
  const step = progress.verifying
    ? ` · double-checking finding ${progress.verifying.current} of ${progress.verifying.total}`
    : "";
  const filtered = progress.filtered > 0 ? `, ${progress.filtered} filtered out` : "";
  return `Chunk ${current} of ${progress.totalChunks}${step} · ${plural(progress.findings, "finding")} so far${filtered}`;
}

/**
 * How far a run got: one tick per diff chunk (done, failed, being reviewed or
 * waiting), or a plain bar while the chunk count is unknown or too large to tick.
 */
function ProgressTrack({ progress }: { progress: RunProgress }) {
  const ticks = chunkTicks(progress.totalChunks, progress.settled, progress.chunk);
  if (!ticks) {
    return (
      <progress
        max={progress.totalChunks || 1}
        value={progress.totalChunks ? progress.chunksDone : undefined}
        aria-label="Bug check progress"
      />
    );
  }
  return (
    <div
      className="bc-ticks"
      role="progressbar"
      aria-label="Bug check progress"
      aria-valuemin={0}
      aria-valuemax={ticks.length}
      aria-valuenow={progress.chunksDone}
      aria-valuetext={ticksLabel(ticks.length, progress.chunksDone, progress.chunksFailed)}
    >
      {ticks.map((state, index) => (
        <span key={index} className={`bc-tick is-${state}`} />
      ))}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Whether `el` is laid out (not inside the drawer's hidden panes or a parked drawer). */
function isShown(el: Element | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

/** Moves focus to `el`, but only while the panel is on screen: a hidden pane never takes focus. */
function focusIfShown(el: HTMLElement | null | undefined, options?: FocusOptions): boolean {
  if (!isShown(el) || (el instanceof HTMLButtonElement && el.disabled)) return false;
  el.focus(options);
  return document.activeElement === el;
}

/**
 * Scrolls the nearest scrolling ancestor (the drawer body) so `el` sits at its
 * top. Unlike scrollIntoView it never nudges the fixed app shell around it: it
 * stops at that first scroll container even when it has nothing to scroll.
 */
function scrollToTop(el: HTMLElement) {
  // In a hidden drawer pane every box measures 0: there is nothing to scroll to.
  if (!isShown(el)) return;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (parent.scrollHeight > parent.clientHeight) {
      const top = parent.scrollTop + el.getBoundingClientRect().top - parent.getBoundingClientRect().top - 8;
      parent.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    return;
  }
}

/** A short label for a finding's double-check verdict, or nothing when it was not double-checked. */
function VerificationNote({ finding }: { finding: Finding }) {
  const verification = finding.verification;
  if (!verification) return null;
  const label =
    verification.verdict === "confirmed"
      ? "double-checked"
      : verification.verdict === "failed"
        ? "not double-checked"
        : verification.verdict;
  return (
    <span className={`bc-verdict bc-verdict-${verification.verdict}`} title={verification.reason}>
      {label}
    </span>
  );
}

function lastCheckLabel(pr: PrWithStatus): { text: string; className: string } {
  const last = pr.lastReport;
  if (!last) return { text: "never checked", className: "bc-muted" };
  const findings = plural(last.findingCount, "finding");
  const posted = last.posted ? ", posted" : "";
  return last.upToDate
    ? { text: `up to date: ${findings}${posted}`, className: "bc-ok" }
    : { text: `outdated (${findings} for an older commit${posted})`, className: "bc-warn" };
}

function describeWatcherEvent(event: WatcherEvent): string | undefined {
  switch (event.type) {
    case "polled":
      return event.queued.length > 0
        ? `Polled ${event.repo}: ${plural(event.openPrs, "open PR")}, queued ${event.queued.map((n) => `#${n}`).join(", ")}`
        : `Polled ${event.repo}: ${plural(event.openPrs, "open PR")}, nothing new`;
    case "reviewStarted":
      return `Reviewing #${event.number}`;
    case "reviewDone":
      return `#${event.number}: ${plural(event.findingCount, "finding")}${event.posted ? ", posted to GitHub" : ""}`;
    case "reviewFailed":
      return `#${event.number} failed: ${event.error.message}`;
    case "stopped":
      return "Auto review stopped";
    case "error":
      return `Error: ${event.error.message}${event.error.hint ? `. ${event.error.hint}` : ""}`;
    default:
      return undefined;
  }
}

interface ActivityEntry {
  id: number;
  at: string;
  text: string;
}

function FindingCard({
  finding,
  order,
  selected,
  posted,
  postedEarlier,
  onToggle,
}: {
  finding: Finding;
  /** Position in the whole report, for the staggered entrance. */
  order: number;
  selected: boolean;
  posted: boolean;
  postedEarlier: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <li className={`bc-finding bc-sev-${finding.severity}`} style={stagger(order)}>
      <div className="bc-finding-head">
        <label className="bc-check">
          <input
            type="checkbox"
            checked={selected && !posted && !postedEarlier}
            disabled={!finding.postable || posted || postedEarlier}
            onChange={() => onToggle(finding.id)}
            aria-label={`Post finding: ${finding.title}`}
          />
        </label>
        <span className={`bc-badge bc-badge-${finding.severity}`}>{SEVERITY_LABELS[finding.severity]}</span>
        <span className="bc-category">{CATEGORY_LABELS[finding.category]}</span>
        <strong className="bc-finding-title">{finding.title}</strong>
      </div>
      <div className="bc-finding-meta bc-muted">
        {lineLabel(finding)}
        {finding.snappedFrom !== undefined && ` (model said line ${finding.snappedFrom})`} · confidence{" "}
        {Math.round(finding.confidence * 100)}%
        <VerificationNote finding={finding} />
        {posted && <span className="bc-posted">posted</span>}
        {!posted && postedEarlier && (
          <span className="bc-posted" title="The same finding (file and title) was posted for an earlier check of this PR">
            posted on an earlier commit
          </span>
        )}
        {!finding.postable && (
          <span className="bc-not-postable" title="The line is not part of the diff, so GitHub cannot take an inline comment there">
            not inline-postable
          </span>
        )}
      </div>
      <p className="bc-explanation">{finding.explanation}</p>
      {finding.verification && finding.verification.verdict !== "failed" && (
        <p className="bc-verification">
          <span className="bc-muted">Double-check: </span>
          {finding.verification.reason}
        </p>
      )}
      {finding.suggestedFix !== undefined && (
        <details className="bc-fix" open>
          <summary>Suggested fix ({lineLabel(finding)})</summary>
          <pre>
            <code>{finding.suggestedFix}</code>
          </pre>
        </details>
      )}
    </li>
  );
}

interface BugCheckPanelProps {
  /** The local repository open in Chronos; its GitHub `origin` is the default repository. */
  repoPath?: string;
  /**
   * Told when long work starts (true) and when the last of it stops (false): loading the
   * PR list, a bug check run here, or an auto-review run. False again on unmount.
   */
  onBusyChange?: (busy: boolean) => void;
}

export default function BugCheckPanel({ repoPath, onBusyChange }: BugCheckPanelProps = {}) {
  const panelRef = useRef<HTMLElement>(null);
  // Focus targets around the report and the posting step (see the effects below).
  const prsHeading = useRef<HTMLHeadingElement>(null);
  const reportOpener = useRef<HTMLElement | null>(null);
  const postKey = useRef<HTMLButtonElement>(null);
  const confirmCancel = useRef<HTMLButtonElement>(null);
  const postDone = useRef<HTMLParagraphElement>(null);
  const [gh, setGh] = useState<GhStatus>();
  const [ghError, setGhError] = useState<BugCheckError>();
  const [checkingGh, setCheckingGh] = useState(false);

  const [repo, setRepo] = useState(loadRepo);
  const [repoDraft, setRepoDraft] = useState(repo);
  const repoRef = useRef(repo);
  repoRef.current = repo;
  // The GitHub repository of the open repository's origin remote, once looked up. Until
  // then (with a repository open) no list is loaded, so an unrelated one never flashes up.
  const [originRepo, setOriginRepo] = useState<string>();
  const [originChecked, setOriginChecked] = useState(!repoPath);

  const [prs, setPrs] = useState<PrWithStatus[]>();
  const [prsError, setPrsError] = useState<BugCheckError>();
  const [loadingPrs, setLoadingPrs] = useState(false);
  // A reload the watcher asked for after a poll: not work anyone waits on, so not "busy".
  const [prsLoadQuiet, setPrsLoadQuiet] = useState(false);
  const prsRequest = useRef(0);

  const [otherPr, setOtherPr] = useState("");

  const [think, setThink] = useState(false);
  const [numCtx, setNumCtx] = useState(16384);
  const [minConfidence, setMinConfidence] = useState(0.5);
  const [verify, setVerify] = useState(true);

  const [progress, setProgress] = useState<RunProgress>();
  const [runError, setRunError] = useState<{ number: number; error: BugCheckError }>();
  const runAbort = useRef<AbortController | null>(null);

  const [report, setReport] = useState<BugCheckReport>();
  const [reportError, setReportError] = useState<BugCheckError>();
  const reportRef = useRef<BugCheckReport | undefined>(undefined);
  reportRef.current = report;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // "View report" brings the report into view; bumped on each successful open.
  const reportBox = useRef<HTMLDivElement>(null);
  const [revealReport, setRevealReport] = useState(0);

  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState<PostResult>();
  const [postError, setPostError] = useState<BugCheckError>();

  const [watch, setWatch] = useState<WatchState>();
  const [watchError, setWatchError] = useState<BugCheckError>();
  const [watchBusy, setWatchBusy] = useState(false);
  const [interval, setIntervalMinutes] = useState(5);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [autoPost, setAutoPost] = useState(false);
  const [watchProgress, setWatchProgress] = useState<RunProgress>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const activityId = useRef(0);

  const options: BugCheckOptions = useMemo(
    () => ({ think, numCtx, minConfidence, verify }),
    [think, numCtx, minConfidence, verify],
  );

  const refreshGh = useCallback(async () => {
    setCheckingGh(true);
    try {
      setGh(await bugCheckService.ghStatus());
      setGhError(undefined);
    } catch (error) {
      setGhError(toBugCheckError(error));
    } finally {
      setCheckingGh(false);
    }
  }, []);

  const loadPrs = useCallback(async (target: string, quiet = false) => {
    const request = ++prsRequest.current;
    setLoadingPrs(true);
    setPrsLoadQuiet(quiet);
    try {
      const list = await bugCheckService.listPrs(target);
      if (request !== prsRequest.current) return;
      setPrs(list);
      setPrsError(undefined);
    } catch (error) {
      if (request !== prsRequest.current) return;
      setPrsError(toBugCheckError(error));
    } finally {
      if (request === prsRequest.current) setLoadingPrs(false);
    }
  }, []);

  const showReport = useCallback((next: BugCheckReport | undefined) => {
    setReport(next);
    // Default: every postable finding that was not posted yet (also not for an earlier commit).
    const posted = postedIdsOf(next);
    setSelected(new Set(next?.findings.filter((f) => f.postable && !posted.has(f.id)).map((f) => f.id) ?? []));
    setConfirming(false);
    setPostResult(undefined);
    setPostError(undefined);
  }, []);

  const refreshWatch = useCallback(async (syncForm: boolean) => {
    try {
      const state = await bugCheckService.watchGet();
      setWatch(state);
      if (syncForm && state.config) {
        setIntervalMinutes(state.config.intervalMinutes);
        setIncludeDrafts(state.config.includeDrafts);
        setAutoPost(state.config.autoPost);
      }
      if (!state.current) setWatchProgress(undefined);
    } catch (error) {
      setWatchError(toBugCheckError(error));
    }
  }, []);

  // Initial load, and stop a running check when the panel goes away.
  useEffect(() => {
    void refreshGh();
    void refreshWatch(true);
    return () => runAbort.current?.abort();
  }, [refreshGh, refreshWatch]);

  // The open repository decides the default: its GitHub origin when it has one, otherwise
  // the repository typed in last (or none). Runs again whenever another repository opens.
  useEffect(() => {
    if (!repoPath) {
      setOriginRepo(undefined);
      setOriginChecked(true);
      return;
    }
    let live = true;
    setOriginChecked(false);
    const use = (next: string, origin: string | undefined) => {
      if (!live) return;
      setOriginRepo(origin);
      setOriginChecked(true);
      setRepoDraft(next);
      if (next !== repoRef.current) {
        // Drop a list still loading for the previous repository (a watcher reload, say):
        // with no repository now ("") nothing newer would supersede it, and its late
        // answer would show another repository's PRs (and keep "Loading..." stuck).
        prsRequest.current++;
        setLoadingPrs(false);
        setPrs(undefined);
        setPrsError(undefined);
        setRepo(next);
      }
    };
    runShellCommand(repoPath, "git remote get-url origin").then(
      (result) => {
        const origin = result.ok ? githubRepoFromRemote(result.stdout) : undefined;
        if (origin && isValidRepo(origin)) use(origin, origin);
        else use(loadRepo(), undefined);
      },
      () => use(loadRepo(), undefined),
    );
    return () => {
      live = false;
    };
  }, [repoPath]);

  useEffect(() => {
    if (originChecked && repo) void loadPrs(repo);
  }, [repo, originChecked, loadPrs]);

  // Watcher events: keep the auto-review state, the PR list and an open report current.
  useEffect(
    () =>
      bugCheckService.onWatcherEvent((event) => {
        if (event.type === "progress") {
          if (event.event.type === "cancelled") {
            setWatchProgress(undefined);
            return;
          }
          setWatchProgress((prev) => {
            // A new run (its `started` event) never continues the counters of an older one.
            const same =
              prev && prev.number === event.number && sameRepo(prev.repo, event.repo) && event.event.type !== "started";
            return applyEvent(same ? prev : freshProgress(event.repo, event.number), event.event);
          });
          return;
        }
        const text = describeWatcherEvent(event);
        if (text) {
          const entry = { id: ++activityId.current, at: new Date().toLocaleTimeString(), text };
          setActivity((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY));
        }
        void refreshWatch(false);
        if (event.type === "reviewDone" || event.type === "reviewFailed" || event.type === "stopped") {
          setWatchProgress(undefined);
        }
        if (event.type === "reviewDone" || event.type === "polled") {
          // After a plain poll the refresh is background upkeep (quiet: no busy dot and no
          // "finished" announcement every few minutes); after a review it ends that run's work.
          if (repoRef.current) void loadPrs(repoRef.current, event.type === "polled");
          const open = reportRef.current;
          // Reload an open report only if the watcher just reviewed that very PR (repo and number).
          if (event.type === "reviewDone" && open && open.number === event.number && sameRepo(open.repo, event.repo)) {
            bugCheckService.getReport(open.repo, open.number).then((r) => r && showReport(r), () => {});
          }
        }
      }),
    [refreshWatch, loadPrs, showReport],
  );

  function onRepoSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = repoDraft.trim();
    if (!isValidRepo(next)) {
      setPrsError({ kind: "invalid_request", message: `'${next}' is not a GitHub repository`, hint: "Use owner/name, as in github.com/owner/name" });
      return;
    }
    saveRepo(next);
    if (next === repo) void loadPrs(next);
    else {
      setPrs(undefined);
      setPrsError(undefined);
      setRepo(next);
    }
  }

  async function runCheck(number: number) {
    if (runAbort.current || !repo) return;
    rememberOpener();
    const target = repo;
    const controller = new AbortController();
    runAbort.current = controller;
    setRunError(undefined);
    setProgress(freshProgress(target, number));
    try {
      const result = await bugCheckService.run(target, number, {
        options,
        signal: controller.signal,
        onEvent: (event) => setProgress((prev) => (prev ? applyEvent(prev, event) : prev)),
      });
      showReport(result);
      setReportError(undefined);
    } catch (error) {
      setRunError({ number, error: toBugCheckError(error) });
    } finally {
      runAbort.current = null;
      setProgress(undefined);
      if (repoRef.current === target) void loadPrs(target);
    }
  }

  function cancelRun() {
    setProgress((prev) => (prev ? { ...prev, cancelling: true } : prev));
    runAbort.current?.abort();
  }

  /** The control that asked for a report, so closing the report can hand focus back to it. */
  function rememberOpener() {
    const active = document.activeElement;
    reportOpener.current = active instanceof HTMLElement && panelRef.current?.contains(active) ? active : null;
  }

  // Closing the report removes the focused Close key: focus goes back to whatever opened
  // the report (its "View report" or "Run bug check" key), else to the PR list heading.
  function closeReport() {
    const opener = reportOpener.current;
    reportOpener.current = null;
    const hadFocus = !!reportBox.current?.contains(document.activeElement);
    showReport(undefined);
    if (hadFocus && !focusIfShown(opener)) focusIfShown(prsHeading.current);
  }

  async function viewReport(number: number) {
    if (!repo) return;
    rememberOpener();
    setReportError(undefined);
    try {
      const stored = await bugCheckService.getReport(repo, number);
      if (stored) {
        showReport(stored);
        setRevealReport((n) => n + 1);
      } else {
        showReport(undefined);
        setReportError({ kind: "not_found", message: `No stored check for ${repo}#${number}`, hint: "Run the bug check first" });
      }
    } catch (error) {
      setReportError(toBugCheckError(error));
    }
  }

  // After "View report": scroll the report to the top of the drawer and move focus to
  // its title, so keyboard users continue from there.
  useEffect(() => {
    const box = reportBox.current;
    if (revealReport === 0 || !box) return;
    focusIfShown(box.querySelector<HTMLElement>(".bc-report-title"), { preventScroll: true });
    scrollToTop(box);
  }, [revealReport]);

  const otherNumber = Number(otherPr);
  const otherValid = otherPr.trim() !== "" && isValidPrNumber(otherNumber);

  function toggleFinding(id: string) {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const postableIds = useMemo(() => report?.findings.filter((f) => f.postable).map((f) => f.id) ?? [], [report]);
  const postedHere = useMemo(() => new Set(report?.posted?.findingIds ?? []), [report]);
  // The backend never posts a finding twice (also not one posted for an earlier
  // commit), so neither does the selection: the count shown is what GitHub gets.
  const postedIds = useMemo(() => postedIdsOf(report), [report]);
  const unpostedIds = postableIds.filter((id) => !postedIds.has(id));
  const selectedIds = unpostedIds.filter((id) => selected.has(id));
  const overLimit = selectedIds.length > MAX_COMMENTS_PER_REVIEW;

  async function post() {
    if (!report) return;
    setPosting(true);
    setPostError(undefined);
    try {
      const result = await bugCheckService.post(report.repo, report.number, selectedIds);
      setPostResult(result);
      setConfirming(false);
      // Posted findings are deselected so a second click cannot duplicate them by accident.
      const done = new Set([...selectedIds, ...result.findingIds]);
      setSelected((prev) => new Set([...prev].filter((id) => !done.has(id))));
      const stored = await bugCheckService.getReport(report.repo, report.number).catch(() => null);
      if (stored) setReport(stored);
      if (repoRef.current === report.repo) void loadPrs(report.repo);
    } catch (error) {
      setPostError(toBugCheckError(error));
      setConfirming(false);
    } finally {
      setPosting(false);
    }
  }

  const grouped = useMemo(() => {
    const byFile = new Map<string, Finding[]>();
    for (const finding of report?.findings ?? []) {
      const list = byFile.get(finding.path) ?? [];
      list.push(finding);
      byFile.set(finding.path, list);
    }
    for (const list of byFile.values()) {
      list.sort((a, b) => a.line - b.line || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    }
    return [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [report]);

  // Display order of each finding across files (for the stagger), and the tally by severity.
  const findingOrder = useMemo(() => {
    const order = new Map<string, number>();
    for (const [, findings] of grouped) for (const f of findings) order.set(f.id, order.size);
    return order;
  }, [grouped]);
  const tally = useMemo(
    () =>
      SEVERITIES.map((severity) => ({
        severity,
        count: report?.findings.filter((f) => f.severity === severity).length ?? 0,
      })).filter((entry) => entry.count > 0),
    [report],
  );

  async function setWatching(enabled: boolean) {
    setWatchBusy(true);
    setWatchError(undefined);
    try {
      if (enabled) {
        const config: WatchConfig = {
          repo,
          intervalMinutes: clampInterval(interval),
          autoPost,
          includeDrafts,
          minConfidence,
          numCtx,
        };
        const state = await bugCheckService.watchStart(config);
        setWatch(state);
        // A restart cancels the review in progress; its progress starts over.
        setWatchProgress(undefined);
        // The form shows what is running (e.g. a clamped interval), so "Settings changed" clears.
        if (state.config) {
          setIntervalMinutes(state.config.intervalMinutes);
          setIncludeDrafts(state.config.includeDrafts);
          setAutoPost(state.config.autoPost);
        }
      } else {
        setWatch(await bugCheckService.watchStop());
        setWatchProgress(undefined);
      }
    } catch (error) {
      setWatchError(toBugCheckError(error));
    } finally {
      setWatchBusy(false);
    }
  }

  // The posting question takes focus on its safe answer (Cancel), since the key that asked
  // it is gone; when it closes, focus returns to the Post key, or to the posted note.
  const wasConfirming = useRef(false);
  useEffect(() => {
    const was = wasConfirming.current;
    wasConfirming.current = confirming;
    if (confirming) {
      focusIfShown(confirmCancel.current);
      return;
    }
    // Only when focus was lost with the question (it sits on the page body now).
    const active = document.activeElement;
    if (!was || (active && active !== document.body)) return;
    if (!focusIfShown(postKey.current)) focusIfShown(postDone.current);
  }, [confirming]);

  const running = progress !== undefined;
  const watchConfig = watch?.config;
  // Auto review is checking a PR (the watcher reports it as current, or progress is arriving).
  const autoReviewing = (!!watch?.enabled && watch.current !== undefined) || watchProgress !== undefined;
  useBusySignal((loadingPrs && !prsLoadQuiet) || running || autoReviewing, onBusyChange);

  // Kept mounted (hidden) in the drawer: coming back neither replays the entrance of every
  // PR row and finding card nor loses the scroll offset of a suggested fix.
  usePaneReturn(panelRef);
  const watchDirty =
    !!watch?.enabled &&
    !!watchConfig &&
    (watchConfig.repo !== repo ||
      watchConfig.intervalMinutes !== interval ||
      watchConfig.includeDrafts !== includeDrafts ||
      watchConfig.autoPost !== autoPost ||
      (watchConfig.numCtx ?? 16384) !== numCtx ||
      (watchConfig.minConfidence ?? 0.5) !== minConfidence);
  // A check of the open report's PR is running (here or in auto review): posting
  // now would race its new report, and the backend refuses it.
  const reportBusy =
    !!report &&
    ((!!progress && progress.number === report.number && sameRepo(progress.repo, report.repo)) ||
      (!!watch?.enabled && watch.current === report.number && sameRepo(watchConfig?.repo, report.repo)));

  return (
    <section ref={panelRef} className="bc-panel" aria-labelledby="bc-panel-title">
      {/* The drawer band already shows the title; this one names the section for assistive tech. */}
      <h2 id="bc-panel-title" className="bc-sr">
        PR Bug Check
      </h2>
      <p className="bc-privacy">
        Runs locally: code from the PR is analysed by Qwen 3.5 on this machine; only the comments you post go to GitHub.
      </p>

      <div className="bc-block">
        <div className="bc-row">
          <span>
            GitHub CLI:{" "}
            {gh === undefined && !ghError && (
              <span className="bc-muted bc-checking">
                <span className="working-dot" aria-hidden="true" />
                checking...
              </span>
            )}
            {gh?.authenticated && (
              <span className="bc-ok">signed in{gh.user ? ` as @${gh.user}` : ""}</span>
            )}
            {gh && !gh.installed && <span className="bc-bad">not installed</span>}
            {gh && gh.installed && !gh.authenticated && <span className="bc-bad">not signed in</span>}
          </span>
          <button type="button" className="btn bc-btn-sm" onClick={() => void refreshGh()} disabled={checkingGh}>
            {checkingGh ? "Checking..." : "Check again"}
          </button>
        </div>
        {gh?.error && <ErrorBox error={gh.error} />}
        {ghError && <ErrorBox error={ghError} />}

        <form className="bc-row" onSubmit={onRepoSubmit}>
          <label htmlFor="bc-repo">Repository</label>
          <input
            id="bc-repo"
            value={repoDraft}
            onChange={(e) => setRepoDraft(e.currentTarget.value)}
            placeholder="owner/name"
            spellCheck={false}
            className="field bc-grow"
          />
          <button type="submit" className="btn" disabled={loadingPrs}>
            {loadingPrs ? "Loading..." : "Load open PRs"}
          </button>
        </form>
      </div>

      <div className="bc-block">
        <h3 ref={prsHeading} className="bc-title" tabIndex={-1}>
          Open pull requests
          {repo && (
            <>
              {" "}
              in <span className="bc-title-repo">{repo}</span>
              {originRepo && sameRepo(repo, originRepo) && <span className="bc-muted bc-origin"> (from origin)</span>}
            </>
          )}
        </h3>
        {!repo && originChecked && (
          <p className="bc-empty">
            {repoPath
              ? "The open repository has no GitHub origin remote. Type a GitHub repository (owner/name) above to list its open pull requests."
              : "Type a GitHub repository (owner/name) above to list its open pull requests."}
          </p>
        )}
        {prsError && <ErrorBox error={prsError} />}
        {!prs && loadingPrs && !prsError && (
          <div className="bc-loading" role="status">
            <p className="working">
              <span className="working-dot" aria-hidden="true" />
              Asking GitHub for open pull requests...
            </p>
            {/* Ruled placeholder rows where the list will land. */}
            <ul className="bc-skeleton" aria-hidden="true">
              <li><span /><span /></li>
              <li><span /><span /></li>
              <li><span /><span /></li>
            </ul>
          </div>
        )}
        {prs && prs.length === 0 && <p className="bc-empty">No open pull requests in this repository.</p>}
        {prs && prs.length > 0 && (
          <ul className="bc-prs" aria-busy={loadingPrs || undefined}>
            {prs.map((pr, index) => {
              const status = lastCheckLabel(pr);
              return (
                <li key={pr.number} className="bc-pr" style={stagger(index)}>
                  <div className="bc-pr-main">
                    <span className="bc-pr-number">
                      <ExternalLink href={pr.url}>#{pr.number}</ExternalLink>
                    </span>{" "}
                    <strong className="bc-pr-title">{pr.title}</strong>
                    {pr.isDraft && <span className="bc-badge bc-badge-draft">draft</span>}
                    <div className="bc-muted bc-pr-meta">
                      @{pr.author} · {pr.headRefName} into {pr.baseRefName} ·{" "}
                      <span className="bc-add">+{pr.additions}</span> <span className="bc-del">-{pr.deletions}</span> in{" "}
                      {plural(pr.changedFiles, "file")} · <span className={status.className}>{status.text}</span>
                    </div>
                  </div>
                  <div className="bc-pr-actions">
                    {pr.lastReport && (
                      <button type="button" className="btn bc-btn-sm" onClick={() => void viewReport(pr.number)}>
                        View report
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn bc-btn-sm"
                      onClick={() => void runCheck(pr.number)}
                      disabled={running}
                    >
                      Run bug check
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="bc-row bc-other">
          <label htmlFor="bc-other">Check another PR #</label>
          <input
            id="bc-other"
            className="field bc-number"
            inputMode="numeric"
            value={otherPr}
            onChange={(e) => setOtherPr(e.currentTarget.value.replace(/[^0-9]/g, ""))}
            placeholder="number"
          />
          <button
            type="button"
            className="btn"
            onClick={() => void runCheck(otherNumber)}
            disabled={!otherValid || running || !repo}
          >
            Run bug check
          </button>
          <button type="button" className="btn" onClick={() => void viewReport(otherNumber)} disabled={!otherValid || !repo}>
            View report
          </button>
          <span className="bc-muted">also works for closed and merged PRs</span>
        </div>

        <details className="bc-options">
          <summary>Check options</summary>
          <div className="bc-row">
            <label className="bc-check-label">
              <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Double-check
              each finding (one extra model call per finding; filters out most false alarms)
            </label>
          </div>
          <div className="bc-row">
            <label className="bc-check-label">
              <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} /> Think first (slower,
              sometimes more accurate)
            </label>
          </div>
          <div className="bc-option-grid">
            <label htmlFor="bc-ctx">Context window</label>
            <select id="bc-ctx" className="field bc-select" value={numCtx} onChange={(e) => setNumCtx(Number(e.target.value))}>
              <option value={8192}>8K tokens (less memory, more and smaller parts)</option>
              <option value={16384}>16K tokens (default)</option>
              <option value={32768}>32K tokens (more memory)</option>
            </select>
            <label htmlFor="bc-conf">Minimum confidence</label>
            <select id="bc-conf" className="field bc-select" value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))}>
              <option value={0.3}>30%</option>
              <option value={0.5}>50% (default)</option>
              <option value={0.7}>70%</option>
              <option value={0.85}>85%</option>
            </select>
          </div>
        </details>
      </div>

      {progress && (
        <div className="bc-block bc-progress" aria-live="polite">
          <div className="bc-row bc-progress-head">
            <span className="working-dot" aria-hidden="true" />
            <strong className="bc-grow">
              Checking {progress.repo}#{progress.number}
            </strong>
            <button type="button" className="btn bc-btn-sm" onClick={cancelRun} disabled={progress.cancelling}>
              {progress.cancelling ? "Cancelling..." : "Cancel"}
            </button>
          </div>
          <ProgressTrack progress={progress} />
          <p>{progressLine(progress)}</p>
          {progress.totalChunks !== undefined && (
            <p className="bc-muted">
              {plural(progress.filesReviewed, "file")} to review
              {progress.filesSkipped > 0 && `, ${progress.filesSkipped} skipped`}
              {progress.chunksFailed > 0 && ` · ${plural(progress.chunksFailed, "chunk")} failed`}
            </p>
          )}
          {progress.chunkFiles.length > 0 && <p className="bc-muted bc-files">Now: {progress.chunkFiles.join(", ")}</p>}
        </div>
      )}
      {runError?.error.kind === "cancelled" && <p className="bc-muted bc-note">Check of #{runError.number} cancelled.</p>}
      {runError && runError.error.kind !== "cancelled" && <ErrorBox error={runError.error} />}
      {reportError && <ErrorBox error={reportError} />}

      {report && (
        // Keyed by the check, so opening another report eases it in afresh.
        <div key={`${report.repo}#${report.number}@${report.startedAt}`} ref={reportBox} className="bc-block bc-report">
          <div className="bc-report-head">
            <h3 className="bc-report-title" tabIndex={-1}>
              {report.repo}#{report.number}: {report.title}
            </h3>
            <button type="button" className="btn bc-btn-sm" onClick={closeReport}>
              Close
            </button>
          </div>
          <p className="bc-muted">
            Commit <code>{report.headSha.slice(0, 7)}</code> · <code>{report.model}</code> · {formatTime(report.startedAt)} · took{" "}
            {formatDuration(report.durationMs)} · {plural(report.filesReviewed.length, "file")} reviewed
          </p>
          {tally.length > 0 && (
            <p className="bc-tally">
              <span className="bc-muted">{plural(report.findings.length, "finding")}:</span>
              {tally.map(({ severity, count }) => (
                <span key={severity} className={`bc-badge bc-badge-${severity}`}>
                  {count} {SEVERITY_LABELS[severity]}
                </span>
              ))}
            </p>
          )}
          {report.filesSkipped.length > 0 && (
            <details className="bc-disclosure">
              <summary className="bc-muted">{plural(report.filesSkipped.length, "file")} skipped</summary>
              <ul className="bc-plain">
                {report.filesSkipped.map((s) => (
                  <li key={s.path}>
                    <code>{s.path}</code> <span className="bc-muted">({s.reason})</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.notes.length > 0 && (
            <ul className="bc-notes">
              {report.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
          {report.posted && (
            <p className="bc-ok bc-done">
              {plural(report.posted.findingIds.length, "comment")} from this check{" "}
              {report.posted.findingIds.length === 1 ? "was" : "were"} posted
              {report.posted.reviewUrl && (
                <>
                  {": "}
                  <ExternalLink href={report.posted.reviewUrl}>open the latest review</ExternalLink>
                </>
              )}
            </p>
          )}

          {report.findings.length === 0 ? (
            <p className="bc-empty bc-clean">
              No bugs found in the reviewed diff
              {report.filtered && report.filtered.length > 0
                ? ` (the double-check filtered out ${plural(report.filtered.length, "possible finding")}).`
                : "."}
            </p>
          ) : (
            grouped.map(([path, findings]) => (
              <div key={path} className="bc-file">
                <h4>
                  <code>{path}</code> <span className="bc-muted">({plural(findings.length, "finding")})</span>
                </h4>
                <ul className="bc-findings">
                  {findings.map((f) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      order={findingOrder.get(f.id) ?? 0}
                      selected={selected.has(f.id)}
                      posted={postedHere.has(f.id)}
                      postedEarlier={!postedHere.has(f.id) && postedIds.has(f.id)}
                      onToggle={toggleFinding}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}

          {report.filtered && report.filtered.length > 0 && (
            <details className="bc-filtered">
              <summary className="bc-muted">
                {plural(report.filtered.length, "finding")} filtered out by the double-check (never posted)
              </summary>
              <ul className="bc-plain">
                {report.filtered.map((f) => (
                  <li key={f.id}>
                    <span className={`bc-badge bc-badge-${f.severity}`}>{SEVERITY_LABELS[f.severity]}</span>{" "}
                    <code>
                      {f.path}:{f.line}
                    </code>{" "}
                    {f.title} <VerificationNote finding={f} />
                    {f.verification && <div className="bc-muted bc-filtered-reason">{f.verification.reason}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {postableIds.length > 0 && (
            <div className="bc-post">
              {!confirming && (
                <div className="bc-row">
                  <button
                    ref={postKey}
                    type="button"
                    className="btn primary"
                    onClick={() => setConfirming(true)}
                    disabled={selectedIds.length === 0 || overLimit || posting || reportBusy}
                  >
                    Post {plural(selectedIds.length, "comment")} to GitHub
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setSelected(new Set(unpostedIds))}
                    disabled={unpostedIds.length === 0}
                  >
                    Select all
                  </button>
                  <button type="button" className="btn" onClick={() => setSelected(new Set())}>
                    Select none
                  </button>
                  {overLimit && (
                    <span className="bc-warn">At most {MAX_COMMENTS_PER_REVIEW} comments per review.</span>
                  )}
                  {reportBusy && <span className="bc-muted">A check of this PR is running; post when it has finished.</span>}
                  {unpostedIds.length === 0 && <span className="bc-muted">Every postable finding was posted already.</span>}
                </div>
              )}
              {confirming && (
                <div
                  className="bc-confirm"
                  role="alertdialog"
                  aria-label="Confirm posting"
                  aria-describedby="bc-confirm-text"
                  onKeyDown={(event) => {
                    // Esc answers "Cancel" here; it must not also close the whole drawer
                    // (not even while posting, when there is nothing left to cancel).
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!posting) setConfirming(false);
                  }}
                >
                  <p id="bc-confirm-text">
                    Post a review with {plural(selectedIds.length, "inline comment")} to{" "}
                    <strong>
                      {report.repo}#{report.number}
                    </strong>{" "}
                    on GitHub{gh?.user ? ` as @${gh.user}` : ""}? Everyone with access to the repository will see them.
                  </p>
                  <div className="bc-row bc-confirm-keys">
                    <button
                      type="button"
                      className="btn bc-danger"
                      onClick={() => void post()}
                      disabled={posting || reportBusy || selectedIds.length === 0}
                    >
                      {posting ? "Posting..." : `Post ${plural(selectedIds.length, "comment")}`}
                    </button>
                    <button
                      ref={confirmCancel}
                      type="button"
                      className="btn"
                      onClick={() => setConfirming(false)}
                      disabled={posting}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {postResult && (
                <p ref={postDone} className="bc-ok bc-done bc-post-done" role="status" tabIndex={-1}>
                  Posted {plural(postResult.postedCount, "comment")}
                  {postResult.reviewUrl && (
                    <>
                      {": "}
                      <ExternalLink href={postResult.reviewUrl}>{postResult.reviewUrl}</ExternalLink>
                    </>
                  )}
                </p>
              )}
              {postError && (
                <ErrorBox
                  error={postError}
                  extra={
                    postError.kind === "stale_report"
                      ? "New commits were pushed since this check. Run the bug check again, then post."
                      : undefined
                  }
                />
              )}
              {postError?.kind === "stale_report" && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void runCheck(report.number)}
                  disabled={running || report.repo !== repo}
                >
                  Run the bug check again
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="bc-block">
        <h3 className="bc-title">Auto review</h3>
        <p className="bc-muted">
          While the app is running, checks open PRs of {repo ? <strong>{repo}</strong> : "the repository above"} that have no up-to-date check, one at a
          time. The first poll works through every open PR not checked yet (up to 50, which can take a long time on a
          small GPU); after that, only PRs that are opened or get new commits.
        </p>
        <div className="bc-row">
          <label className="bc-check-label">
            <input
              type="checkbox"
              checked={!!watch?.enabled}
              disabled={watchBusy || watch == null || (!watch.enabled && !repo)}
              onChange={(e) => void setWatching(e.target.checked)}
            />{" "}
            Enabled
          </label>
          <label htmlFor="bc-interval">Check every</label>
          <input
            id="bc-interval"
            className="field bc-number"
            type="number"
            min={1}
            max={120}
            value={interval}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            onBlur={() => setIntervalMinutes((value) => clampInterval(value))}
          />
          <span>minutes</span>
          <label className="bc-check-label">
            <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} /> Include
            drafts
          </label>
        </div>
        <div className="bc-row">
          <label className="bc-check-label">
            <input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} /> Post findings
            automatically
          </label>
        </div>
        {autoPost && (
          <p className="bc-warning" role="note">
            Comments will be posted to GitHub without your review, also on existing open PRs that have no check yet.
            The model can be wrong. A finding already posted on a PR is not posted again.
          </p>
        )}
        {watchDirty && (
          <div className="bc-row">
            <span className="bc-warn">Settings changed.</span>
            <button type="button" className="btn bc-btn-sm" onClick={() => void setWatching(true)} disabled={watchBusy || !repo}>
              Apply
            </button>
          </div>
        )}
        {watchError && <ErrorBox error={watchError} />}
        {watch && (
          <div className="bc-watch-state">
            <p>
              {watch.enabled ? (
                <span className="bc-ok">Watching {watchConfig?.repo ?? repo}</span>
              ) : (
                <span className="bc-muted">Off</span>
              )}
              {watchConfig && watch.enabled && (
                <span className="bc-muted">
                  {" "}
                  · every {plural(watchConfig.intervalMinutes, "minute")}
                  {watchConfig.includeDrafts && " · drafts included"}
                  {watchConfig.autoPost && " · auto-post on"}
                </span>
              )}
            </p>
            <p className="bc-muted">
              Last poll: {formatTime(watch.lastPollAt)}
              {watch.current !== undefined && ` · reviewing #${watch.current}`}
              {watch.queue.length > 0 && ` · queued ${watch.queue.map((n) => `#${n}`).join(", ")}`}
            </p>
            {watchProgress && watch.current === watchProgress.number && (
              <p className="bc-muted">
                #{watchProgress.number}: {progressLine(watchProgress)}
              </p>
            )}
            {watch.lastError && <ErrorBox error={watch.lastError} />}
          </div>
        )}
        {activity.length > 0 && (
          <ul className="bc-activity">
            {activity.map((entry) => (
              <li key={entry.id}>
                <span className="bc-muted">{entry.at}</span> {entry.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
