// The repository path field, with a dropdown of recently opened repositories
// (the list logic lives in recentRepos.ts). The dropdown opens on focus or from
// the chevron; ArrowUp/Down move, Enter opens, Esc closes, Shift+Delete forgets.
// While a repository is loading (`disabled`) the list stays shut, so a second open
// can't start under the first.
import { useEffect, useId, useRef, useState } from "react";
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
}

export function PathField({ value, onChange, recent, onPick, onRemove, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-recent`;
  const hintId = `${id}-hint`;
  const shown = open && recent.length > 0 && !disabled;
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

  return (
    <div
      className="path-combo"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <input
        ref={input}
        className={`field path-input${recent.length > 0 ? " has-recent" : ""}`}
        value={value}
        onChange={(e) => {
          onChange(e.currentTarget.value);
          // Typing a new path: the list steps aside (ArrowDown brings it back).
          close();
        }}
        onFocus={() => show()}
        onClick={() => {
          if (!open) show();
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
          } else if (e.key === "Escape" && shown) {
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
      {recent.length > 0 && (
        <>
          <span id={hintId} className="recent-sr-only">
            Recent repositories: press Down to choose one, Enter to open it, Shift+Delete to forget it.
          </span>
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
              className={`recent-row${i === activeIndex ? " is-active" : ""}${sameRepo(path, value) ? " is-current" : ""}`}
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
      </Presence>
    </div>
  );
}
