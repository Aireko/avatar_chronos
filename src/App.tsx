import { useEffect, useMemo, useRef, useState } from "react";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow-semi-condensed/500.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "@fontsource/barlow-semi-condensed/700.css";
import { backendVersion, errorMessage, exportGraph, type ChronosGraph } from "./backend";
import { CommitDetails } from "./graph/CommitDetails";
import { CommitGraph, type PanelMode } from "./graph/CommitGraph";
import { carryIds, layoutGraph } from "./graph/layout";
import "./graph/graph.css";

function App() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [version, setVersion] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [graph, setGraph] = useState<ChronosGraph>();
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ mode: PanelMode; id: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ids = useRef(new Map<string, string>());

  const layout = useMemo(
    () => (graph ? layoutGraph(graph.commits, graph.branches, graph.head, ids.current) : null),
    [graph],
  );
  const selectedNode = selected && layout ? layout.byHash.get(selected) : undefined;

  useEffect(() => {
    backendVersion().then(
      (v) => {
        setVersion(v);
        setOnline(true);
      },
      (e: unknown) => {
        setOnline(false);
        setError(errorMessage(e));
      },
    );
  }, []);

  async function open() {
    const path = repoPath.trim();
    if (!path) return;
    setLoading(true);
    setError("");
    try {
      const { graph: next } = await exportGraph(path);
      ids.current = new Map();
      setGraph(next);
      setSelected(null);
      setPanel(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  /** Clicking a commit shows its bubbles; the ticket only opens from a bubble. */
  function pick(hash: string | null) {
    setSelected(hash);
    setPanel(null);
  }

  const openPanel = (mode: PanelMode) => setPanel({ mode, id: Date.now() });

  // Esc closes the ticket first, then the bubbles. Arrow keys travel along the branch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") {
        if (panel) setPanel(null);
        else setSelected(null);
        return;
      }
      if (!layout || !selected) return;
      const node = layout.byHash.get(selected);
      if (!node) return;
      let next: string | undefined;
      if (e.key === "ArrowLeft") {
        const parent = node.commit.parents[0];
        if (parent && layout.byHash.has(parent)) next = parent;
      }
      if (e.key === "ArrowRight") {
        const kids = layout.childrenOf.get(selected) ?? [];
        next = kids.find((h) => layout.byHash.get(h)?.lane === node.lane) ?? kids[0];
      }
      if (next) {
        setSelected(next);
        if (panel) setPanel({ mode: "details", id: Date.now() });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, selected, panel]);

  /** Swap in a refreshed map (after a rebase), keeping the selection if that commit survived. */
  function applyGraph(next: ChronosGraph) {
    ids.current = carryIds(graph?.commits ?? [], ids.current, next.commits);
    setGraph(next);
    setSelected((current) => (current && next.commits.some((c) => c.hash === current) ? current : null));
  }

  return (
    <div className="app">
      <header className="bar">
        <div className="wordmark">
          <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
            <circle cx="15" cy="15" r="12" fill="#fcfdfe" stroke="#16203a" strokeWidth="4" />
            <path d="M15 8.5 V15 L20 18" fill="none" stroke="#e5484d" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Chronos
        </div>
        <form
          className="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            void open();
          }}
        >
          <input
            className="path-input"
            value={repoPath}
            onChange={(e) => setRepoPath(e.currentTarget.value)}
            placeholder="Folder path of a Git repository"
            aria-label="Repository folder path"
            spellCheck={false}
          />
          <button className="key amber" type="submit" disabled={loading || !repoPath.trim()}>
            {loading ? "Opening" : graph ? "Reload" : "Open"}
          </button>
        </form>
        <span
          className={`link-state${online === true ? " on" : online === false ? " off" : ""}`}
          title={online ? `Connected to ${version}` : "The C backend is not connected"}
        />
        {loading && <div className="progress" />}
      </header>

      {error && (
        <button className="toast" onClick={() => setError("")} title="Dismiss">
          {error}
        </button>
      )}

      <main className="stage">
        {graph && layout ? (
          <CommitGraph
            graph={graph}
            layout={layout}
            selected={selected}
            panelOpen={panel !== null}
            onSelect={pick}
            onAction={openPanel}
          />
        ) : (
          <div className="empty">
            <svg width="300" height="96" viewBox="0 0 300 96" aria-hidden="true">
              <path d="M24 30 H276" stroke="#16203a" strokeWidth="15" strokeLinecap="round" fill="none" />
              <path d="M96 30 H112 L148 66 H212" stroke="#16203a" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M24 30 H276" stroke="#e5484d" strokeWidth="9" strokeLinecap="round" fill="none" />
              <path d="M96 30 H112 L148 66 H212" stroke="#2f5de3" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <circle cx="24" cy="30" r="14" fill="#e5484d" stroke="#16203a" strokeWidth="3" />
              <circle cx="96" cy="30" r="14" fill="#e5484d" stroke="#16203a" strokeWidth="3" />
              <circle cx="212" cy="66" r="14" fill="#2f5de3" stroke="#16203a" strokeWidth="3" />
              <circle cx="276" cy="30" r="14" fill="#e5484d" stroke="#16203a" strokeWidth="3" />
            </svg>
            <p>Paste the folder path of a Git repository above, then press Open to see its history as a map.</p>
          </div>
        )}

        {graph && layout && selectedNode && panel && (
          <CommitDetails
            key={`${selectedNode.commit.hash}:${panel.id}`}
            start={panel.mode}
            repoPath={repoPath.trim()}
            graph={graph}
            layout={layout}
            commit={selectedNode.commit}
            lane={layout.lanes[selectedNode.lane]}
            onGraphChange={applyGraph}
            onSelect={(hash) => {
              setSelected(hash);
              setPanel({ mode: "details", id: Date.now() });
            }}
            onClose={() => setPanel(null)}
          />
        )}
      </main>
    </div>
  );
}

export default App;