import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { Presence } from "../tools/Presence";
import { blameFile, errorMessage, listFiles, type ChronosGraph } from "../backend";
import { supportsCallGraph } from "./callTree";
import { PROJECT, functionChoices, scopeTarget, type FunctionChoice, type Scope } from "./scope";
import "./scope.css";

export type FunctionView = "history" | "calls";

interface Props {
  graph: ChronosGraph | undefined;
  scope: Scope;
  onChange: (scope: Scope) => void;
  /** With a function in scope: whether the map shows its commits or its calls. */
  view?: FunctionView;
  onViewChange?: (view: FunctionView) => void;
}

type Picking = { kind: "file" } | { kind: "function"; path: string | null };
const MAX_SHOWN = 200;

export function ScopeBar({ graph, scope, onChange, view = "history", onViewChange }: Props) {
  const [picking, setPicking] = useState<Picking | null>(null);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [functions, setFunctions] = useState<FunctionChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const repoPath = graph?.repoPath;
  const functionPath = picking?.kind === "function" ? picking.path : null;
  const wantFiles = picking !== null && (picking.kind === "file" || picking.path === null);

  useEffect(() => {
    if (!repoPath || !wantFiles) return;
    let stale = false;
    setLoading(true);
    setError("");
    listFiles(repoPath)
      .then(
        (list) => {
          if (!stale) setFiles(list);
        },
        (e: unknown) => {
          if (!stale) setError(errorMessage(e));
        },
      )
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [repoPath, wantFiles]);

  useEffect(() => {
    if (!graph || !functionPath) return;
    let stale = false;
    setLoading(true);
    setError("");
    blameFile(graph.repoPath, functionPath)
      .then(
        (report) => report.symbols,
        (e: unknown) => {
          if (!stale) setError(errorMessage(e));
          return [];
        },
      )
      .then((symbols) => {
        if (!stale) setFunctions(functionChoices(graph, functionPath, symbols));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, functionPath]);

  useEffect(() => {
    if (!picking) return;
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setPicking(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        returnFocus();
        setPicking(null);
      }
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [picking]);

  /** The picker is closing: if focus was inside it, hand it back to the tab that opened it. */
  function returnFocus() {
    const pop = root.current?.querySelector(".scope-pop");
    if (pop && pop.contains(document.activeElement)) {
      root.current?.querySelector<HTMLButtonElement>(".scope-tab.on")?.focus();
    }
  }

  function open(next: Picking) {
    setQuery("");
    setError("");
    // Going back to the file step (or opening Function fresh) must drop the previous
    // file's function list, or that selection hangs around as a leftover in the dialog.
    if (next.kind === "function" && next.path === null) setFunctions([]);
    setPicking(next);
    // Moving between steps removes the button that was clicked; keep focus in the picker.
    filter.current?.focus();
  }

  function pickFile(path: string) {
    if (picking?.kind === "function") {
      setQuery("");
      setFunctions([]);
      setPicking({ kind: "function", path });
      filter.current?.focus();
    } else {
      returnFocus();
      setPicking(null);
      onChange({ kind: "file", path });
    }
  }

  function pickFunction(name: string) {
    if (!functionPath) return;
    returnFocus();
    setPicking(null);
    onChange({ kind: "function", path: functionPath, name });
  }

  /** Moves focus within the picker's list: ArrowUp on the first item returns to the filter. */
  function focusItem(index: number) {
    const items = list.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!items || items.length === 0) return;
    if (index < 0) {
      filter.current?.focus();
      return;
    }
    items[Math.min(index, items.length - 1)].focus();
  }

  function onFilterKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      // Enter takes the first match, so "type a few letters, Enter" is enough. It needs
      // some letters typed (a stray Enter shouldn't jump to the first file) and a
      // finished load (so it never picks from the previous repository's stale list).
      e.preventDefault();
      if (!q || loading) return;
      if (wantFiles && fileMatches[0]) pickFile(fileMatches[0]);
      else if (!wantFiles && functionMatches[0]) pickFunction(functionMatches[0].name);
    }
  }

  function onListKey(e: ReactKeyboardEvent<HTMLUListElement>) {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const to =
      e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    focusItem(to);
  }

  const active = picking ? picking.kind : scope.kind;
  const q = query.trim().toLowerCase();
  // Only mark the active file while choosing a *file* scope. During the function
  // wizard's file step, an old scope.path would otherwise look like a stuck selection
  // after you pick a file and then go back with "‹ files".
  const highlightedFile =
    picking?.kind === "file" && scope.kind !== "project" ? scope.path : null;
  const isCurrent = (name: string) => scope.kind === "function" && scope.path === functionPath && scope.name === name;
  const callsOff =
    scope.kind !== "function"
      ? null
      : !graph?.head
        ? "The repository has no commits yet"
        : !supportsCallGraph(scope.path)
          ? "Call maps read C, Rust, JavaScript and TypeScript files"
          : null;
  const fileMatches = files.filter((f) => f.toLowerCase().includes(q));
  const functionMatches = functions.filter((f) => f.name.toLowerCase().includes(q));

  return (
    <div className="scope" ref={root}>
      <div className="scope-tabs" role="group" aria-label="History view">
        <button
          className={`scope-tab${active === "project" ? " on" : ""}`}
          aria-pressed={active === "project"}
          disabled={!graph}
          onClick={() => {
            setPicking(null);
            onChange(PROJECT);
          }}
        >
          Project
        </button>
        <button
          className={`scope-tab${active === "file" ? " on" : ""}`}
          aria-pressed={active === "file"}
          disabled={!graph}
          onClick={() => open({ kind: "file" })}
        >
          File
        </button>
        <button
          className={`scope-tab${active === "function" ? " on" : ""}`}
          aria-pressed={active === "function"}
          disabled={!graph}
          onClick={() => open({ kind: "function", path: null })}
        >
          Function
        </button>
      </div>

      {scope.kind !== "project" && !picking && (
        <span className="scope-chip" title={scope.kind === "function" ? `${scope.path} : ${scope.name}` : scope.path}>
          {scope.kind === "function" ? `${scope.path.split("/").pop()} › ${scopeTarget(scope)}` : scope.path}
        </span>
      )}

      {scope.kind === "function" && !picking && onViewChange && (
        <div className="scope-tabs scope-view" role="group" aria-label="What to show for this function">
          <button
            className={`scope-tab${view === "history" ? " on" : ""}`}
            aria-pressed={view === "history"}
            onClick={() => onViewChange("history")}
          >
            History
          </button>
          <button
            className={`scope-tab${view === "calls" ? " on" : ""}`}
            aria-pressed={view === "calls"}
            disabled={callsOff !== null}
            title={callsOff ?? "Show what calls this function and what it calls, as of the latest commit"}
            onClick={() => onViewChange("calls")}
          >
            Calls
          </button>
        </div>
      )}

      <Presence show={picking !== null} className="scope-pop" exitMs={140}>
        {picking && (
          // One key for the whole step. Title + list used to share the same sibling key
          // ("files" / "fn:…"), so React left old titles stacked when you picked again.
          <div key={wantFiles ? "files" : `fn:${functionPath}`} className="scope-step-panel scope-step">
            <div className="scope-title">
              {picking.kind === "file" && "Choose a file"}
              {picking.kind === "function" && picking.path === null && "Choose the file the function is in"}
              {picking.kind === "function" && picking.path !== null && (
                <>
                  <button className="scope-back" onClick={() => open({ kind: "function", path: null })}>
                    ‹ files
                  </button>
                  Functions in {picking.path}
                </>
              )}
            </div>
            <input
              ref={filter}
              className="field"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onFilterKey}
              placeholder="Type to filter, Enter for the first"
              aria-label={wantFiles ? "Filter files" : "Filter functions"}
              spellCheck={false}
            />
            {loading && <p className="quiet scope-note scope-loading">Loading…</p>}
            {error && <p className="scope-note scope-bad" role="alert">{error}</p>}
            <ul
              ref={list}
              className="scope-list"
              onKeyDown={onListKey}
              aria-label={wantFiles ? "Files" : "Functions"}
            >
              {wantFiles &&
                fileMatches.slice(0, MAX_SHOWN).map((f) => (
                  <li key={f}>
                    <button
                      className={highlightedFile === f ? "on" : undefined}
                      aria-current={highlightedFile === f ? "true" : undefined}
                      onClick={() => pickFile(f)}
                    >
                      {f}
                    </button>
                  </li>
                ))}
              {!wantFiles &&
                functionMatches.slice(0, MAX_SHOWN).map((f) => (
                  <li key={f.name}>
                    <button
                      className={isCurrent(f.name) ? "on" : undefined}
                      aria-current={isCurrent(f.name) ? "true" : undefined}
                      onClick={() => pickFunction(f.name)}
                    >
                      {f.name}
                      <span className="quiet"> {f.kind}{f.atHead ? "" : " (no longer in the file)"}</span>
                    </button>
                  </li>
                ))}
            </ul>
            {!loading && !wantFiles && functionMatches.length === 0 && (
              <p className="quiet scope-note">No functions found.</p>
            )}
            {wantFiles && fileMatches.length > MAX_SHOWN && (
              <p className="quiet scope-note">{fileMatches.length - MAX_SHOWN} more. Keep typing to narrow it down.</p>
            )}
          </div>
        )}
      </Presence>
    </div>
  );
}