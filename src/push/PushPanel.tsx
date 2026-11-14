import { useEffect, useRef, useState } from "react";
import { errorMessage, type ChronosGraph } from "../backend";
import { aiErrorMessage } from "../ai/aiService";
import { analyze, reviewBlast, type Blast, type Finding } from "./blast";
import { BlastMap } from "./BlastMap";
import { branchNames, commitAll, pullFrom, pushTo } from "./git";
import "./push.css";

const NEW = "__new__";

interface Props {
  repoPath: string;
  graph: ChronosGraph;
  currentBranch: string | null;
  onGraphChange: (g: ChronosGraph) => void;
  onClose: () => void;
}

export function PushPanel({ repoPath, graph, currentBranch, onGraphChange, onClose }: Props) {
  const branches = branchNames(graph);
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState(currentBranch ?? branches[0] ?? "");
  const [newName, setNewName] = useState("");
  const [step, setStep] = useState<"form" | "working" | "result">("form");
  const [status, setStatus] = useState("");
  const [blast, setBlast] = useState<Blast | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [aiError, setAiError] = useState("");
  const [error, setError] = useState("");
  const [pushing, setPushing] = useState(false);
  const [canPull, setCanPull] = useState(false);
  const alive = useRef(true);
  const dest = target === NEW ? newName.trim() : target;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function viewBlast() {
    setError("");
    setAiError("");
    setFindings(null);
    setStep("working");
    try {
      setStatus("Committing your changes…");
      const { graph: next } = await commitAll(repoPath, message.trim());
      onGraphChange(next);
      setStatus("Mapping what this change touches…");
      const b = await analyze(repoPath, next);
      if (!alive.current) return;
      setBlast(b);
      setStep("result");
      try {
        const f = await reviewBlast(b);
        if (alive.current) setFindings(f);
      } catch (e) {
        if (alive.current) setAiError(aiErrorMessage(e));
      }
    } catch (e) {
      if (!alive.current) return;
      setError(errorMessage(e));
      setStep("form");
    }
  }

  async function push() {
    setPushing(true);
    setError("");
    setCanPull(false);
    try {
      onGraphChange(await pushTo(repoPath, dest));
      onClose();
    } catch (e) {
      const msg = errorMessage(e);
      if (/non-fast-forward|rejected|fetch first/i.test(msg)) {
        if (dest === currentBranch) {
          setError(`Push rejected: origin/${dest} has commits you don't have yet. Pull them, then push again.`);
          setCanPull(true);
        } else {
          setError(
            `Push rejected: your current commit is behind origin/${dest}, so pushing ${currentBranch ?? "HEAD"} there would overwrite it. ` +
              `Switch to ${dest} first, or choose a different target branch.`,
          );
        }
      } else {
        setError(msg);
      }
      setPushing(false);
    }
  }

  async function pullIt() {
    setPushing(true);
    setError("");
    try {
      onGraphChange(await pullFrom(repoPath, dest));
      setCanPull(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPushing(false);
    }
  }

  const reviewing = step === "result" && findings === null && !aiError;
  const high = findings?.some((f) => f.severity === "high");

  return (
    <div className="push-overlay" role="dialog" aria-label="Push to Git">
      <div className="push-card">
        <div className="push-head">
          <h2>Push to Git</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {error && <div className="push-note bad">{error}</div>}

        {step === "form" && (
          <>
            <label className="push-label">Commit message</label>
            <textarea
              className="push-text"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.currentTarget.value)}
              placeholder="What did you change?"
              autoFocus
            />
            <label className="push-label">Push to branch</label>
            <select className="field" value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
              {!branches.includes(target) && target !== NEW && <option value={target}>{target}</option>}
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              <option value={NEW}>+ New branch…</option>
            </select>
            {target === NEW && (
              <input
                className="field"
                style={{ marginTop: 8 }}
                value={newName}
                onChange={(e) => setNewName(e.currentTarget.value)}
                placeholder="new-branch-name"
                spellCheck={false}
              />
            )}
            <div className="push-actions">
              <button className="btn primary" disabled={!dest} onClick={() => void viewBlast()}>
                View blast radius
              </button>
            </div>
          </>
        )}

        {step === "working" && (
          <div className="push-working">
            <div className="progress" />
            <p>{status}</p>
          </div>
        )}

        {step === "result" && blast && (
          <>
            <BlastMap blast={blast} findings={findings} />
            {!blast.hasCallGraph && (
              <div className="push-note warn">
                Call graph unavailable for these files, so only the changed functions are shown.
              </div>
            )}
            {reviewing && <div className="push-note">Checking for bugs with the local model…</div>}
            {aiError && <div className="push-note warn">AI review unavailable: {aiError}</div>}
            {findings && findings.length === 0 && (
              <div className="push-note ok">No issues found. Nothing this change touches looks broken.</div>
            )}
            {findings && findings.length > 0 && (
              <div className="push-findings">
                <div className={`push-note ${high ? "bad" : "warn"}`}>
                  {findings.length} possible {findings.length === 1 ? "bug" : "bugs"} found
                </div>
                {findings.map((f, i) => (
                  <div key={i} className={`push-finding ${f.severity}`}>
                    <b>{f.function}</b>{" "}
                    <span className="push-where">{f.file}{f.line ? `:${f.line}` : ""}</span>
                    <p>{f.problem}</p>
                    {f.affects.length > 0 && <p className="push-affects">Affects: {f.affects.join(", ")}</p>}
                  </div>
                ))}
              </div>
            )}
            <div className="push-actions">
              <span className="push-target">→ origin/{dest}</span>
              {canPull && (
                <button className="btn" disabled={pushing} onClick={() => void pullIt()}>
                  Pull
                </button>
              )}
              <button className="btn primary" disabled={pushing || reviewing} onClick={() => void push()}>
                {pushing ? "Pushing…" : findings && findings.length > 0 ? "Push anyway" : "Push"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}