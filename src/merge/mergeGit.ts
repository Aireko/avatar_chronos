// Every git operation Merge Doctor performs. All of it goes through run_git_command
// (no shell); nothing here forces anything or resets the user's work.
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  analyzeMerge,
  errorMessage,
  exportGraph,
  readRepoFile,
  runGitCommand,
  writeRepoFile,
  type ChronosGraph,
  type CommandRun,
  type GraphLoad,
} from "../backend";
import {
  applyResolutions,
  isValidBranchName,
  quoteGitArg,
  unquoteGitPath,
  type RegionEntry,
  parseConflictMarkers,
} from "./resolution";
import type { ApplyOutcome, ResolvedEntry, SkippedNote } from "./types";

/* ---------- plumbing ---------- */

/**
 * Merge Doctor's git commands refresh the graph after each command; they write to their
 * own scratch file so they never race with the chronos_graph.json that Open and Reload use.
 */
async function scratchGraphPath(): Promise<string | undefined> {
  try {
    return await join(await appDataDir(), "chronos_merge_graph.json");
  } catch {
    return undefined; // outside the app the backend call fails with its own clear message
  }
}

class GitFailure extends Error {}

/** Runs `git <args>`; any exit code outside `accept` becomes an error carrying git's own words. */
async function git(repo: string, args: string, accept: readonly number[] = [0]): Promise<CommandRun> {
  const run = await runGitCommand(repo, args, await scratchGraphPath());
  if (!accept.includes(run.result.exitCode)) {
    const said = (run.result.stderr || run.result.error || run.result.stdout || "no output").trim();
    throw new GitFailure(`git ${args.split(" ")[0]} failed (exit ${run.result.exitCode}): ${said}`);
  }
  return run;
}

class Cancelled extends Error {}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/* ---------- reads ---------- */

/** Branch names are validated here as well as in the UI: this is the last stop before a command line. */
function checkNames(...names: string[]): void {
  for (const name of names) {
    if (!isValidBranchName(name)) {
      throw new Error(`"${name}" isn't a branch name Merge Doctor will pass to git (letters, digits, . _ / - only, no leading "-").`);
    }
  }
}

export async function previewMerge(repo: string, source: string, target: string): Promise<GraphLoad> {
  checkNames(source, target);
  return analyzeMerge(repo, source, target, await scratchGraphPath());
}

/** True when a merge is already open in this repository (MERGE_HEAD exists). */
export async function isMergeInProgress(repo: string): Promise<boolean> {
  const run = await runGitCommand(repo, "rev-parse -q --verify MERGE_HEAD", await scratchGraphPath());
  return run.result.exitCode === 0;
}

/** `git merge --abort`. Resolves to the refreshed graph. Rejects if git refuses. */
export async function abortMerge(repo: string): Promise<ChronosGraph | null> {
  const run = await git(repo, "merge --abort");
  return run.graph;
}

export interface RevisionFile {
  text: string;
  missing: boolean;
  truncated: boolean;
}

/** `git show <rev>:<path>`. A file that doesn't exist at `rev` is reported as missing, not as an error. */
export async function readRevisionFile(repo: string, rev: string, path: string): Promise<RevisionFile> {
  const run = await runGitCommand(repo, `show ${quoteGitArg(`${rev}:${path}`)}`, await scratchGraphPath());
  if (run.result.exitCode !== 0) return { text: "", missing: true, truncated: false };
  return { text: run.result.stdout, missing: false, truncated: run.result.stdoutTruncated };
}

/* ---------- the merge ---------- */

export interface ApplyInput {
  repoPath: string;
  source: string;
  target: string;
  message: string;
  entries: ResolvedEntry[];
}

export interface ApplyHooks {
  onStep: (label: string) => void;
  /** Checked between steps; true makes the merge abort itself. */
  shouldAbort: () => boolean;
}

const ADD_CHUNK = 20;

/**
 * Merges `source` into `target` and commits it, with the user's resolutions in place of
 * git's conflict regions. Never throws: the outcome says what happened. After the merge has
 * started, any failure (or a requested abort) ends with `git merge --abort`.
 */
export async function applyMerge(input: ApplyInput, hooks: ApplyHooks): Promise<ApplyOutcome> {
  const { repoPath: repo, source, target, entries } = input;
  let started = false;
  let committed = false;
  // Newest graph any command returned. In an object, so closures and the code below agree on its type.
  const latest: { graph: ChronosGraph | null } = { graph: null };

  const track = (run: CommandRun): CommandRun => {
    if (run.graph) latest.graph = run.graph;
    return run;
  };
  const step = (label: string) => {
    if (hooks.shouldAbort()) throw new Cancelled();
    hooks.onStep(label);
  };

  try {
    checkNames(source, target);
    const message = input.message.replace(/\r\n/g, "\n").trim();
    if (!message) throw new Error("Write a commit message first.");

    step("Checking that the working tree is clean…");
    const status = track(await git(repo, "status --porcelain"));
    if (status.result.stdout.trim()) {
      throw new Error(
        "The working tree isn't clean. Commit, stash or discard your changes first; Merge Doctor won't touch them:\n" +
          lines(status.result.stdout).slice(0, 8).join("\n"),
      );
    }

    step(`Making sure ${target} is checked out…`);
    const head = track(await git(repo, "rev-parse --abbrev-ref HEAD")).result.stdout.trim();
    if (head !== target) track(await git(repo, `switch ${target}`));

    step(`Merging ${source} into ${target} (no commit yet)…`);
    const merge = track(await git(repo, `merge --no-commit --no-ff ${source}`, [0, 1]));
    started = await hasMergeHead(repo);
    if (!started) {
      if (merge.result.exitCode === 0) {
        return { kind: "nothing", message: `${target} already contains everything in ${source}. There is nothing to merge.`, graph: latest.graph };
      }
      throw new Error(`git merge didn't start: ${(merge.result.stderr || merge.result.stdout).trim()}`);
    }

    step("Finding the files git couldn't merge…");
    const conflicted = await unmergedFiles(repo);
    const byFile = new Map<string, ResolvedEntry[]>();
    for (const entry of entries) byFile.set(entry.filePath, [...(byFile.get(entry.filePath) ?? []), entry]);

    const skipped: SkippedNote[] = [];
    const applied: string[] = [];
    const toAdd: string[] = [];
    const toRemove: string[] = [];

    for (const entry of entries) {
      if (!conflicted.includes(entry.filePath)) {
        skipped.push({ id: entry.id, label: entry.label, reason: `git merged ${entry.filePath} without a conflict` });
      }
    }

    for (const file of conflicted) {
      const forFile = byFile.get(file);
      if (!forFile || forFile.length === 0) {
        throw new Error(`git reports a conflict in ${file} that the preview didn't list, so there is no resolution for it.`);
      }
      step(`Resolving ${file}…`);

      const whole = forFile.filter((e) => e.fileLevel);
      if (whole.length > 0) {
        if (forFile.length > 1) {
          throw new Error(`${file} has a whole-file resolution and function resolutions at once; resolve it in the Terminal instead.`);
        }
        const entry = whole[0];
        if (entry.deleteFile) {
          toRemove.push(file);
        } else {
          await writeRepoFile(repo, file, entry.text);
          toAdd.push(file);
        }
        applied.push(entry.id);
        continue;
      }

      const original = (await readRepoFile(repo, file)).content;
      const regionEntries: RegionEntry[] = forFile.map((e) => ({
        id: e.id,
        label: e.label,
        oursSnippet: e.oursSnippet,
        theirsSnippet: e.theirsSnippet,
        text: e.text,
      }));
      const report = applyResolutions(original, regionEntries, file);
      await writeRepoFile(repo, file, report.text);
      if (parseConflictMarkers(report.text).regions.length > 0) {
        throw new Error(`Conflict markers are still left in ${file} after resolving it.`);
      }
      applied.push(...report.applied);
      for (const s of report.skipped) skipped.push(s);
      toAdd.push(file);
    }

    for (let i = 0; i < toAdd.length; i += ADD_CHUNK) {
      step("Staging the resolved files…");
      track(await git(repo, `add -- ${toAdd.slice(i, i + ADD_CHUNK).map(quoteGitArg).join(" ")}`));
    }
    for (const file of toRemove) {
      step(`Removing ${file}…`);
      track(await git(repo, `rm -- ${quoteGitArg(file)}`));
    }

    step("Checking that nothing is left unmerged…");
    const left = await unmergedFiles(repo);
    if (left.length > 0) throw new Error(`Still unmerged after resolving: ${left.join(", ")}`);

    step("Committing the merge…");
    track(await git(repo, `commit -m ${quoteGitArg(message)}`));
    committed = true;

    // The merge is committed from here on: nothing below may abort it.
    let hash = "";
    let diff = "";
    try {
      hash = track(await git(repo, "rev-parse HEAD")).result.stdout.trim();
      diff = track(await git(repo, "show --format= -m --first-parent HEAD")).result.stdout;
    } catch {
      /* the commit exists; the hash and the diff are conveniences */
    }
    if (!latest.graph) {
      try {
        latest.graph = (await exportGraph(repo)).graph;
      } catch {
        /* the caller can Reload */
      }
    }
    return { kind: "committed", hash, graph: latest.graph, applied, skipped, diff };
  } catch (e) {
    let aborted = false;
    let abortError: string | null = null;
    if (started && !committed) {
      try {
        track(await git(repo, "merge --abort"));
        aborted = true;
      } catch (abortFailure) {
        abortError = errorMessage(abortFailure);
      }
    }
    if (e instanceof Cancelled) return { kind: "cancelled", aborted, abortError, graph: latest.graph };
    return { kind: "failed", message: errorMessage(e), aborted, abortError, graph: latest.graph };
  }
}

async function hasMergeHead(repo: string): Promise<boolean> {
  return (await git(repo, "rev-parse -q --verify MERGE_HEAD", [0, 1])).result.exitCode === 0;
}

async function unmergedFiles(repo: string): Promise<string[]> {
  const run = await git(repo, "diff --name-only --diff-filter=U");
  return [...new Set(lines(run.result.stdout).map(unquoteGitPath))];
}