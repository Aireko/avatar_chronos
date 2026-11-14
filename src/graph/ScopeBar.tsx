import { useEffect, useRef, useState } from "react";
import { Presence } from "../tools/Presence";
import { blameFile, errorMessage, listFiles, type ChronosGraph } from "../backend";
import { PROJECT, functionChoices, scopeTarget, type FunctionChoice, type Scope } from "./scope";
import "./scope.css";

interface Props {
  graph: ChronosGraph | undefined;
  scope: Scope;
  onChange: (scope: Scope) => void;
}

type Picking = { kind: "file" } | { kind: "function"; path: string | null };
const MAX_SHOWN = 200;

export function ScopeBar({ graph, scope, onChange }: Props) {
  const [picking, setPicking] = useState<Picking | null>(null);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [functions, setFunctions] = useState<FunctionChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

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
      if (e.key === "Escape") setPicking(null);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [picking]);

  function open(next: Picking) {
    setQuery("");
    setError("");
    setPicking(next);
  }

  function pickFile(path: string) {
    if (picking?.kind === "function") {
      setQuery("");
      setFunctions([]);
      setPicking({ kind: "function", path });
    } else {
      setPicking(null);
      onChange({ kind: "file", path });
    }
  }

  function pickFunction(name: string) {
    if (!functionPath) return;
    setPicking(null);
    onChange({ kind: "function", path: functionPath, name });
  }

  const active = picking ? picking.kind : scope.kind;
  const q = query.trim().toLowerCase();
  const fileMatches = files.filter((f) => f.toLowerCase().includes(q));
  const functionMatches = functions.filter((f) => f.name.toLowerCase().includes(q));

  return (
    <div className="scope" ref={root}>
      <div className="scope-tabs" role="group" aria-label="History view">
        <button
          className={`scope-tab${active === "project" ? " on" : ""}`}
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
          disabled={!graph}
          onClick={() => open({ kind: "file" })}
        >
          File
        </button>
        <button
          className={`scope-tab${active === "function" ? " on" : ""}`}
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

      <Presence show={picking !== null} className="scope-pop" exitMs={140}>
        {picking && (
          <>
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
              className="field"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Type to filter"
              spellCheck={false}
            />
            {loading && <p className="quiet scope-note">Loading…</p>}
            {error && <p className="scope-note scope-bad">{error}</p>}
            <ul className="scope-list">
              {wantFiles &&
                fileMatches.slice(0, MAX_SHOWN).map((f) => (
                  <li key={f}>
                    <button onClick={() => pickFile(f)}>{f}</button>
                  </li>
                ))}
              {!wantFiles &&
                functionMatches.slice(0, MAX_SHOWN).map((f) => (
                  <li key={f.name}>
                    <button onClick={() => pickFunction(f.name)}>
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
          </>
        )}
      </Presence>
    </div>
  );
}