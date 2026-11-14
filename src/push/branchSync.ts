// Ahead/behind against the upstream, and the words on the branch key's sync bubble.
// Uses `git status -sb` (and `git fetch`) through the existing command whitelist.

import { runGitCommand, type CommandRun } from "../backend";

export type BranchSyncHint =
  | { kind: "fetch" }
  | { kind: "pull"; behind: number };

export interface BranchSyncStatus {
  /** Local branch from the status header, if any. */
  branch: string | null;
  /** Upstream short name (e.g. origin/main), when the branch tracks one. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

async function git(repo: string, args: string): Promise<CommandRun> {
  const run = await runGitCommand(repo, args);
  if (!run.result.ok) {
    throw new Error((run.result.stderr || run.result.error || run.result.stdout || "git command failed").trim());
  }
  return run;
}

/**
 * First line of `git status -sb`, e.g.
 * `## main...origin/main [ahead 1, behind 2]`
 */
export function parseStatusBranchLine(line: string): BranchSyncStatus {
  const header = line.trim().split("\n")[0] ?? "";
  const empty: BranchSyncStatus = { branch: null, upstream: null, ahead: 0, behind: 0 };
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

/** What the speech bubble should offer, given status and whether we have fetched this session. */
export function syncHintFor(status: BranchSyncStatus, fetchedThisSession: boolean): BranchSyncHint | null {
  if (status.behind > 0) return { kind: "pull", behind: status.behind };
  if (status.upstream && !fetchedThisSession) return { kind: "fetch" };
  return null;
}

export function syncBubbleLabel(hint: BranchSyncHint): string {
  if (hint.kind === "fetch") return "Fetch";
  return hint.behind === 1 ? "Pull · 1 behind" : `Pull · ${hint.behind} behind`;
}

export async function readBranchSync(repo: string): Promise<BranchSyncStatus> {
  const run = await git(repo, "status -sb");
  return parseStatusBranchLine(run.result.stdout);
}

/** Updates remote-tracking refs; returns status afterward. */
export async function fetchOrigin(repo: string): Promise<BranchSyncStatus> {
  await git(repo, "fetch --quiet origin");
  return readBranchSync(repo);
}
