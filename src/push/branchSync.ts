// Ahead/behind against origin, and the words on the branch key's sync bubble.
// Uses `git status -sb`, `git fetch`, `git remote`, and `git log` (all whitelisted).

import { runGitCommand, type CommandRun } from "../backend";

export type BranchSyncHint =
  | { kind: "fetch" }
  | { kind: "pull"; behind: number };

export interface BranchSyncStatus {
  /** Local branch from the status header, if any. */
  branch: string | null;
  /** Upstream short name (e.g. origin/main), when known. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Whether a remote named origin exists. */
  hasOrigin: boolean;
  /** True when `git fetch --dry-run` would update remote-tracking refs. */
  fetchNeeded: boolean;
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

async function git(repo: string, args: string): Promise<CommandRun> {
  const run = await runGitCommand(repo, args);
  if (!run.result.ok) {
    throw new Error((run.result.stderr || run.result.error || run.result.stdout || "git command failed").trim());
  }
  return run;
}

function countLogLines(stdout: string): number {
  const t = stdout.trim();
  return t ? t.split("\n").length : 0;
}

/**
 * First line of `git status -sb`, e.g.
 * `## main...origin/main [ahead 1, behind 2]`
 */
export function parseStatusBranchLine(line: string): Omit<BranchSyncStatus, "hasOrigin" | "fetchNeeded"> {
  const header = line.trim().split("\n")[0] ?? "";
  const empty = { branch: null, upstream: null, ahead: 0, behind: 0 };
  if (!header.startsWith("## ")) return empty;

  const body = header.slice(3).trim();
  if (!body || body.startsWith("HEAD ")) return empty;

  // `## branch`, `## branch...upstream`, or either with ` [ahead N, behind M]`.
  const dots = body.indexOf("...");
  let branch: string;
  let upstream: string | null = null;
  let bracket: string | undefined;
  if (dots === -1) {
    const space = body.indexOf(" [");
    branch = (space === -1 ? body : body.slice(0, space)).trim();
    if (space !== -1) bracket = body.slice(space + 2, body.endsWith("]") ? -1 : undefined);
  } else {
    branch = body.slice(0, dots).trim();
    const rest = body.slice(dots + 3);
    const space = rest.indexOf(" [");
    if (space === -1) upstream = rest.trim() || null;
    else {
      upstream = rest.slice(0, space).trim() || null;
      bracket = rest.slice(space + 2, rest.endsWith("]") ? -1 : undefined);
    }
  }
  if (!branch) return empty;

  let ahead = 0;
  let behind = 0;
  if (bracket) {
    const a = bracket.match(/ahead\s+(\d+)/);
    const b = bracket.match(/behind\s+(\d+)/);
    if (a) ahead = Number(a[1]);
    if (b) behind = Number(b[1]);
  }
  return { branch, upstream, ahead, behind };
}

/**
 * Whether `git fetch --dry-run` output means origin has updates we have not stored yet.
 * Matches new branches/tags and tip moves (`abc..def  main -> origin/main`).
 */
export function fetchDryRunHasUpdates(stdout: string, stderr = ""): boolean {
  const text = `${stdout}\n${stderr}`;
  if (/\[new (?:branch|tag)\]/i.test(text)) return true;
  if (/^\s*[0-9a-f]+\.\.[0-9a-f]+\s+\S+\s+->\s+\S+/im.test(text)) return true;
  if (/^\s*\+\s+[0-9a-f]+\.\.\.[0-9a-f]+\s+\S+\s+->\s+\S+/im.test(text)) return true;
  return false;
}

/** Pull when behind; Fetch only when a dry-run found remote updates. Otherwise nothing. */
export function syncHintFor(status: BranchSyncStatus): BranchSyncHint | null {
  if (status.behind > 0) return { kind: "pull", behind: status.behind };
  if (status.fetchNeeded) return { kind: "fetch" };
  return null;
}

export function syncBubbleLabel(hint: BranchSyncHint): string {
  if (hint.kind === "fetch") return "Fetch";
  return hint.behind === 1 ? "Pull · 1 behind" : `Pull · ${hint.behind} behind`;
}

/** localStorage key: whether the branch bubble quietly fetches on its own. Default off. */
export const AUTO_FETCH_KEY = "chronos.branchAutoFetch";

export function readAutoFetch(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const raw = (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.getItem(AUTO_FETCH_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

export function writeAutoFetch(on: boolean, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    (storage ?? (typeof localStorage !== "undefined" ? localStorage : null))?.setItem(AUTO_FETCH_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked */
  }
}

async function hasOriginRemote(repo: string): Promise<boolean> {
  const run = await git(repo, "remote");
  return run.result.stdout
    .split("\n")
    .map((l) => l.trim())
    .includes("origin");
}

/**
 * Compare HEAD to origin/<branch> when status has no ahead/behind (no upstream set).
 * `git log` is whitelisted; `rev-list` is not.
 */
async function driftAgainstOrigin(
  repo: string,
  branch: string,
): Promise<{ upstream: string; ahead: number; behind: number } | null> {
  if (!SAFE_BRANCH.test(branch)) return null;
  const remote = `origin/${branch}`;
  try {
    await git(repo, `rev-parse --verify ${remote}`);
  } catch {
    return null;
  }
  const behind = countLogLines((await git(repo, `log --oneline HEAD..${remote}`)).result.stdout);
  const ahead = countLogLines((await git(repo, `log --oneline ${remote}..HEAD`)).result.stdout);
  return { upstream: remote, ahead, behind };
}

/** Local view only — does not contact the network. */
export async function readBranchSync(repo: string, fetchNeeded = false): Promise<BranchSyncStatus> {
  const [statusRun, origin] = await Promise.all([git(repo, "status -sb"), hasOriginRemote(repo)]);
  const parsed = parseStatusBranchLine(statusRun.result.stdout);
  const base: BranchSyncStatus = { ...parsed, hasOrigin: origin, fetchNeeded: false };

  if (!origin || !parsed.branch) return { ...base, fetchNeeded };
  if (parsed.upstream && (parsed.ahead > 0 || parsed.behind > 0)) {
    return { ...base, fetchNeeded };
  }

  const drift = await driftAgainstOrigin(repo, parsed.branch);
  if (!drift) return { ...base, fetchNeeded };
  return {
    ...base,
    upstream: parsed.upstream ?? drift.upstream,
    ahead: drift.ahead,
    behind: drift.behind,
    fetchNeeded,
  };
}

/** Asks origin what a fetch would bring, without updating local refs. */
export async function probeFetchNeeded(repo: string): Promise<boolean> {
  try {
    const run = await runGitCommand(repo, "fetch --dry-run origin");
    return fetchDryRunHasUpdates(run.result.stdout, run.result.stderr);
  } catch {
    return false;
  }
}

/** Local status, plus an optional dry-run to see if Fetch should appear. */
export async function probeBranchSync(repo: string, checkRemote: boolean): Promise<BranchSyncStatus> {
  const local = await readBranchSync(repo, false);
  if (!local.hasOrigin || local.behind > 0 || !checkRemote) return local;
  const fetchNeeded = await probeFetchNeeded(repo);
  return { ...local, fetchNeeded };
}

/** Updates remote-tracking refs; returns status afterward (Fetch should clear). */
export async function fetchOrigin(repo: string): Promise<BranchSyncStatus> {
  await git(repo, "fetch --quiet origin");
  return readBranchSync(repo, false);
}
