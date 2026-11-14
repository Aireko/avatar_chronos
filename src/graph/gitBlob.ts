import { readRepoFile, runShellCommand } from "../backend";

/** Quote a string for `sh -lc`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type DiffPath = { path: string; oldPath: string | null; status: string };

/** Files that differ between `baseRev` and the working tree (or `headRev` if set). */
export async function listChangedPaths(
  repoPath: string,
  baseRev: string,
  headRev?: string | null,
): Promise<DiffPath[]> {
  const args = headRev
    ? `diff --name-status -M ${shellQuote(baseRev)} ${shellQuote(headRev)}`
    : `diff --name-status -M ${shellQuote(baseRev)}`;
  const run = await runShellCommand(repoPath, `git ${args}`);
  if (!run.ok && !run.stdout.trim()) {
    throw new Error(run.stderr.trim() || `git diff failed (exit ${run.exitCode})`);
  }
  const out: DiffPath[] = [];
  for (const line of run.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    if (status === "R" || status === "C") {
      out.push({ status, oldPath: parts[1] ?? null, path: parts[2] ?? parts[1] ?? "" });
    } else {
      out.push({ status, oldPath: null, path: parts[1] ?? "" });
    }
  }
  return out.filter((p) => p.path);
}

/** File contents at a revision, or working tree when `rev` is null. Missing → null. */
export async function readBlob(
  repoPath: string,
  rev: string | null,
  path: string,
): Promise<string | null> {
  if (!path) return null;
  if (rev == null) {
    try {
      return (await readRepoFile(repoPath, path)).content;
    } catch {
      return null;
    }
  }
  const run = await runShellCommand(repoPath, `git show ${shellQuote(`${rev}:${path}`)}`);
  if (!run.ok) return null;
  return run.stdout;
}
