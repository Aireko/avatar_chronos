import { isValidBranchName } from "./resolution";

interface Props {
  branches: string[];
  /** Branches left out of the lists because git wouldn't accept their names from here. */
  hiddenBranches: number;
  source: string;
  target: string;
  loading: boolean;
  /** null while checking; true when a merge is already open in the repository. */
  mergeInProgress: boolean | null;
  aborting: boolean;
  onSource: (name: string) => void;
  onTarget: (name: string) => void;
  onPreview: () => void;
  onAbortOpenMerge: () => void;
}

export function SetupStep({
  branches,
  hiddenBranches,
  source,
  target,
  loading,
  mergeInProgress,
  aborting,
  onSource,
  onTarget,
  onPreview,
  onAbortOpenMerge,
}: Props) {
  const same = source !== "" && source === target;
  const invalid = (source !== "" && !isValidBranchName(source)) || (target !== "" && !isValidBranchName(target));
  const ready = source !== "" && target !== "" && !same && !invalid;

  return (
    <div className="merge-body merge-setup">
      <p className="merge-lead">
        See what merging one branch into another would do, function by function, before anything changes.
      </p>

      {mergeInProgress && (
        <div className="merge-note warn" role="alert">
          <p>
            A merge is already open in this repository (it was started outside Merge Doctor, or interrupted). Finish
            it in the Terminal, or abort it to start over.
          </p>
          <button type="button" className="btn" disabled={aborting} onClick={onAbortOpenMerge}>
            {aborting ? "Aborting…" : "Abort merge"}
          </button>
        </div>
      )}

      <div className="merge-form">
        <label className="merge-field">
          <span className="merge-label">Merge this branch (source / theirs)</span>
          <select className="field" value={source} onChange={(e) => onSource(e.currentTarget.value)} disabled={loading}>
            <option value="" disabled>
              Choose a branch…
            </option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        <span className="merge-arrow" aria-hidden>
          →
        </span>

        <label className="merge-field">
          <span className="merge-label">Into this branch (target / ours)</span>
          <select className="field" value={target} onChange={(e) => onTarget(e.currentTarget.value)} disabled={loading}>
            <option value="" disabled>
              Choose a branch…
            </option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>

      {same && <div className="merge-note warn">Pick two different branches.</div>}
      {hiddenBranches > 0 && (
        <div className="merge-note">
          {hiddenBranches} {hiddenBranches === 1 ? "branch isn't" : "branches aren't"} listed: names may only use
          letters, digits, <code>. _ / -</code>, and can't start with <code>-</code>.
        </div>
      )}

      {loading && (
        <div className="merge-busy" role="progressbar" aria-label="Analysing the merge">
          <div className="progress" />
        </div>
      )}

      <div className="merge-actions">
        <button type="button" className="btn primary" disabled={!ready || loading} onClick={onPreview}>
          {loading ? "Analysing…" : "Preview merge"}
        </button>
      </div>
    </div>
  );
}