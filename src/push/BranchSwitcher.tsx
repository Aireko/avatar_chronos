// The branch key in the toolbar's git cluster. It names the current branch and opens a
// small hand-drawn menu (it pops in like the scope picker) listing the local branches,
// with "New branch…" at the bottom, which turns the menu into a name field in place.
// Keys: Up/Down/Home/End walk the menu, Enter picks, Esc steps back out of the name
// field and then closes the menu, handing the keyboard back to the branch key.
// A speech bubble beside the key offers Fetch (until the first check) or Pull when the
// branch is behind its upstream.
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { errorMessage, type ChronosGraph } from "../backend";
import { BranchIcon, ChevronIcon, PlusIcon } from "../tools/icons";
import { Presence } from "../tools/Presence";
import { branchKeyLabel, branchMenuOrder, branchNameProblem, rovingIndex } from "../tools/toolbarKeys";
import {
  fetchOrigin,
  readBranchSync,
  syncBubbleLabel,
  syncHintFor,
  type BranchSyncHint,
} from "./branchSync";
import { branchNames, createBranch, pullFrom, switchBranch } from "./git";

interface Props {
  graph: ChronosGraph | undefined;
  currentBranch: string | null;
  onGraphChange: (g: ChronosGraph) => void;
  onError: (msg: string) => void;
}

/** Menu exit; matches pop-out (0.14s) in tools.css. */
const EXIT_MS = 140;
/** Quiet background fetch while the window is focused. */
const FETCH_EVERY_MS = 90_000;

export function BranchSwitcher({ graph, currentBranch, onGraphChange, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"switch" | "create" | "fetch" | "pull" | null>(null);
  const [hint, setHint] = useState<BranchSyncHint | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const key = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const hintId = useId();
  const syncBusy = useRef(false);
  const fetchedRef = useRef(false);

  const names = graph ? branchNames(graph) : [];
  const ordered = branchMenuOrder(names, currentBranch);
  const problem = branchNameProblem(name, names);

  /** The menu's keys, in order: every branch, then "New branch…". */
  function items(): HTMLButtonElement[] {
    return [...(menu.current?.querySelectorAll<HTMLButtonElement>(".branch-item") ?? [])];
  }

  function close(refocus = true) {
    if (refocus && root.current?.querySelector(".branch-pop")?.contains(document.activeElement)) {
      key.current?.focus({ preventScroll: true });
    }
    setOpen(false);
    setCreating(false);
    setName("");
  }
  const closeRef = useRef(close);
  closeRef.current = close;

  function backToList() {
    setCreating(false);
    setName("");
    // The list comes back with the keyboard on "New branch…", where it left from.
    window.requestAnimationFrame(() => {
      const all = items();
      all[all.length - 1]?.focus({ preventScroll: true });
    });
  }
  const backRef = useRef(backToList);
  backRef.current = backToList;

  // Opening puts the keyboard on the current branch (the first item).
  useEffect(() => {
    if (!open || creating) return;
    items()[0]?.focus({ preventScroll: true });
    // Only on opening; returning from the name field focuses "New branch…" itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (creating) field.current?.focus({ preventScroll: true });
  }, [creating]);

  // Clicking elsewhere closes the menu. Esc is caught on the way down (the menu is the
  // top layer), so App's own Esc doesn't also close a panel behind it.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) closeRef.current(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      e.preventDefault();
      // Anywhere in the name step (the field, Back or Create), Esc steps back to the list.
      const inCreate = menu.current?.querySelector(".branch-create")?.contains(document.activeElement) === true;
      if (inCreate) backRef.current();
      else closeRef.current();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  // A new repository (or the graph going away) shuts the menu and resets sync state.
  const repo = graph?.repoPath;
  useEffect(() => {
    setOpen(false);
    setCreating(false);
    setName("");
    setHint(null);
    fetchedRef.current = false;
  }, [repo]);

  // A different branch means a fresh Fetch nudge until the next check.
  useEffect(() => {
    fetchedRef.current = false;
    setHint(null);
  }, [currentBranch]);

  // Read status (and periodically fetch) so the bubble can offer Fetch or Pull.
  useEffect(() => {
    if (!repo || !currentBranch) {
      setHint(null);
      return;
    }
    let cancelled = false;

    async function refresh(doFetch: boolean) {
      if (syncBusy.current || cancelled) return;
      syncBusy.current = true;
      try {
        const status = doFetch ? await fetchOrigin(repo!) : await readBranchSync(repo!);
        if (cancelled) return;
        if (doFetch) fetchedRef.current = true;
        setHint(syncHintFor(status, fetchedRef.current));
      } catch {
        // Offline / no origin on a background fetch: keep the last hint.
        if (!cancelled && !doFetch) {
          try {
            const status = await readBranchSync(repo!);
            if (!cancelled) setHint(syncHintFor(status, fetchedRef.current));
          } catch {
            if (!cancelled) setHint(null);
          }
        }
      } finally {
        syncBusy.current = false;
      }
    }

    void refresh(false);
    // First quiet fetch shortly after open, then on focus / interval.
    const first = window.setTimeout(() => void refresh(true), 1200);
    const onFocus = () => void refresh(true);
    window.addEventListener("focus", onFocus);
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, FETCH_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(tick);
    };
  }, [repo, currentBranch]);

  if (!graph || !repo) return null;

  async function change(branch: string) {
    close();
    if (branch === currentBranch) return;
    setBusy("switch");
    try {
      onError("");
      onGraphChange(await switchBranch(repo!, branch));
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function runSync() {
    if (!hint || busy || !currentBranch) return;
    const action = hint.kind;
    setBusy(action);
    try {
      onError("");
      if (action === "fetch") {
        const status = await fetchOrigin(repo!);
        fetchedRef.current = true;
        setHint(syncHintFor(status, true));
      } else {
        onGraphChange(await pullFrom(repo!, currentBranch));
        setHint(null);
        fetchedRef.current = true;
      }
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const branch = name.trim();
    if (!branch || problem || busy) return;
    close();
    setBusy("create");
    try {
      onError("");
      onGraphChange(await createBranch(repo!, branch));
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const to = rovingIndex(at, all.length, e.key);
    if (to === null) return;
    e.preventDefault();
    all[to]?.focus({ preventScroll: true });
  }

  const switching = busy === "switch" || busy === "create" ? busy : null;
  const label = branchKeyLabel(currentBranch, switching);
  const bubbleText = hint ? (busy === hint.kind ? (hint.kind === "fetch" ? "Fetching…" : "Pulling…") : syncBubbleLabel(hint)) : null;

  return (
    <div
      ref={root}
      className="branch-menu"
      onBlur={(e) => {
        // Tabbing out closes the menu, as clicking elsewhere does.
        const to = e.relatedTarget;
        if (open && to instanceof Node && !e.currentTarget.contains(to)) close(false);
      }}
    >
      <button
        ref={key}
        type="button"
        className={`btn tool-btn branch-key${switching ? " is-switching" : ""}`}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busy !== null || undefined}
        aria-label={`Branch: ${label}. Switch or create a branch`}
        title={currentBranch ? `On ${currentBranch}. Switch or create a branch` : "Switch or create a branch"}
        onClick={() => (open ? close() : busy ? undefined : setOpen(true))}
      >
        <BranchIcon />
        {/* Keyed by what it says: a switched branch lands like a fresh chip. */}
        <span key={label} className="branch-key-name">
          {label}
        </span>
        <span className={`branch-key-fold${open ? " is-open" : ""}`} aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>

      <Presence show={hint !== null && !open} className="branch-sync" exitMs={EXIT_MS}>
        {hint && bubbleText && (
          <button
            type="button"
            className={`branch-sync-bubble${busy === hint.kind ? " is-busy" : ""}`}
            disabled={busy !== null}
            onClick={() => void runSync()}
            aria-label={
              hint.kind === "fetch"
                ? "Fetch from origin"
                : `Pull ${hint.behind} commit${hint.behind === 1 ? "" : "s"} from origin`
            }
          >
            {bubbleText}
          </button>
        )}
      </Presence>

      <Presence show={open} className="branch-pop" exitMs={EXIT_MS}>
        <div id={menuId} ref={menu} role="group" aria-label="Branches" onKeyDown={onMenuKey}>
          {creating ? (
            <form
              key="create"
              className="branch-step branch-create"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <label className="branch-pop-head" htmlFor={`${menuId}-name`}>
                New branch from here
              </label>
              <input
                ref={field}
                id={`${menuId}-name`}
                className="field branch-field"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="new-branch-name"
                aria-invalid={problem ? true : undefined}
                aria-describedby={hintId}
                spellCheck={false}
                autoComplete="off"
              />
              <p id={hintId} className={`branch-hint${problem ? " is-bad" : " quiet"}`} aria-live="polite">
                {problem ?? "Uncommitted changes come along."}
              </p>
              <div className="branch-create-keys">
                <button className="btn" type="button" onClick={backToList}>
                  Back
                </button>
                <button className="btn primary" type="submit" disabled={!name.trim() || problem !== null}>
                  Create
                </button>
              </div>
            </form>
          ) : (
            <div key="list" className="branch-step">
              <div className="branch-pop-head" aria-hidden="true">
                Switch branch
              </div>
              <ul className="branch-list">
                {currentBranch === null && (
                  <li className="branch-detached quiet">Not on a branch (detached)</li>
                )}
                {ordered.map((n) => (
                  <li key={n}>
                    <button
                      type="button"
                      className={`branch-item${n === currentBranch ? " is-current" : ""}`}
                      aria-current={n === currentBranch ? "true" : undefined}
                      onClick={() => void change(n)}
                      title={n}
                    >
                      <span className="branch-item-name">{n}</span>
                      {n === currentBranch && <span className="branch-item-tag">current</span>}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="branch-item branch-new" onClick={() => setCreating(true)}>
                <PlusIcon />
                New branch…
              </button>
            </div>
          )}
        </div>
      </Presence>
    </div>
  );
}
