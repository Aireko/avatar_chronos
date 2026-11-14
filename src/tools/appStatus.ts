// Pure decisions behind two bits of the app shell's status: tools working in the
// background (the toolbar's busy dots) and a merge or rebase paused on a conflict.
// Kept apart from App.tsx so they can be tested without a DOM.

/** A git operation stopped half way, waiting to be continued or aborted. */
export type PausedOp = "rebase" | "merge";

/**
 * Which operation is paused, from whether REBASE_HEAD and MERGE_HEAD exist. A rebase
 * wins: its way out (continue / abort) is the one git will ask for first.
 */
export function pausedOp(rebaseHead: boolean, mergeHead: boolean): PausedOp | null {
  if (rebaseHead) return "rebase";
  if (mergeHead) return "merge";
  return null;
}

/** What the banner for a paused operation says, and what its keys read. */
export function pauseCopy(op: PausedOp): { label: string; title: string; help: string; abort: string } {
  return op === "rebase"
    ? {
        label: "Rebase paused",
        title: "A rebase is paused on a conflict.",
        help: "then continue. Or abort to put everything back.",
        abort: "Abort rebase",
      }
    : {
        label: "Merge paused",
        title: "A merge is paused on a conflict.",
        help: "then continue to make the merge commit. Or abort to put everything back.",
        abort: "Abort merge",
      };
}

/** What the status bar says about where HEAD is. */
export function headText(branch: string | null, paused: PausedOp | null): string {
  if (branch) return paused === "merge" ? `On ${branch} (merging)` : `On ${branch}`;
  return paused === "rebase" ? "Rebasing (paused)" : "Detached HEAD";
}

/**
 * The set of busy tools with `id` marked busy or idle. Returns the same set when
 * nothing changed, so a repeated report doesn't re-render the toolbar.
 */
export function withBusy<T>(set: ReadonlySet<T>, id: T, busy: boolean): ReadonlySet<T> {
  if (set.has(id) === busy) return set;
  const next = new Set(set);
  if (busy) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * When a tool's work stops: what to tell screen readers, if anything. Only when the
 * tool really was working and its pane is out of sight (the user isn't watching it).
 */
export function busyFinishedNote(label: string, wasBusy: boolean, nowBusy: boolean, inView: boolean): string | null {
  if (!wasBusy || nowBusy || inView) return null;
  return `${label} finished working.`;
}
