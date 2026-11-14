// Small pure decisions behind the app shell (App.tsx) and its terminal dock, kept
// apart so they can be tested without a DOM.
import type { ChronosGraph } from "../backend";

/**
 * Did the history move between two loads of the same repository? (HEAD, a branch
 * tip or the set of commits changed.) Then the files on disk may have changed too.
 */
export function historyChanged(prev: ChronosGraph | undefined, next: ChronosGraph): boolean {
  if (!prev || prev.repoPath !== next.repoPath) return true;
  if (prev.head !== next.head) return true;
  if (prev.commits.length !== next.commits.length) return true;
  if (prev.branches.length !== next.branches.length) return true;
  const tips = new Map(prev.branches.map((b) => [b.name, b.commitHash]));
  if (next.branches.some((b) => tips.get(b.name) !== b.commitHash)) return true;
  const before = new Set(prev.commits.map((c) => c.hash));
  return next.commits.some((c) => !before.has(c.hash));
}

/** Switching straight from one open tool to another (not opening or closing the drawer). */
export function isToolSwap<T>(prev: T | null, next: T | null): boolean {
  return prev !== null && next !== null && prev !== next;
}

/** Runs on Windows? (The terminal's commands go to cmd.exe there.) */
export function onWindows(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /Windows/i.test(userAgent);
}

/** What the terminal suggests trying, in the shell that will actually run it. */
export function shellHints(windows: boolean): { intro: string; placeholder: string } {
  return windows
    ? {
        intro: "Each command runs with cmd.exe, starting in the repository folder. Try `dir` or `git status`.",
        placeholder: "git status",
      }
    : {
        intro: "Each command runs in a fresh shell, starting in the repository folder. Try `ls` or `git status`.",
        placeholder: "git status",
      };
}

/**
 * A `cd` on its own does nothing here: every command starts again in the repository
 * folder. (A chained `cd src && dir` still works, so that is left alone.)
 */
export function isBareCd(command: string): boolean {
  const cmd = command.trim();
  if (!/^(cd|chdir|pushd)(\s|$|\/|\\|\.)/i.test(cmd)) return false;
  return !/&&|\|\||[;&|]/.test(cmd);
}

/** The terminal's answer to a bare `cd`, with an example that does work. */
export function cdHint(command: string, windows: boolean): string {
  const dir = command.trim().replace(/^(cd|chdir|pushd)\s*(\/d\s+)?/i, "").trim() || "src";
  const list = windows ? "dir" : "ls";
  return `Each command starts in the repository folder, so cd doesn't carry over to the next one. Chain it instead: cd ${dir} && ${list}`;
}
