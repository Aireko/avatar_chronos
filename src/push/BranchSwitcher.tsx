// The branch key in the toolbar's git cluster. It names the current branch and opens a
// small hand-drawn menu (it pops in like the scope picker) listing the local branches,
// with "New branch…" at the bottom, which turns the menu into a name field in place.
// Keys: Up/Down/Home/End walk the menu, Enter picks, Esc steps back out of the name
// field and then closes the menu, handing the keyboard back to the branch key.
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { errorMessage, type ChronosGraph } from "../backend";
import { BranchIcon, ChevronIcon, PlusIcon } from "../tools/icons";
import { Presence } from "../tools/Presence";
import { branchKeyLabel, branchMenuOrder, branchNameProblem, rovingIndex } from "../tools/toolbarKeys";
import { branchNames, createBranch, switchBranch } from "./git";

interface Props {
  graph: ChronosGraph | undefined;
  currentBranch: string | null;
  onGraphChange: (g: ChronosGraph) => void;
  onError: (msg: string) => void;
}

/** Menu exit; matches pop-out (0.14s) in tools.css. */
const EXIT_MS = 140;

export function BranchSwitcher({ graph, currentBranch, onGraphChange, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"switch" | "create" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const key = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const hintId = useId();

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

  // A new repository (or the graph going away) shuts the menu.
  const repo = graph?.repoPath;
  useEffect(() => {
    setOpen(false);
    setCreating(false);
    setName("");
  }, [repo]);

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

  const label = branchKeyLabel(currentBranch, busy);

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
        className={`btn tool-btn branch-key${busy ? " is-switching" : ""}`}
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
