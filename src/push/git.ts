import { exportGraph, runGitCommand, type ChronosGraph, type CommandRun } from "../backend";

const quote = (s: string) => `"${s.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;

async function git(repo: string, args: string): Promise<CommandRun> {
  const run = await runGitCommand(repo, args);
  if (!run.result.ok) {
    throw new Error((run.result.stderr || run.result.error || run.result.stdout || "git command failed").trim());
  }
  return run;
}

const graphOf = async (repo: string, run: CommandRun): Promise<ChronosGraph> =>
  run.graph ?? (await exportGraph(repo)).graph;

/** Local branch names (remote prefixes stripped, deduped). */
export function branchNames(graph: ChronosGraph): string[] {
  const names = graph.branches
    .map((b) => b.name.replace(/^(remotes\/)?origin\//, ""))
    .filter((n) => n && n !== "HEAD");
  return Array.from(new Set(names));
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

/** git add -A + git commit. If the tree is clean, nothing is committed. */
export async function commitAll(repo: string, message: string) {
  const status = await git(repo, "status --porcelain");
  if (!status.result.stdout.trim()) {
    return { committed: false, graph: await graphOf(repo, status) };
  }
  if (!message) throw new Error("Write a commit message first.");
  await git(repo, "add -A");
  const run = await git(repo, `commit -m ${quote(message)}`);
  return { committed: true, graph: await graphOf(repo, run) };
}

export async function headDiff(repo: string): Promise<string> {
  const run = await git(repo, "show --format= HEAD");
  return run.result.stdout;
}

/** Pushes HEAD to origin/<branch>. */
export async function pushTo(repo: string, branch: string): Promise<ChronosGraph> {
  if (!SAFE_BRANCH.test(branch)) throw new Error(`Invalid branch name: ${branch}`);
  const run = await git(repo, `push -u origin HEAD:${branch}`);
  return graphOf(repo, run);
}

export async function switchBranch(repo: string, branch: string): Promise<ChronosGraph> {
  if (!SAFE_BRANCH.test(branch)) throw new Error(`Invalid branch name: ${branch}`);
  const run = await git(repo, `switch ${branch}`);
  return graphOf(repo, run);
}

/** Creates a branch from the current commit and switches to it. Uncommitted changes come along. */
export async function createBranch(repo: string, branch: string): Promise<ChronosGraph> {
  if (!SAFE_BRANCH.test(branch)) throw new Error(`Invalid branch name: ${branch}`);
  const run = await git(repo, `switch -c ${branch}`);
  return graphOf(repo, run);
}

export async function pullFrom(repo: string, branch: string): Promise<ChronosGraph> {
  if (!SAFE_BRANCH.test(branch)) throw new Error(`Invalid branch name: ${branch}`);
  const run = await git(repo, `pull --no-rebase --no-edit origin ${branch}`);
  return graphOf(repo, run);
}