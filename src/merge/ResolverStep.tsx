import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { aiErrorMessage, isAiError } from "../ai/aiService";
import { errorMessage } from "../backend";
import { suggestResolution } from "./mergeAi";
import { readRevisionFile, type RevisionFile } from "./mergeGit";
import { EMPTY_STATE, conflictLabel, panesOf } from "./resolution";
import { ThreePane } from "./ThreePane";
import type { ConflictItem, ConflictState, Confidence } from "./types";

type Patch = (id: string, patch: Partial<ConflictState>) => void;

interface Props {
  repoPath: string;
  items: ConflictItem[];
  states: Record<string, ConflictState>;
  mergeBase: string | null;
  source: string;
  target: string;
  index: number;
  onIndex: (index: number) => void;
  onPatch: Patch;
  onBack: () => void;
  onContinue: () => void;
}

type Quick = "ours" | "theirs" | "both";

const CONFIDENCE_TONE: Record<Confidence, "ok" | "warn" | "bad"> = { high: "ok", medium: "warn", low: "bad" };

const bothOf = (ours: string, theirs: string) =>
  [ours.replace(/\n+$/, ""), theirs.replace(/\n+$/, "")].filter((s) => s !== "").join("\n");

export function ResolverStep({ repoPath, items, states, mergeBase, source, target, index, onIndex, onPatch, onBack, onContinue }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const item = items[index];
  const state = states[item.id] ?? EMPTY_STATE;
  const panes = panesOf(item, state.versions);
  const resolved = items.filter((it) => states[it.id]?.resolved).length;
  const blocked = item.fileLevel && state.versions?.truncated === true;
  const allDone = resolved === items.length;

  useEffect(() => {
    root.current?.focus();
  }, []);

  useEffect(() => {
    root.current?.querySelector(".merge-side-item.is-active")?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  function quick(kind: Quick) {
    if (!panes || blocked) return;
    const text = kind === "ours" ? panes.ours : kind === "theirs" ? panes.theirs : bothOf(panes.ours, panes.theirs);
    onPatch(item.id, { text, origin: "hand" });
  }

  function go(next: number) {
    if (next >= 0 && next < items.length) onIndex(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const handled = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === "j" || e.key === "ArrowDown") handled(() => go(index + 1));
    else if (e.key === "k" || e.key === "ArrowUp") handled(() => go(index - 1));
    else if (e.key === "1") handled(() => quick("ours"));
    else if (e.key === "2") handled(() => quick("theirs"));
    else if (e.key === "3") handled(() => quick("both"));
  }

  return (
    <div className="merge-resolver" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
      <aside className="merge-side" aria-label="Conflicts">
        <div className="merge-progress">
          <div
            className="merge-meter"
            role="progressbar"
            aria-label="Conflicts resolved"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={resolved}
          >
            <span style={{ width: `${(resolved / items.length) * 100}%` }} />
          </div>
          <span>
            {resolved} of {items.length} resolved
          </span>
        </div>
        <ul>
          {items.map((it, i) => {
            const done = states[it.id]?.resolved === true;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  className={`merge-side-item${i === index ? " is-active" : ""}${done ? " is-done" : ""}`}
                  aria-current={i === index ? "true" : undefined}
                  onClick={() => go(i)}
                >
                  <span className="merge-side-mark" aria-hidden>
                    {done ? "✓" : "○"}
                  </span>
                  <span className="merge-side-text">
                    <b>{conflictLabel(it.conflict)}</b>
                    <small>{it.conflict.filePath}</small>
                  </span>
                  <span className="merge-visually-hidden">{done ? "resolved" : "unresolved"}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="merge-keys">
          <kbd>j</kbd>/<kbd>k</kbd> or arrows move · <kbd>1</kbd> ours · <kbd>2</kbd> theirs · <kbd>3</kbd> both
        </p>
      </aside>

      <div className="merge-main">
        <ConflictView
          key={item.id}
          repoPath={repoPath}
          item={item}
          state={state}
          position={`${index + 1} of ${items.length}`}
          mergeBase={mergeBase}
          source={source}
          target={target}
          panes={panes}
          blocked={blocked}
          onPatch={onPatch}
          quick={quick}
        />
        <div className="merge-actions">
          <button type="button" className="btn" onClick={onBack}>
            Back to summary
          </button>
          <button type="button" className="btn" disabled={index === 0} onClick={() => go(index - 1)}>
            Previous
          </button>
          <button type="button" className="btn" disabled={index === items.length - 1} onClick={() => go(index + 1)}>
            Next
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!allDone}
            title={allDone ? undefined : `${items.length - resolved} still to resolve`}
            onClick={onContinue}
          >
            Review and apply
          </button>
        </div>
      </div>
    </div>
  );
}

interface ViewProps {
  repoPath: string;
  item: ConflictItem;
  state: ConflictState;
  position: string;
  mergeBase: string | null;
  source: string;
  target: string;
  panes: { base: string; ours: string; theirs: string } | null;
  blocked: boolean;
  onPatch: Patch;
  quick: (kind: Quick) => void;
}

/** One conflict. Remounted per conflict, so leaving it (or closing the panel) cancels its AI request. */
function ConflictView({ repoPath, item, state, position, mergeBase, source, target, panes, blocked, onPatch, quick }: ViewProps) {
  const c = item.conflict;
  const [loadError, setLoadError] = useState("");
  const [ai, setAi] = useState<{ status: "idle" | "loading" | "error"; message: string }>({ status: "idle", message: "" });
  const abort = useRef<AbortController | null>(null);
  const textNow = useRef(state.text);
  textNow.current = state.text;

  useEffect(() => () => abort.current?.abort(), []);

  // A conflict with no snippets is resolved as a whole file: fetch the three versions once.
  const needsFiles = item.fileLevel && state.versions === null;
  useEffect(() => {
    if (!needsFiles) return;
    let live = true;
    const none: RevisionFile = { text: "", missing: true, truncated: false };
    Promise.all([
      mergeBase ? readRevisionFile(repoPath, mergeBase, c.filePath) : Promise.resolve(none),
      readRevisionFile(repoPath, target, c.filePath),
      readRevisionFile(repoPath, source, c.filePath),
    ]).then(
      ([b, o, t]) => {
        if (!live) return;
        onPatch(item.id, {
          versions: {
            base: b.text,
            ours: o.text,
            theirs: t.text,
            missing: { base: b.missing, ours: o.missing, theirs: t.missing },
            truncated: b.truncated || o.truncated || t.truncated,
          },
        });
      },
      (e: unknown) => {
        if (live) setLoadError(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [needsFiles, repoPath, mergeBase, source, target, c.filePath, item.id, onPatch]);

  async function ask() {
    if (!panes) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAi({ status: "loading", message: "" });
    try {
      const suggestion = await suggestResolution(
        {
          filePath: c.filePath,
          symbolName: c.symbolName,
          oursBranch: target,
          theirsBranch: source,
          base: panes.base,
          ours: panes.ours,
          theirs: panes.theirs,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setAi({ status: "idle", message: "" });
      // An empty result is pre-filled; one the user has started is never overwritten.
      onPatch(item.id, textNow.current.trim() === "" ? { suggestion, text: suggestion.resolution, origin: "ai" } : { suggestion });
    } catch (e) {
      if (controller.signal.aborted || (isAiError(e) && e.kind === "cancelled")) return;
      setAi({ status: "error", message: aiErrorMessage(e) });
    }
  }

  function cancelAsk() {
    abort.current?.abort();
    setAi({ status: "idle", message: "" });
  }

  const loadingFiles = needsFiles && !loadError;
  const missing = state.versions?.missing;
  const ready = panes !== null && !blocked;
  const empty = state.text.trim() === "";

  return (
    <div className="merge-conflict">
      <header className="merge-conflict-head">
        <h3>
          {conflictLabel(c)} <span className="merge-soft">{position}</span>
        </h3>
        <span className="merge-soft merge-path">{c.filePath}</span>
        <span className="merge-badge bad">True collision</span>
      </header>

      {loadError && (
        <div className="merge-note bad" role="alert">
          Couldn't read the file versions: {loadError}
        </div>
      )}
      {blocked && (
        <div className="merge-note bad" role="alert">
          This file is too large to resolve here. Abort and resolve it in the Terminal.
        </div>
      )}
      {loadingFiles && (
        <div className="merge-busy" role="progressbar" aria-label="Loading the file versions">
          <div className="progress" />
        </div>
      )}

      {panes && (
        <ThreePane
          base={panes.base}
          ours={panes.ours}
          theirs={panes.theirs}
          oursLabel={target}
          theirsLabel={source}
          oursStart={c.oursRange?.[0] ?? 1}
          theirsStart={c.theirsRange?.[0] ?? 1}
          baseNote={missing?.base ? "(file didn't exist here)" : undefined}
          oursNote={missing?.ours ? "(file doesn't exist on this branch)" : item.fileLevel ? undefined : "changed lines only"}
          theirsNote={missing?.theirs ? "(file doesn't exist on this branch)" : item.fileLevel ? undefined : "changed lines only"}
        />
      )}

      <div className="merge-toolbar" role="group" aria-label="Quick actions">
        <button type="button" className="btn" disabled={!ready} aria-keyshortcuts="1" onClick={() => quick("ours")}>
          Take ours
        </button>
        <button type="button" className="btn" disabled={!ready} aria-keyshortcuts="2" onClick={() => quick("theirs")}>
          Take theirs
        </button>
        <button type="button" className="btn" disabled={!ready} aria-keyshortcuts="3" onClick={() => quick("both")}>
          Take both
        </button>
        <button
          type="button"
          className="btn"
          disabled={state.text === "" && !state.resolved}
          onClick={() => onPatch(item.id, { text: "", resolved: false, origin: "hand" })}
        >
          Reset
        </button>
        <button type="button" className="btn" disabled={!ready || ai.status === "loading"} onClick={() => void ask()}>
          Ask AI
        </button>
      </div>

      {ai.status === "loading" && (
        <div className="merge-ai" aria-live="polite">
          <div className="merge-busy" role="progressbar" aria-label="Asking the local model">
            <div className="progress" />
          </div>
          <span>Asking the local model…</span>{" "}
          <button type="button" className="btn merge-small" onClick={cancelAsk}>
            Cancel
          </button>
        </div>
      )}
      {ai.status === "error" && (
        <div className="merge-note warn" role="alert">
          AI unavailable: {ai.message} You can keep resolving by hand.
        </div>
      )}
      {state.suggestion && ai.status !== "loading" && (
        <div className="merge-ai">
          <div className="merge-ai-head">
            <span className={`merge-badge ${CONFIDENCE_TONE[state.suggestion.confidence]}`}>
              AI confidence: {state.suggestion.confidence}
            </span>
            {state.text !== state.suggestion.resolution && (
              <button
                type="button"
                className="btn merge-small"
                onClick={() => state.suggestion && onPatch(item.id, { text: state.suggestion.resolution, origin: "ai" })}
              >
                Use suggestion
              </button>
            )}
          </div>
          <p>{state.suggestion.explanation || "(the model gave no explanation)"}</p>
        </div>
      )}

      <label className="merge-label" htmlFor={`merge-result-${item.id}`}>
        Result {state.origin === "ai" && state.text !== "" ? "(AI suggestion)" : ""}
      </label>
      <textarea
        id={`merge-result-${item.id}`}
        className="merge-result"
        rows={9}
        value={state.text}
        readOnly={blocked}
        spellCheck={false}
        placeholder="Write the merged code here, or use a quick action."
        onChange={(e) => onPatch(item.id, { text: e.currentTarget.value, origin: "hand" })}
      />
      {empty && (
        <p className="merge-soft merge-hint">
          An empty result removes this code (for a whole file: keeps the side that deletes it, or writes an empty file).
        </p>
      )}

      <button
        type="button"
        className={`btn${state.resolved ? " primary" : ""}`}
        aria-pressed={state.resolved}
        disabled={!ready}
        onClick={() => onPatch(item.id, { resolved: !state.resolved })}
      >
        {state.resolved ? "✓ Resolved" : "Mark resolved"}
      </button>
    </div>
  );
}