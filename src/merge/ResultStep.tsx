import { useEffect, useRef, useState } from "react";
import { aiErrorMessage } from "../ai/aiService";
import { errorMessage, exportGraph } from "../backend";
import { analyze, reviewBlast, type Blast, type Finding } from "../push/blast";
import { BlastMap } from "../push/BlastMap";
import "../push/push.css";
import type { MergeResult } from "./types";
import { ZoomPan } from "./ZoomPan";

interface Props {
  repoPath: string;
  result: MergeResult;
  onClose: () => void;
}

export function ResultStep({ repoPath, result, onClose }: Props) {
  const [blast, setBlast] = useState<Blast | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [aiError, setAiError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function viewBlast() {
    setBusy(true);
    setError("");
    setAiError("");
    setFindings(null);
    try {
      const graph = result.graph ?? (await exportGraph(repoPath)).graph;
      const b = await analyze(repoPath, graph, result.diff);
      if (!alive.current) return;
      setBlast(b);
      try {
        const f = await reviewBlast(b);
        if (alive.current) setFindings(f);
      } catch (e) {
        if (alive.current) setAiError(aiErrorMessage(e));
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const reviewing = blast !== null && findings === null && !aiError;
  const high = findings?.some((f) => f.severity === "high");

  return (
    <div className="merge-body">
      <div className="merge-note ok merge-done">
        <h3>
          Merged {result.source} into {result.target}
        </h3>
        <p>
          New merge commit <code title={result.hash}>{result.hash ? result.hash.slice(0, 10) : "(hash unavailable)"}</code>
        </p>
      </div>

      <ul className="merge-counts" aria-label="How the functions were merged">
        <li className="merge-count ok">
          <b>{result.byHand}</b> resolved by hand
        </li>
        <li className="merge-count warn">
          <b>{result.byAi}</b> by AI suggestion
        </li>
        <li className="merge-count">
          <b>{result.autoMerged}</b> auto-merged by git
        </li>
      </ul>

      {result.skipped.length > 0 && (
        <div className="merge-note warn">
          <b>Not applied:</b>
          <ul>
            {result.skipped.map((s) => (
              <li key={s.id}>
                {s.label}: {s.reason}
              </li>
            ))}
          </ul>
          <p>Git merged these without a conflict, so what you wrote for them was not used.</p>
        </div>
      )}

      {error && <div className="merge-note bad" role="alert">{error}</div>}

      {!blast && (
        <div className="merge-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void viewBlast()}>
            {busy ? "Mapping…" : "View blast radius"}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {busy && !blast && (
        <div className="merge-busy" role="progressbar" aria-label="Mapping what the merge touches">
          <div className="progress" />
        </div>
      )}

      {blast && (
        <>
          <div className="merge-blast">
            <ZoomPan>
              <BlastMap blast={blast} findings={findings} />
            </ZoomPan>
          </div>
          {!blast.hasCallGraph && (
            <div className="merge-note warn">Call graph unavailable for these files, so only the changed functions are shown.</div>
          )}
          {blast.nodes.length === 0 && <div className="merge-note">The merge commit changed no functions.</div>}
          {reviewing && <div className="merge-note">Checking for bugs with the local model…</div>}
          {aiError && <div className="merge-note warn">AI review unavailable: {aiError}</div>}
          {findings && findings.length === 0 && <div className="merge-note ok">No issues found.</div>}
          {findings && findings.length > 0 && (
            <div className={`merge-note ${high ? "bad" : "warn"}`}>
              {findings.length} possible {findings.length === 1 ? "bug" : "bugs"}:
              <ul>
                {findings.map((f, i) => (
                  <li key={i}>
                    <b>{f.function}</b> <span className="merge-soft">{f.file}{f.line ? `:${f.line}` : ""}</span>: {f.problem}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="merge-actions">
            <button type="button" className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}