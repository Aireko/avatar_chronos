// Once a repository is open, the toolbar's path form folds into a small ticket with
// the repository's name. The ticket (or Ctrl+O / Ctrl+L) opens a pop-up with the path
// field, the recent repositories, Browse… and the repository's own actions. Reload
// stays one click away beside the ticket, and its arrow turns while the history is read.
import { useEffect, useId, useRef } from "react";
import { ChevronIcon, ExplorerIcon, FolderIcon, ReloadIcon } from "./icons";
import { PathField } from "./PathField";
import { Presence } from "./Presence";
import { Tip } from "./Tip";

interface Props {
  /** The repository's folder name, shown on the ticket. */
  name: string;
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bumped (by Ctrl+O, say) to put the keyboard in the path field again. */
  focusKey: number;
  path: string;
  onPathChange: (path: string) => void;
  recent: string[];
  onRemoveRecent: (path: string) => void;
  /** Open the repository at `path` (typed or picked from the recent list). */
  onOpenPath: (path: string) => void;
  onBrowse: () => void;
  onExplorer: () => void;
  onReload: () => void;
  loading: boolean;
  /** In the desktop app (Browse… and Show in Explorer need it). */
  desktop: boolean;
}

/** Popover exit; matches pop-out (0.14s) in tools.css. */
const EXIT_MS = 140;

export function RepoTicket({
  name,
  repoPath,
  open,
  onOpenChange,
  focusKey,
  path,
  onPathChange,
  recent,
  onRemoveRecent,
  onOpenPath,
  onBrowse,
  onExplorer,
  onReload,
  loading,
  desktop,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const key = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const onlyDesktop = "Only available in the desktop app";

  /** Close; if the keyboard was in the pop-up, it goes back to the ticket. */
  function close() {
    const pop = root.current?.querySelector(".repo-pop");
    if (pop?.contains(document.activeElement)) key.current?.focus({ preventScroll: true });
    onOpenChange(false);
  }
  const closeRef = useRef(close);
  closeRef.current = close;

  // The ticket takes the place of the path form (or the start screen's Browse key) the
  // moment the first repository opens, so a keyboard that was there would be dropped on
  // the page. It lands on the ticket instead.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) key.current?.focus({ preventScroll: true });
  }, []);

  // The keyboard goes to the path field (text selected, so typing replaces it) when the
  // pop-up opens, and again each time Ctrl+O / Ctrl+L is pressed while it is open.
  useEffect(() => {
    if (!open) return;
    const field = root.current?.querySelector<HTMLInputElement>(".repo-pop:not(.is-leaving) .path-input");
    field?.focus({ preventScroll: true });
    field?.select();
  }, [open, focusKey]);

  // Clicking elsewhere closes it. Esc closes it and nothing else: like the scope picker it
  // is the top layer, so the key is caught on the way down and kept from App's handler.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onOpenChange(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open, onOpenChange]);

  /** Each action closes the pop-up first, handing the keyboard back to the ticket. */
  const then = (act: () => void) => () => {
    close();
    act();
  };

  return (
    <div
      ref={root}
      className="repo"
      onBlur={(e) => {
        // Tabbing out closes it, as clicking elsewhere does. (Focus that simply vanishes,
        // a button disabled under it, say, has no relatedTarget.)
        const to = e.relatedTarget;
        if (open && to instanceof Node && !e.currentTarget.contains(to)) onOpenChange(false);
      }}
    >
      <button
        ref={key}
        type="button"
        className="btn repo-ticket"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-keyshortcuts="Control+O Control+L"
        aria-label={`Repository: ${name}. Change or reload it`}
        title={`${repoPath}\nChange repository (Ctrl+O)`}
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        <FolderIcon />
        {/* Keyed by name: another repository's name stamps in like a fresh chip. */}
        <span key={name} className="repo-ticket-name">
          {name}
        </span>
        <span className={`repo-ticket-fold${open ? " is-open" : ""}`} aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>

      <button
        type="button"
        className={`btn tool-btn icon-only repo-reload${loading ? " is-busy" : ""}`}
        // Not `disabled`: the keyboard stays on the key while its arrow turns.
        aria-disabled={loading || undefined}
        onClick={() => {
          if (!loading) onReload();
        }}
        aria-label={loading ? "Reloading the history" : "Reload the history"}
      >
        <ReloadIcon />
        <Tip>Reload the history</Tip>
      </button>

      <Presence show={open} className="repo-pop" exitMs={EXIT_MS}>
        <div id={popId} role="dialog" aria-label="Repository">
          <div className="repo-pop-head">
            <span className="repo-pop-title">Open a repository</span>
            <span className="repo-pop-now quiet" title={repoPath}>
              Now: {repoPath}
            </span>
          </div>
          <form
            className="repo-pop-form"
            aria-busy={loading || undefined}
            onSubmit={(e) => {
              e.preventDefault();
              if (!path.trim() || loading) return;
              close();
              onOpenPath(path);
            }}
          >
            <PathField
              inline
              value={path}
              onChange={onPathChange}
              recent={recent}
              onPick={(picked) => {
                close();
                onOpenPath(picked);
              }}
              onRemove={onRemoveRecent}
              disabled={loading}
              trailing={
                <button className="btn primary" type="submit" disabled={loading || !path.trim()}>
                  Open
                </button>
              }
            />
          </form>
          <div className="repo-pop-actions">
            <button
              type="button"
              className="btn tool-btn"
              disabled={loading || !desktop}
              onClick={then(onBrowse)}
              title={desktop ? "Choose the repository folder" : onlyDesktop}
            >
              <FolderIcon />
              Browse…
            </button>
            <button
              type="button"
              className="btn tool-btn"
              disabled={!desktop}
              onClick={then(onExplorer)}
              title={desktop ? "Show the repository folder in the file explorer" : onlyDesktop}
            >
              <ExplorerIcon />
              Show in Explorer
            </button>
            <button type="button" className="btn tool-btn" disabled={loading} onClick={then(onReload)}>
              <ReloadIcon />
              Reload
            </button>
          </div>
        </div>
      </Presence>
    </div>
  );
}
