// The find bar (Ctrl+F): searches the commits on the map by message, author and
// hash prefix. The matching itself lives in findCommits.ts; App owns the query
// and moves the selection, so the map glides to each match.
import { useEffect, useRef } from "react";
import { matchSummary } from "./findCommits";
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

export function FindBar({ query, onQuery, current, count, onStep, onClose, focusKey }: Props) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  const hasQuery = query.trim().length > 0;
  const summary = matchSummary(current, count, hasQuery);

  return (
    <div className="find-bar" role="search" aria-label="Find a commit">
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
            onStep(e.shiftKey ? -1 : 1);
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
          Only the inner text is keyed, so it ticks in like the status bar figures. */}
      <span id="find-count" className={`find-count${hasQuery && count === 0 ? " is-none" : ""}`} role="status">
        <span key={summary} className="find-count-tick">
          {summary}
        </span>
      </span>
      <button
        type="button"
        className="btn find-step"
        onClick={() => onStep(-1)}
        disabled={count === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        className="btn find-step"
        onClick={() => onStep(1)}
        disabled={count === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <span aria-hidden="true">↓</span>
      </button>
      <button type="button" className="ticket-close find-close" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        ×
      </button>
    </div>
  );
}
