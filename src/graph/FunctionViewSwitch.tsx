// History | Calls: what the stage shows for the function in scope. It lives on the
// stage, in the workspace's top-left corner (where it applies), rather than in the
// toolbar, so the top bar stays calm. Same tabs and gliding ink as the scope tabs.
import { useId, useRef } from "react";
import { Tip } from "../tools/Tip";
import { supportsCallGraph } from "./callTree";
import { useSlidingInk } from "./slidingInk";
import "./scope.css";

export type FunctionView = "history" | "calls";

export const CALLS_HINT = "Show what calls this function and what it calls, as of the latest commit";

/** Why the call map can't be drawn for this function, or null when it can. */
export function callsOffReason(hasHead: boolean, path: string): string | null {
  if (!hasHead) return "The repository has no commits yet";
  if (!supportsCallGraph(path)) return "Call maps read C, Rust, JavaScript and TypeScript files";
  return null;
}

interface Props {
  view: FunctionView;
  onViewChange: (view: FunctionView) => void;
  /** Why Calls is off (shown in its tooltip), or null. */
  callsOff: string | null;
}

export function FunctionViewSwitch({ view, onViewChange, callsOff }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLSpanElement>(null);
  const hintId = useId();
  useSlidingInk(bar, ink, view);
  const off = callsOff !== null;

  return (
    <div className="view-switch">
      <div ref={bar} className="scope-tabs" role="group" aria-label="What to show for this function">
        <button
          type="button"
          className={`scope-tab view-history${view === "history" ? " on" : ""}`}
          aria-pressed={view === "history"}
          onClick={() => onViewChange("history")}
        >
          History
        </button>
        {/* Off is aria-disabled rather than disabled, so the keyboard can still reach the
            key and read why (its tooltip shows on focus too). */}
        <button
          type="button"
          className={`scope-tab view-calls${view === "calls" ? " on" : ""}`}
          aria-pressed={view === "calls"}
          aria-disabled={off || undefined}
          aria-describedby={hintId}
          onClick={() => {
            if (!off) onViewChange("calls");
          }}
        >
          Calls
        </button>
        {/* Last, so `.scope-tab:first-child` still finds the first tab. */}
        <span ref={ink} className="scope-ink" aria-hidden hidden />
      </div>
      {/* Hidden: read as the Calls key's description only, not again as loose text. */}
      <span id={hintId} hidden>
        {callsOff ?? CALLS_HINT}
      </span>
      {/* The tabs clip their overflow (for the ink's corners), so the tip hangs from a
          box of its own; scope.css shows it while Calls is hovered or focused. */}
      <span className="view-switch-tip">
        <Tip>
          {off ? (
            <>
              <strong className="tip-title">No call map here</strong>
              <span className="tip-text">{callsOff}</span>
            </>
          ) : (
            CALLS_HINT
          )}
        </Tip>
      </span>
    </div>
  );
}
