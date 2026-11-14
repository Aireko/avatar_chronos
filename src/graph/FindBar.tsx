// The find bar (Ctrl+F): searches the commits on the map by message, author and
// hash prefix. The matching itself lives in findCommits.ts; App owns the query
// and moves the selection, so the map glides to each match.
import { useEffect, useRef, useState } from "react";
import { matchSummary, stepMatch } from "./findCommits";
import { SearchIcon } from "../tools/icons";

interface Props {
  query: string;
  onQuery: (query: string) => void;
  /** Index of the selected commit among the matches, or -1. */
  current: number;
  count: number;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
  /** Bumped when Ctrl+F is pressed again while the bar is open: focus and select the text. */
  focusKey: number;
}

/** Which way the "3 of 12" count ticks over: forward, back, or plainly (null). */
export type StepCue = "next" | "prev" | null;

/**
 * How the selection moved among the same matches, so the count can tick the way it
 * went. A wrap (12 of 12 to 1 of 12) still counts as a step forward. Anything that
 * isn't one step (new matches, a jump, landing on or leaving a match) is null; with
 * two matches both ways land on the same one, which reads as forward.
 */
export function stepCue(prevCurrent: number, prevCount: number, current: number, count: number): StepCue {
  if (count !== prevCount || count < 2 || prevCurrent < 0 || current < 0 || current === prevCurrent) return null;
  if (stepMatch(prevCurrent, count, 1) === current) return "next";
  if (stepMatch(prevCurrent, count, -1) === current) return "prev";
  return null;
}

export function FindBar({ query, onQuery, current, count, onStep, onClose, focusKey }: Props) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  const hasQuery = query.trim().length > 0;
  const none = hasQuery && count === 0;
  const summary = matchSummary(current, count, hasQuery);

  // Motion cues, worked out while rendering (React's "adjust state when a prop changes"):
  // which way the count ticks, and a shake each time the query stops matching anything.
  // Opening on a query that already has no matches doesn't shake.
  const [seen, setSeen] = useState({ current, count, none });
  const [cue, setCue] = useState<StepCue>(null);
  const [misses, setMisses] = useState(0);
  if (seen.current !== current || seen.count !== count || seen.none !== none) {
    setSeen({ current, count, none });
    setCue(stepCue(seen.current, seen.count, current, count));
    if (none && !seen.none) setMisses((n) => n + 1);
  }

  function step(dir: 1 | -1) {
    // Enter with nothing to step to shakes the bar again (the parity class restarts it).
    if (none) setMisses((n) => n + 1);
    onStep(dir);
  }

  // Only while there are no matches, so a count that lags the typing for a frame (the
  // matching is deferred) never sets off a whole shake; the CSS waits a beat as well.
  const shake = none && misses > 0 ? (misses % 2 ? " is-miss-a" : " is-miss-b") : "";

  return (
    <div className={`find-bar${none ? " is-none" : ""}${shake}`} role="search" aria-label="Find a commit">
      <span className="find-glyph" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        ref={input}
        className="field find-input"
        value={query}
        onChange={(e) => onQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Message, author:name or hash"
        aria-label="Find a commit by message, author:name or hash"
        aria-describedby="find-count"
        spellCheck={false}
        autoComplete="off"
      />
      {/* One live region for as long as the bar is open, so every new count is announced.
          Only the inner text is keyed, so it ticks in like the status bar figures: up from
          below after a step forward, down from above after a step back. */}
      <span id="find-count" className={`find-count${none ? " is-none" : ""}`} role="status">
        <span key={summary} className={`find-count-tick${cue ? ` is-${cue}` : ""}`}>
          {summary}
        </span>
      </span>
      <button
        type="button"
        className="btn find-step find-prev"
        onClick={() => step(-1)}
        disabled={count === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <span className="find-arrow" aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        className="btn find-step find-next"
        onClick={() => step(1)}
        disabled={count === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <span className="find-arrow" aria-hidden="true">↓</span>
      </button>
      <button type="button" className="ticket-close find-close" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        ×
      </button>
    </div>
  );
}
