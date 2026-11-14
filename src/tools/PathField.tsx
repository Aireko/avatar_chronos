// The repository path field, with the recently opened repositories (the list logic
// lives in recentRepos.ts). Two ways to show the list:
//  - a dropdown (the toolbar before a repository is open): it opens on focus or from
//    the chevron; ArrowUp/Down move, Enter opens, Esc closes, Shift+Delete forgets.
//  - `inline` (inside the repository pop-up): the list sits under the field, always in
//    view; the same keys walk it from the field, and Esc is left to the pop-up.
// While a repository is loading (`disabled`) picks are ignored and the dropdown stays
// shut, so a second open can't start under the first.
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Presence } from "./Presence";
import { ChevronIcon } from "./icons";
import { repoName, sameRepo } from "./recentRepos";
import "./recent.css";

interface Props {
  value: string;
  onChange: (value: string) => void;
  recent: string[];
  onPick: (path: string) => void;
  onRemove: (path: string) => void;
  /** A repository is loading: the dropdown closes and picks are ignored until it is done. */
  disabled?: boolean;
  /** Show the list under the field, always open, instead of as a dropdown. */
  inline?: boolean;
  /** Laid beside the field in the inline layout (the pop-up's Open key). */
  trailing?: ReactNode;
}

/** Rows after this many come in together rather than one after another. */
const STAGGER_ROWS = 6;

export function PathField({ value, onChange, recent, onPick, onRemove, disabled = false, inline = false, trailing }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-recent`;
  const hintId = `${id}-hint`;
  const shown = recent.length > 0 && (inline || (open && !disabled));
  const activeIndex = active < recent.length ? active : -1;

  function show(at = -1) {
    if (recent.length === 0 || disabled) return;
    setOpen(true);
    setActive(at);
  }

  function close() {
    setOpen(false);
    setActive(-1);
  }

  // A load starting shuts the list, so it doesn't spring back open when the load is done.
  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setActive(-1);
  }, [disabled]);

  function pick(path: string) {
    close();
    if (!disabled) onPick(path);
  }

  function remove(index: number) {
    const path = recent[index];
    if (!path) return;
    onRemove(path);
    // Stay on the same row (now the next entry), or the new last one.
    const left = recent.length - 1;
    setActive(left === 0 ? -1 : Math.min(index, left - 1));
  }

  const field = (
    <input
      ref={input}
      className={`field path-input${recent.length > 0 && !inline ? " has-recent" : ""}`}
      value={value}
      onChange={(e) => {
        onChange(e.currentTarget.value);
        // Typing a new path: the list steps aside (ArrowDown brings it back).
        close();
      }}
      onFocus={() => {
        if (!inline) show();
      }}
      onClick={() => {
        if (!inline && !open) show();
      }}
      onKeyDown={(e) => {
        const n = recent.length;
        if (e.key === "ArrowDown" && n > 0) {
          e.preventDefault();
          if (!shown) show(0);
          else setActive((a) => (a + 1) % n);
        } else if (e.key === "ArrowUp" && n > 0) {
          e.preventDefault();
          if (!shown) show(n - 1);
          else setActive((a) => (a <= 0 ? n - 1 : a - 1));
        } else if (e.key === "Enter" && shown && activeIndex >= 0) {
          // Open the highlighted repository instead of submitting the typed path.
          e.preventDefault();
          pick(recent[activeIndex]);
        } else if (e.key === "Enter") {
          // The form opens the typed path; the list steps aside.
          close();
        } else if (e.key === "Escape" && shown && !inline) {
          e.preventDefault();
          close();
        } else if (e.key === "Delete" && e.shiftKey && shown && activeIndex >= 0) {
          e.preventDefault();
          remove(activeIndex);
        } else if (e.key === "Tab") {
          close();
        }
      }}
      placeholder="Repository folder path"
      aria-label="Repository folder path"
      role="combobox"
      aria-autocomplete="none"
      aria-expanded={shown}
      aria-controls={shown ? listId : undefined}
      aria-activedescendant={shown && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      aria-describedby={recent.length > 0 ? hintId : undefined}
      spellCheck={false}
      autoComplete="off"
    />
  );

  const list = (
    <>
      <div className="recent-head" aria-hidden="true">
        Recent repositories
      </div>
      <ul id={listId} className="recent-list" role="listbox" aria-label="Recent repositories">
        {recent.map((path, i) => (
          <li
            key={path}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            aria-disabled={disabled || undefined}
            className={`recent-row${i === activeIndex ? " is-active" : ""}${sameRepo(path, value) ? " is-current" : ""}`}
            // Each row drops in a moment after the one above it (see .recent-row in recent.css).
            style={{ "--row": Math.min(i, STAGGER_ROWS) } as CSSProperties}
            // Keep focus in the field, so the list doesn't close before the click lands.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(path)}
            title={path}
          >
            <span className="recent-text">
              <span className="recent-name">{repoName(path)}</span>
              <span className="recent-path">{path}</span>
            </span>
            {/* Pointer shortcut for Shift+Delete; hidden from screen readers, which get the hint instead. */}
            <button
              type="button"
              className="recent-remove"
              tabIndex={-1}
              aria-hidden="true"
              title="Remove from this list (Shift+Del)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                remove(i);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {/* The keys on screen too, so the keyboard way to forget an entry can be found. */}
      <div className="recent-foot quiet" aria-hidden="true">
        Up/Down to choose · Enter opens · Shift+Del forgets
      </div>
    </>
  );

  const hint = recent.length > 0 && (
    <span id={hintId} className="recent-sr-only">
      Recent repositories: press Down to choose one, Enter to open it, Shift+Delete to forget it.
    </span>
  );

  if (inline) {
    return (
      <div
        className="path-combo is-inline"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(-1);
        }}
      >
        <div className="path-row">
          {field}
          {trailing}
        </div>
        {hint}
        {recent.length > 0 && <div className="recent-inline">{list}</div>}
      </div>
    );
  }

  return (
    <div
      className="path-combo"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      {field}
      {recent.length > 0 && (
        <>
          {hint}
          <button
            type="button"
            className="path-chevron"
            // Keyboard users have ArrowDown in the field; the chevron is for the pointer.
            tabIndex={-1}
            aria-label={shown ? "Hide recent repositories" : "Show recent repositories"}
            aria-expanded={shown}
            title="Recent repositories"
            onMouseDown={(e) => e.preventDefault()}
            disabled={disabled}
            onClick={() => {
              input.current?.focus();
              if (shown) close();
              else show();
            }}
          >
            <span className={`path-chevron-glyph${shown ? " is-open" : ""}`}>
              <ChevronIcon />
            </span>
          </button>
        </>
      )}

      <Presence show={shown} className="recent-pop" exitMs={140}>
        {list}
      </Presence>
    </div>
  );
}
