// "Explain this commit": builds the prompt the commit ticket hands to the Local
// AI drawer. Pure, so it is tested without a DOM or a model.
import type { Commit } from "../backend";

/** About how much of `git show` goes into the prompt, so a small local model keeps up. */
export const PATCH_LIMIT = 12_000;
/** Longer file lists are cut short; the patch carries the details anyway. */
export const FILE_LIST_LIMIT = 60;

export const EXPLAIN_SYSTEM =
  "You explain git commits to developers in plain language. Be concise and concrete. " +
  "Only describe what the commit shows; if something is unclear, say so instead of guessing.";

export interface ExplainInput {
  commit: Commit;
  /** `git show --no-color --format=fuller <hash>` output, or null when it could not be read. */
  patch: string | null;
  /** The backend already cut the output short (its own size cap). */
  patchTruncated?: boolean;
  limit?: number;
}

export interface ExplainPrompt {
  prompt: string;
  system: string;
}

/** "2024-03-05 14:07 UTC": the same everywhere, unlike toLocaleString. */
export function formatCommitDate(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Cuts `text` to about `limit` characters, at a line break when one is close to
 * the limit, so the model never sees half a line.
 */
export function truncatePatch(text: string, limit = PATCH_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", limit);
  const end = cut >= limit * 0.8 ? cut : limit;
  return { text: text.slice(0, end), truncated: true };
}

const STATUS_WORD: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied" };

function fileLines(commit: Commit): string[] {
  const files = commit.filesChanged;
  const lines = files.slice(0, FILE_LIST_LIMIT).map((f) => {
    const what = STATUS_WORD[f.status] ?? f.status;
    const path = f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path;
    return `- ${path} (${what}, +${f.additions} -${f.deletions})`;
  });
  if (files.length > FILE_LIST_LIMIT) lines.push(`- ...and ${files.length - FILE_LIST_LIMIT} more files`);
  return lines;
}

export function buildExplainPrompt({ commit, patch, patchTruncated = false, limit = PATCH_LIMIT }: ExplainInput): ExplainPrompt {
  const additions = commit.filesChanged.reduce((n, f) => n + f.additions, 0);
  const deletions = commit.filesChanged.reduce((n, f) => n + f.deletions, 0);
  const parts: string[] = [
    "Explain this git commit in plain language for a developer who has not seen it. " +
      "Start with a one-sentence summary, then a few short bullet points on what changed and why it likely matters. " +
      "Mention anything that looks risky or worth checking.",
    "",
    "Commit message:",
    commit.message.trim() || "(empty)",
    "",
    `Author: ${commit.author}`,
    `Date: ${formatCommitDate(commit.timestamp)}`,
    `Commit: ${commit.hash}`,
  ];
  if (commit.parents.length > 1) parts.push(`This is a merge commit with ${commit.parents.length} parents.`);
  if (commit.parents.length === 0) parts.push("This is the first commit in the history.");

  parts.push("");
  if (commit.filesChanged.length === 0) {
    parts.push("Changed files: none.");
  } else {
    const n = commit.filesChanged.length;
    parts.push(`Changed files (${n} ${n === 1 ? "file" : "files"}, +${additions} -${deletions}):`, ...fileLines(commit));
  }

  parts.push("");
  if (patch === null) {
    parts.push("The patch could not be read, so explain the commit from the details above.");
  } else if (!patch.trim()) {
    parts.push("git show printed no patch for this commit, so explain it from the details above.");
  } else {
    const cut = truncatePatch(patch.trimEnd(), limit);
    parts.push("Patch (git show):", "<<<", cut.text, ">>>");
    if (cut.truncated || patchTruncated) {
      const shown = cut.text.length.toLocaleString("en-US");
      const total = patch.trimEnd().length.toLocaleString("en-US");
      parts.push(
        patchTruncated && !cut.truncated
          ? "Note: the patch was cut short because it is very large; explain what you can see and say that the rest was not shown."
          : `Note: the patch was truncated to the first ${shown} of ${total}${patchTruncated ? "+" : ""} characters; explain what you can see and say that the rest was not shown.`,
      );
    }
  }

  return { prompt: parts.join("\n"), system: EXPLAIN_SYSTEM };
}
