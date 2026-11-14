
import { useEffect, useMemo, useRef, useState } from "react";
import "@fontsource/patrick-hand/400.css";
import { backendVersion, errorMessage, exportGraph, type ChronosGraph } from "./backend";
import { CommitDetails } from "./graph/CommitDetails";
import { CommitGraph, type PanelMode } from "./graph/CommitGraph";
import { carryIds, layoutGraph } from "./graph/layout";
import "./graph/graph.css";

type Theme = "paper" | "board";

function App() {
  const [theme, setTheme] = useState<Theme>("paper");
  const [version, setVersion] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [path, setPath] = useState("");
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
  const currentBranch = graph?.branches.find((b) => b.isHead)?.name ?? null;

  useEffect(() => {
    backendVersion().then(
      (v) => {
        setVersion(v);
        setConnected(true);
      },
      (e: unknown) => {
        setConnected(false);
        setError(errorMessage(e));
      },
    );
  }, []);

  /** Swap in fresh history. Within the same repository, commits keep their identity so changes animate. */
  function applyGraph(next: ChronosGraph) {
    ids.current = carryIds(graph?.commits ?? [], ids.current, next.commits);
    setGraph(next);
    setSelected((current) =>
      current && next.commits.some((c) => c.hash === current) ? current : null,
    );
  }

  async function load(target: string) {
    const repo = target.trim();
    if (!repo) return;

    setLoading(true);
    setError("");

    try {
      const { graph: next } = await exportGraph(repo);

      if (graph && next.repoPath === graph.repoPath) {
        applyGraph(next);
      } else {
        ids.current = new Map();
        setGraph(next);
        setSelected(null);
        setPanel(null);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  /** Clicking a commit shows its action bar; the details panel only opens from that bar. */
  function pick(hash: string | null) {
    setSelected(hash);
    setPanel(null);
  }

  // Esc closes the panel first, then clears the selection. Arrow keys move along the branch.
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

  return (
    <div className="app" data-theme={theme}>
      <header className="toolbar">
        <span className="app-name">Chronos</span>

        <form
          className="open-form"
          onSubmit={(e) => {
            e.preventDefault();
            void load(path);
          }}
        >
          <input
            className="field"
            value={path}
            onChange={(e) => setPath(e.currentTarget.value)}
            placeholder="Repository folder path"
            aria-label="Repository folder path"
            spellCheck={false}
          />

          <button className="btn primary" type="submit" disabled={loading || !path.trim()}>
            Open
          </button>
        </form>

        <button
          className="btn"
          disabled={loading || !graph}
          onClick={() => graph && void load(graph.repoPath)}
        >
          Reload
        </button>

        <button className="btn" onClick={() => setTheme(theme === "paper" ? "board" : "paper")}>
          {theme === "paper" ? "Blackboard" : "Paper"}
        </button>

        {loading && <div className="progress" />}
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="btn" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}

      <main className="stage">
        {graph && layout ? (
          <CommitGraph
            graph={graph}
            layout={layout}
            selected={selected}
            panelOpen={panel !== null}
            onSelect={pick}
            onAction={(mode) => setPanel({ mode, id: Date.now() })}
          />
        ) : (
          <div className="empty">
            <h1>Open a repository</h1>
            <p>Write the folder path of a Git repository in the bar above, then choose Open.</p>
          </div>
        )}

        {graph && layout && selectedNode && panel && (
          <CommitDetails
            key={`${selectedNode.commit.hash}:${panel.id}`}
            start={panel.mode}
            repoPath={graph.repoPath}
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

      <footer className="statusbar">
        {graph ? (
          <>
            <span className="status-path" title={graph.repoPath}>
              {graph.repoPath}
            </span>
            <span>{currentBranch ? `On ${currentBranch}` : "Detached HEAD"}</span>
            <span>{graph.commits.length} commits</span>
            <span>{graph.branches.length} branches</span>
          </>
        ) : (
          <span className="status-path">No repository open</span>
        )}

        <span className={connected === false ? "status-bad" : ""}>
          {connected === false ? "Backend not connected" : version}
        </span>
      </footer>
    </div>
  );
}

export default App;
