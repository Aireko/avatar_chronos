import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage, type ChronosGraph } from "../backend";
import { ApplyStep } from "./ApplyStep";
import { abortMerge, applyMerge, isMergeInProgress, previewMerge } from "./mergeGit";
import { ResolverStep } from "./ResolverStep";
import { ResultStep } from "./ResultStep";
import { EMPTY_STATE, collisionItems, conflictLabel, isValidBranchName, panesOf } from "./resolution";
import { SetupStep } from "./SetupStep";
import { SummaryStep } from "./SummaryStep";
import type { ConflictState, MergeResult, Preview, ResolvedEntry, RunState, Step } from "./types";
import "./merge.css";

interface Props {
  repoPath: string;
  graph: ChronosGraph;
  currentBranch: string | null;
  onGraphChange: (graph: ChronosGraph) => void;
  onClose: () => void;
}

const STEPS: { id: Step; label: string }[] = [
  { id: "setup", label: "Branches" },
  { id: "summary", label: "Summary" },
  { id: "resolver", label: "Resolve" },
  { id: "apply", label: "Apply" },
  { id: "result", label: "Done" },
];

const IDLE: RunState = { phase: "idle", log: [], aborting: false, failure: null };

export function MergeDoctor({ repoPath, graph, currentBranch, onGraphChange, onClose }: Props) {
  const branches = useMemo(() => graph.branches.map((b) => b.name).filter(isValidBranchName), [graph]);
  const hiddenBranches = graph.branches.length - branches.length;

  const [step, setStep] = useState<Step>("setup");
  const [source, setSource] = useState(() => branches.find((b) => b !== currentBranch) ?? "");
  const [target, setTarget] = useState(() => (currentBranch && branches.includes(currentBranch) ? currentBranch : (branches[0] ?? "")));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [states, setStates] = useState<Record<string, ConflictState>>({});
  const [index, setIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [run, setRun] = useState<RunState>(IDLE);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [openMerge, setOpenMerge] = useState<boolean | null>(null);
  const [abortingOpen, setAbortingOpen] = useState(false);

  const alive = useRef(true);
  const abortRequested = useRef(false);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    const before = document.activeElement;
    card.current?.focus();
    isMergeInProgress(repoPath).then(
      (open) => alive.current && setOpenMerge(open),
      (e: unknown) => alive.current && setError(errorMessage(e)),
    );
    return () => {
      alive.current = false;
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [repoPath]);

  const patch = useCallback((id: string, change: Partial<ConflictState>) => {
    setStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_STATE), ...change } }));
  }, []);

  const items = preview?.items ?? [];
  const running = run.phase === "running";
  const hasWork = Object.values(states).some((s) => s.resolved || s.text !== "");
  const leftToGit = preview ? preview.analysis.conflicts.filter((c) => c.resolutionStatus !== "TRUE_COLLISION").length : 0;

  /* ---------- close ---------- */

  function requestClose() {
    if (step === "result" || (!running && !(hasWork && step !== "setup"))) onClose();
    else setConfirmClose(true);
  }

  function confirmedClose() {
    // A running merge aborts itself at its next step; it keeps going without this panel.
    if (running) abortRequested.current = true;
    onClose();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (confirmClose) setConfirmClose(false);
      else requestClose();
    }
    // Nothing typed here may reach the app's own shortcuts (Esc, arrows, Ctrl+F) behind the panel.
    e.stopPropagation();
  }

  /* ---------- preview ---------- */

  async function runPreview() {
    setError("");
    if (!isValidBranchName(source) || !isValidBranchName(target)) {
      setError("Branch names may only use letters, digits, . _ / and -, and can't start with -.");
      return;
    }
    if (source === target) {
      setError("Pick two different branches.");
      return;
    }
    setLoading(true);
    try {
      const { graph: g } = await previewMerge(repoPath, source, target);
      if (!alive.current) return;
      const analysis = g.mergeAnalysis;
      const tip = (name: string) => g.branches.find((b) => b.name === name)?.commitHash ?? null;
      const signature = [source, target, analysis.mergeBase, tip(source), tip(target)].join("|");
      const same = preview?.signature === signature;
      setPreview({
        source,
        target,
        analysis,
        items: collisionItems(analysis.conflicts),
        sourceTip: tip(source),
        targetTip: tip(target),
        signature,
      });
      if (!same) {
        setStates({});
        setIndex(0);
        setMessage(`Merge ${source} into ${target}`);
      }
      setStep("summary");
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  async function abortOpenMerge() {
    setAbortingOpen(true);
    setError("");
    try {
      const g = await abortMerge(repoPath);
      if (g) onGraphChange(g);
      if (alive.current) setOpenMerge(false);
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setAbortingOpen(false);
    }
  }

  /* ---------- apply ---------- */

  function buildEntries(): ResolvedEntry[] {
    return items.map((it) => {
      const st = states[it.id] ?? EMPTY_STATE;
      const missing = st.versions?.missing;
      return {
        id: it.id,
        label: conflictLabel(it.conflict),
        filePath: it.conflict.filePath,
        fileLevel: it.fileLevel,
        deleteFile: it.fileLevel && st.text.trim() === "" && missing !== undefined && (missing.ours || missing.theirs),
        oursSnippet: panesOf(it, st.versions)?.ours ?? it.conflict.oursSnippet,
        theirsSnippet: panesOf(it, st.versions)?.theirs ?? it.conflict.theirsSnippet,
        text: st.text,
      };
    });
  }

  async function apply() {
    if (!preview) return;
    abortRequested.current = false;
    setRun({ phase: "running", log: [], aborting: false, failure: null });
    const outcome = await applyMerge(
      { repoPath, source: preview.source, target: preview.target, message, entries: buildEntries() },
      {
        onStep: (label) => {
          if (alive.current) setRun((r) => ({ ...r, log: [...r.log, label] }));
        },
        shouldAbort: () => abortRequested.current,
      },
    );
    // The history changed (or was restored) even if this panel has been closed meanwhile.
    if (outcome.graph) onGraphChange(outcome.graph);
    if (!alive.current) return;

    if (outcome.kind === "committed") {
      const applied = new Set(outcome.applied);
      const origin = (id: string) => states[id]?.origin;
      setResult({
        source: preview.source,
        target: preview.target,
        hash: outcome.hash,
        byHand: items.filter((it) => applied.has(it.id) && origin(it.id) !== "ai").length,
        byAi: items.filter((it) => applied.has(it.id) && origin(it.id) === "ai").length,
        autoMerged: leftToGit,
        skipped: outcome.skipped,
        graph: outcome.graph,
        diff: outcome.diff,
      });
      setRun(IDLE);
      setStep("result");
    } else if (outcome.kind === "nothing") {
      setRun({ phase: "failed", log: [], aborting: false, failure: { message: outcome.message, aborted: false, abortError: null } });
    } else if (outcome.kind === "cancelled") {
      setRun({
        phase: "failed",
        log: [],
        aborting: false,
        failure: { message: "Aborted at your request.", aborted: outcome.aborted, abortError: outcome.abortError },
      });
    } else {
      setRun({
        phase: "failed",
        log: [],
        aborting: false,
        failure: { message: outcome.message, aborted: outcome.aborted, abortError: outcome.abortError },
      });
    }
  }

  async function retryAbort() {
    try {
      const g = await abortMerge(repoPath);
      if (g) onGraphChange(g);
      if (alive.current) setRun((r) => (r.failure ? { ...r, failure: { ...r.failure, aborted: true, abortError: null } } : r));
    } catch (e) {
      if (alive.current) setRun((r) => (r.failure ? { ...r, failure: { ...r.failure, abortError: errorMessage(e) } } : r));
    }
  }

  function openResolver(itemId?: string) {
    const at = itemId ? items.findIndex((it) => it.id === itemId) : -1;
    if (at >= 0) setIndex(at);
    setStep("resolver");
  }

  return (
    <div className="merge-overlay" onKeyDown={onKeyDown}>
      <div className="merge-card" role="dialog" aria-modal="true" aria-labelledby="merge-title" tabIndex={-1} ref={card}>
        <header className="merge-head">
          <h2 id="merge-title">Merge Doctor</h2>
          <ol className="merge-steps" aria-label="Steps">
            {STEPS.map((s) => (
              <li key={s.id} className={s.id === step ? "is-on" : ""} aria-current={s.id === step ? "step" : undefined}>
                {s.label}
              </li>
            ))}
          </ol>
          <button type="button" className="btn" onClick={requestClose}>
            Close
          </button>
        </header>

        {confirmClose && (
          <div className="merge-note warn" role="alertdialog" aria-label="Close Merge Doctor?">
            <p>
              {running
                ? "A merge is in progress. Closing aborts it and restores your branch."
                : "You have unfinished resolutions. Closing discards them."}
            </p>
            <div className="merge-actions">
              <button type="button" className="btn" onClick={() => setConfirmClose(false)}>
                Keep working
              </button>
              <button type="button" className="btn primary" onClick={confirmedClose}>
                {running ? "Abort and close" : "Discard and close"}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="merge-note bad" role="alert">
            {error}
          </div>
        )}

        {step === "setup" && (
          <SetupStep
            branches={branches}
            hiddenBranches={hiddenBranches}
            source={source}
            target={target}
            loading={loading}
            mergeInProgress={openMerge}
            aborting={abortingOpen}
            onSource={setSource}
            onTarget={setTarget}
            onPreview={() => void runPreview()}
            onAbortOpenMerge={() => void abortOpenMerge()}
          />
        )}

        {step === "summary" && preview && (
          <SummaryStep preview={preview} onBack={() => setStep("setup")} onResolve={openResolver} onMergeNow={() => setStep("apply")} />
        )}

        {step === "resolver" && preview && items.length > 0 && (
          <ResolverStep
            repoPath={repoPath}
            items={items}
            states={states}
            mergeBase={preview.analysis.mergeBase}
            source={preview.source}
            target={preview.target}
            index={Math.min(index, items.length - 1)}
            onIndex={setIndex}
            onPatch={patch}
            onBack={() => setStep("summary")}
            onContinue={() => setStep("apply")}
          />
        )}

        {step === "apply" && preview && (
          <ApplyStep
            items={items}
            states={states}
            source={preview.source}
            target={preview.target}
            leftToGit={leftToGit}
            message={message}
            run={run}
            onMessage={setMessage}
            onBack={() => {
              setRun(IDLE);
              setStep(items.length > 0 ? "resolver" : "summary");
            }}
            onApply={() => void apply()}
            onAbort={() => {
              abortRequested.current = true;
              setRun((r) => ({ ...r, aborting: true }));
            }}
            onRetryAbort={() => void retryAbort()}
          />
        )}

        {step === "result" && result && <ResultStep repoPath={repoPath} result={result} onClose={onClose} />}
      </div>
    </div>
  );
}