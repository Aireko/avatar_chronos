import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { errorMessage, type ChronosGraph } from "../backend";
import { aiErrorMessage } from "../ai/aiService";
import { Presence } from "../tools/Presence";
import { analyze, listDelay, reviewBlast, type Blast, type Finding } from "./blast";
import { BlastMap } from "./BlastMap";
import { branchNames, commitAll, pullFrom, pushTo } from "./git";
import "./push.css";

const NEW = "__new__";
/** How long the dialog takes to lift away (.push-overlay.is-leaving in push.css). */
const EXIT_MS = 160;

interface Props {
  repoPath: string;
  graph: ChronosGraph;
  currentBranch: string | null;
  onGraphChange: (g: ChronosGraph) => void;
  onClose: () => void;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Everything the keyboard can reach inside `root`, in order. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button, select, textarea, input, a[href], [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
}

/** A little blast radius in pen: the change in the middle, lines out to its neighbours. */
function BlastDoodle() {
  return (
    <svg
      className="doodle push-doodle"
      viewBox="0 0 160 90"
      width={160}
      height={90}
      fill="none"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path className="d-ink" pathLength={1} d="M73 41.6c-15-1.4-26-15.6-43-16.8" />
      <path className="d-ink" pathLength={1} d="M73 48.6c-14.6 1.6-25.4 16-42.6 16.8" />
      <path className="d-pen-a" pathLength={1} d="M87 41.4c15.4-1 25.6-15.8 43.2-16.4" />
      <path className="d-pen-a" pathLength={1} d="M87 48.8c14.8 1.2 25.2 15.4 42.8 16.6" />
      <circle className="d-dot d-ink" cx="24" cy="24.6" r="5.2" />
      <circle className="d-dot d-ink" cx="24.4" cy="65.6" r="5.2" />
      <circle className="d-dot d-ink push-d-core" cx="80" cy="45" r="7.4" />
      <circle className="d-dot d-pen-a" cx="135.6" cy="24.8" r="5.2" />
      <circle className="d-dot d-pen-a" cx="135.4" cy="65.8" r="5.2" />
    </svg>
  );
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
  const [closing, setClosing] = useState(false);
  const alive = useRef(true);
  const card = useRef<HTMLDivElement>(null);
  // Whatever had focus when the dialog opened (the Push to Git key) gets it back on close.
  const [opener] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // The app passes a fresh onClose each render; the exit timer calls whichever is current.
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });
  const ids = useId();
  const dest = target === NEW ? newName.trim() : target;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Closed from outside (App's own Esc) or focus fell to the page: hand it back.
      if (!document.activeElement || document.activeElement === document.body) restoreFocus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function restoreFocus() {
    if (opener?.isConnected && !opener.closest("[inert],[hidden]") && !(opener as HTMLButtonElement).disabled) {
      opener.focus({ preventScroll: true });
    }
  }

  /** Lifts the dialog away, then tells the app it is closed. */
  function close() {
    if (closing) return;
    setClosing(true);
    restoreFocus();
  }
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => latestClose.current(), prefersReducedMotion() ? 0 : EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // Each step keeps the keyboard in the dialog: the form focuses its message box itself;
  // when the step's own key goes away (computing, then the result), the card takes focus.
  useEffect(() => {
    if (step === "form") return;
    const el = card.current;
    const active = document.activeElement;
    if (el && (!active || active === document.body || !el.contains(active))) el.focus({ preventScroll: true });
  }, [step]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const el = card.current;
    if (!el) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Esc in a field with something typed in it steps out of the field first, so a
      // stray key doesn't throw the message away; the next Esc closes.
      const t = e.target;
      if ((t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) && t.value.trim()) {
        el.focus({ preventScroll: true });
        return;
      }
      close();
    } else if (e.key === "Tab") {
      // Keep the keyboard inside the dialog.
      const items = tabbables(el);
      const active = document.activeElement;
      if (items.length === 0) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      } else if (e.shiftKey && (active === items[0] || active === el)) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && active === items[items.length - 1]) {
        e.preventDefault();
        items[0].focus();
      }
    }
  }

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
      close();
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
  const pushLabel = pushing ? "Pushing…" : findings && findings.length > 0 ? "Push anyway" : "Push";
  const verdict = reviewing ? "reviewing" : aiError ? "unavailable" : findings?.length ? "found" : "clear";

  return (
    <Presence show={!closing} className="push-overlay" exitMs={EXIT_MS}>
      <div
        ref={card}
        className="push-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="push-head">
          <h2 id={`${ids}-title`}>
            <span className="push-title-mark">Push to Git</span>
          </h2>
          <button type="button" className="btn" onClick={close}>Close</button>
        </div>

        {error && (
          // Keyed by the message, so a new one nudges in (like the app's banner).
          <div key={error} className="push-note bad push-error" role="alert">
            {error}
          </div>
        )}

        {/* Keyed by the step, so each one swaps in instead of snapping. */}
        <div key={step} className="push-step">
          {step === "form" && (
            <>
              <label className="push-label" htmlFor={`${ids}-message`}>Commit message</label>
              <textarea
                id={`${ids}-message`}
                className="push-text"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.currentTarget.value)}
                placeholder="What did you change?"
                autoFocus
              />
              <label className="push-label" htmlFor={`${ids}-branch`}>Push to branch</label>
              <select
                id={`${ids}-branch`}
                className="field"
                value={target}
                onChange={(e) => setTarget(e.currentTarget.value)}
              >
                {!branches.includes(target) && target !== NEW && <option value={target}>{target}</option>}
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                <option value={NEW}>+ New branch…</option>
              </select>
              {target === NEW && (
                <input
                  className="field push-new-branch"
                  aria-label="New branch name"
                  value={newName}
                  onChange={(e) => setNewName(e.currentTarget.value)}
                  placeholder="new-branch-name"
                  spellCheck={false}
                />
              )}
              <div className="push-actions">
                <button type="button" className="btn primary" disabled={!dest} onClick={() => void viewBlast()}>
                  View blast radius
                </button>
              </div>
            </>
          )}

          {step === "working" && (
            <div className="push-working">
              <BlastDoodle />
              <p className="push-status" role="status">
                {/* Keyed so each new stage ticks in, like the status bar's figures. */}
                <span key={status} className="push-status-text">{status}</span>
              </p>
            </div>
          )}

          {step === "result" && blast && (
            <>
              <BlastMap blast={blast} findings={findings} reviewing={reviewing} />
              {!blast.hasCallGraph && (
                <div className="push-note warn push-rise">
                  Call graph unavailable for these files, so only the changed functions are shown.
                </div>
              )}
              {/* One live region; the verdict inside swaps in when the model answers. */}
              <div aria-live="polite">
                <div key={verdict} className="push-verdict">
                  {reviewing && (
                    <div className="push-note push-reviewing">
                      <span className="working-dot" aria-hidden="true" />
                      Checking for bugs with the local model…
                    </div>
                  )}
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
                        <div
                          key={i}
                          className={`push-finding ${f.severity}`}
                          style={{ "--d": `${listDelay(i + 1)}ms` } as CSSProperties}
                        >
                          <b>{f.function}</b>{" "}
                          <span className="push-where">{f.file}{f.line ? `:${f.line}` : ""}</span>
                          <p>{f.problem}</p>
                          {f.affects.length > 0 && <p className="push-affects">Affects: {f.affects.join(", ")}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="push-actions push-result-actions">
                <span className="push-target">→ origin/{dest}</span>
                {canPull && (
                  <button type="button" className="btn push-pull" disabled={pushing} onClick={() => void pullIt()}>
                    Pull
                  </button>
                )}
                <button
                  type="button"
                  className="btn primary push-go"
                  disabled={pushing || reviewing}
                  onClick={() => void push()}
                >
                  {pushing && <span className="working-dot" aria-hidden="true" />}
                  {/* Keyed so "Push anyway" and "Pushing…" tick in when they take over. */}
                  <span key={pushLabel} className="push-go-label">{pushLabel}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Presence>
  );
}
