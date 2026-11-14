import { EMPTY_STATE, conflictLabel, panesOf, shortDiff } from "./resolution";
import type { ConflictItem, ConflictState, RunState } from "./types";

interface Props {
  items: ConflictItem[];
  states: Record<string, ConflictState>;
  source: string;
  target: string;
  /** Functions git merges by itself (clean + auto-resolvable). */
  leftToGit: number;
  message: string;
  run: RunState;
  onMessage: (message: string) => void;
  onBack: () => void;
  onApply: () => void;
  onAbort: () => void;
  onRetryAbort: () => void;
}

export function ApplyStep({ items, states, source, target, leftToGit, message, run, onMessage, onBack, onApply, onAbort, onRetryAbort }: Props) {
  const allResolved = items.every((it) => states[it.id]?.resolved === true);
  const running = run.phase === "running";

  return (
    <div className="merge-body">
      {run.phase === "failed" && run.failure && (
        <div className="merge-note bad" role="alert">
          <b>The merge didn't complete.</b>
          <pre className="merge-pre">{run.failure.message}</pre>
          {run.failure.aborted && <p>The merge was aborted (git merge --abort). Your branch is as it was before.</p>}
          {!run.failure.aborted && run.failure.abortError && (
            <>
              <p>Aborting failed: {run.failure.abortError}</p>
              <button type="button" className="btn" onClick={onRetryAbort}>
                Abort merge
              </button>
            </>
          )}
          {!run.failure.aborted && !run.failure.abortError && <p>No merge was started, so nothing needs undoing.</p>}
        </div>
      )}

      {running ? (
        <div aria-live="polite">
          <div className="merge-busy" role="progressbar" aria-label="Applying the merge">
            <div className="progress" />
          </div>
          <ol className="merge-log">
            {run.log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
          <div className="merge-actions">
            <button type="button" className="btn" disabled={run.aborting} onClick={onAbort}>
              {run.aborting ? "Aborting…" : "Abort merge"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="merge-lead">
            {items.length === 0
              ? `No conflicts to resolve: git will merge ${leftToGit} ${leftToGit === 1 ? "function" : "functions"} on its own.`
              : `${items.length} resolved ${items.length === 1 ? "function" : "functions"} will be written into the merge; git merges the other ${leftToGit} by itself.`}
          </p>

          {items.map((it) => {
            const st = states[it.id] ?? EMPTY_STATE;
            const before = panesOf(it, st.versions)?.ours ?? "";
            const rows = shortDiff(before, st.text);
            const changed = rows.some((r) => r.kind === "added" || r.kind === "removed");
            return (
              <section key={it.id} className="merge-review">
                <header>
                  <b>{conflictLabel(it.conflict)}</b> <span className="merge-soft">{it.conflict.filePath}</span>{" "}
                  <span className={`merge-badge ${st.origin === "ai" ? "warn" : "ok"}`}>
                    {st.origin === "ai" ? "AI suggestion" : "by hand"}
                  </span>
                </header>
                <div className="merge-diff" role="group" aria-label={`Change to ${target} for ${conflictLabel(it.conflict)}`}>
                  {!changed && <div className="merge-diff-row gap">Same as {target}.</div>}
                  {changed &&
                    rows.map((r, i) =>
                      r.kind === "gap" ? (
                        <div key={i} className="merge-diff-row gap">
                          … {r.hidden} unchanged {r.hidden === 1 ? "line" : "lines"}
                        </div>
                      ) : (
                        <div key={i} className={`merge-diff-row ${r.kind === "added" ? "add" : r.kind === "removed" ? "del" : ""}`}>
                          <span aria-hidden>{r.kind === "added" ? "+" : r.kind === "removed" ? "−" : " "}</span>
                          <code>{r.text === "" ? " " : r.text}</code>
                        </div>
                      ),
                    )}
                </div>
              </section>
            );
          })}

          <label className="merge-label" htmlFor="merge-message">
            Commit message
          </label>
          <textarea
            id="merge-message"
            className="merge-result"
            rows={3}
            value={message}
            spellCheck={false}
            onChange={(e) => onMessage(e.currentTarget.value)}
          />

          <p className="merge-soft">
            Applying merges {source} into {target} with no fast-forward, checking out {target} first if needed, and
            stops if your working tree isn't clean. Any failure runs <code>git merge --abort</code>.
          </p>

          <div className="merge-actions">
            <button type="button" className="btn" onClick={onBack}>
              Back
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!allResolved || message.trim() === ""}
              title={allResolved ? undefined : "Resolve every true collision first"}
              onClick={onApply}
            >
              Apply merge
            </button>
          </div>
        </>
      )}
    </div>
  );
}