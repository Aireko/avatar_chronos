import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import "@fontsource/patrick-hand/400.css";
// Base doodle styles first, so the tool panels' stylesheets (imported by the
// components below) can refine shared classes like .field and .btn.
import "./graph/graph.css";
import "./tools/tools.css";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import AiPanel from "./ai/AiPanel";
import { backendVersion, errorMessage, exportGraph, type ChronosGraph } from "./backend";
import ContributorsPanel from "./blame/ContributorsPanel";
import BugCheckPanel from "./bugcheck/BugCheckPanel";
import { CodeEditor, type DiffCompare } from "./graph/CodeEditor";
import { CommitDetails } from "./graph/CommitDetails";
import { CommitGraph, type PanelMode } from "./graph/CommitGraph";
import { carryIds, layoutGraph } from "./graph/layout";
import { Terminal } from "./graph/Terminal";
import { ScopeBar } from "./graph/ScopeBar";
import { BranchSwitcher } from "./push/BranchSwitcher";
import { PushPanel } from "./push/PushPanel";
import { PROJECT, scopeGraph, scopeKey, type Scope } from "./graph/scope";
import { useTheme, type Theme } from "./tools/theme";
import { crossFade } from "./tools/crossFade";
import {
  EmptyScopeDoodle,
  ExplorerIcon,
  FolderIcon,
  HistoryDoodle,
  PeopleIcon,
  ReloadIcon,
  ReviewIcon,
  SparkIcon,
  ThemeIcon,
  WarnIcon,
} from "./tools/icons";
import { Presence } from "./tools/Presence";
import { ToolDrawer, type ToolId } from "./tools/ToolDrawer";

const TOOLS: { id: ToolId; label: string; title: string; hint: string; icon: () => ReactElement }[] = [
  { id: "ai", label: "Local AI", title: "Local AI", hint: "Local Qwen model through Ollama", icon: SparkIcon },
  { id: "reviews", label: "PR reviews", title: "PR reviews", hint: "Check GitHub pull requests for bugs", icon: ReviewIcon },
  { id: "people", label: "People", title: "Who worked on this?", hint: "Find who wrote a file and email them", icon: PeopleIcon },
];

function App() {
  // Follows the system light/dark setting until the user picks; their pick is remembered.
  const [theme, setTheme] = useTheme();
  // The switch icon only turns once the user has flipped the theme, not on launch.
  const [themeFlipped, setThemeFlipped] = useState(false);
  const [version, setVersion] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [path, setPath] = useState("");
  const [graph, setGraph] = useState<ChronosGraph>();
  const [scope, setScope] = useState<Scope>(PROJECT);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ mode: PanelMode; id: number } | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [diffCompare, setDiffCompare] = useState<DiffCompare | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showPush, setShowPush] = useState(false);
  // At most one drawer is open on the right: a tool or the commit details.
  const [tool, setTool] = useState<ToolId | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ids = useRef(new Map<string, string>());

  const scoped = useMemo(() => (graph ? scopeGraph(graph, scope) : null), [graph, scope]);
  const layout = useMemo(
    () => (scoped ? layoutGraph(scoped.graph.commits, scoped.graph.branches, scoped.graph.head, ids.current) : null),
    [scoped],
  );

  const selectedNode = selected && layout ? layout.byHash.get(selected) : undefined;
  const currentBranch = graph?.branches.find((b) => b.isHead)?.name ?? null;
  const repoLabel = graph?.repoPath.split(/[/\\]/).filter(Boolean).pop() || graph?.repoPath || "repo";

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
        setScope(PROJECT);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function changeScope(next: Scope) {
    setScope(next);
    setSelected(null);
    setPanel(null);
    setShowEditor(false);
    setDiffCompare(null);
  }

  /** Clicking a commit shows its action bar; the details panel only opens from that bar. */
  function pick(hash: string | null) {
    setSelected(hash);
    setPanel(null);
    if (!showEditor || !diffCompare || !hash || !graph) return;
    const commit = graph.commits.find((c) => c.hash === hash);
    if (!commit || commit.hash === graph.head) return;
    setDiffCompare({
      baseRev: commit.hash,
      baseLabel: commit.shortHash,
      headLabel: "working tree",
    });
  }

  function openSideDiff(hash: string) {
    const commit = graph?.commits.find((c) => c.hash === hash);
    if (!commit || commit.hash === graph?.head) return;
    setSelected(hash);
    setPanel(null);
    setDiffCompare({
      baseRev: commit.hash,
      baseLabel: commit.shortHash,
      headLabel: "working tree",
    });
    setShowEditor(true);
  }

  function closeEditor() {
    setShowEditor(false);
    setDiffCompare(null);
  }

  /** Opening a tool closes the commit details (they share the right-hand side), and vice versa. */
  function toggleTool(id: ToolId) {
    setTool((current) => (current === id ? null : id));
    setPanel(null);
  }

  /** Native folder picker, so the path doesn't have to be typed. */
  async function browse() {
    setError("");
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a Git repository folder",
        defaultPath: path.trim() || graph?.repoPath || undefined,
      });
      if (typeof picked === "string" && picked) {
        setPath(picked);
        await load(picked);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Shows the open repository's folder in the system file explorer. */
  async function showInExplorer() {
    if (!graph) return;
    setError("");
    try {
      await revealItemInDir(graph.repoPath.replace(/\//g, navigator.userAgent.includes("Windows") ? "\\" : "/"));
    } catch (e) {
      setError(`Couldn't open the file explorer: ${errorMessage(e)}`);
    }
  }

  // Esc closes the commit panel, then a tool, the editor, the terminal, and finally the selection.
  // Arrow keys move along the branch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typing) return;

      if (e.key === "Escape") {
        if (panel) setPanel(null);
        else if (tool) setTool(null);
        else if (showEditor) {
          setShowEditor(false);
          setDiffCompare(null);
        } else if (showTerminal) setShowTerminal(false);
        else setSelected(null);
        return;
      }

      if (tool || showEditor || !layout || !selected) return;

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
  }, [layout, selected, panel, tool, showEditor, showTerminal]);

  function toggleEditor() {
    if (!graph) {
      setError("Open a repository first.");
      return;
    }
    setShowEditor((v) => {
      if (v) {
        setDiffCompare(null);
        return false;
      }
      setPanel(null);
      return true;
    });
  }


  function toggleTerminal() {
    if (!graph) {
      setError("Open a repository first.");
      return;
    }
    setShowTerminal((v) => !v);
  }

  /** The theme switch repaints everything, so the whole window cross-fades instead of snapping. */
  function switchTheme(next: Theme) {
    crossFade(() =>
      flushSync(() => {
        setThemeFlipped(true);
        setTheme(next);
      }),
    );
  }


  // Every path seen in the loaded history, offered as suggestions in the People tool.
  const filePaths = useMemo(
    () => [...new Set(graph?.commits.flatMap((c) => c.filesChanged.map((f) => f.path)) ?? [])].sort(),
    [graph],
  );
  const desktop = isTauri();
  const activeTool = TOOLS.find((t) => t.id === tool);

  return (
    <div className="app" data-theme={theme}>
      <header className="toolbar">
        <span className="app-name">Chronos</span>

        <form
          className="open-form"
          aria-busy={loading || undefined}
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

          <button
            className="btn tool-btn"
            type="button"
            onClick={() => void browse()}
            disabled={loading || !desktop}
            title={desktop ? "Choose the repository folder" : "Only available in the desktop app"}
          >
            <FolderIcon />
            <span className="tool-label">Browse…</span>
          </button>

          <button className="btn primary" type="submit" disabled={loading || !path.trim()}>
            Open
          </button>
        </form>
        <ScopeBar graph={graph} scope={scope} onChange={changeScope} />

        <button
          className="btn"
          disabled={loading || !graph}
          onClick={() => graph && void load(graph.repoPath)}
        >
          <ReloadIcon /> Reload
        </button>

        <BranchSwitcher
          graph={graph}
          currentBranch={currentBranch}
          onGraphChange={applyGraph}
          onError={setError}
        />

        <button className="btn primary" disabled={!graph} onClick={() => setShowPush(true)}>
          Push to Git
        </button>

        <button
          className="btn tool-btn"
          disabled={!graph || !desktop}
          onClick={() => void showInExplorer()}
          title={desktop ? "Show the repository folder in the file explorer" : "Only available in the desktop app"}
        >
          <ExplorerIcon />
          <span className="tool-label">Explorer</span>
        </button>

        <div className="tools" role="group" aria-label="Tools">
          {TOOLS.map(({ id, label, hint, icon: Icon }) => (
            <button
              key={id}
              className="btn tool-btn"
              aria-pressed={tool === id}
              onClick={() => toggleTool(id)}
              title={hint}
            >
              <Icon />
              <span className="tool-label">{label}</span>
            </button>
          ))}
          <span className="toolbar-sep" aria-hidden />
          <button
            className="btn tool-btn theme-switch"
            onClick={() => switchTheme(theme === "paper" ? "board" : "paper")}
            title={theme === "paper" ? "Switch to the blackboard theme" : "Switch to the paper theme"}
          >
            {/* Keyed so the new icon turns into place when the theme flips. */}
            <span key={theme} className={`theme-glyph${themeFlipped ? " is-turning" : ""}`}>
              <ThemeIcon to={theme === "paper" ? "board" : "paper"} />
            </span>
            <span className="tool-label-sm">{theme === "paper" ? "Blackboard" : "Paper"}</span>
          </button>
        </div>

        {loading && <div className="progress" role="progressbar" aria-label="Opening the repository" />}
      </header>

      {graph && showPush && (
        <PushPanel
          repoPath={graph.repoPath}
          graph={graph}
          currentBranch={currentBranch}
          onGraphChange={applyGraph}
          onClose={() => setShowPush(false)}
        />
      )}

      <Presence show={Boolean(error)} className="banner-roll" exitMs={160}>
        {error && (
          <div className="banner-clip">
            <div className="banner" role="alert">
              {/* Keyed by the message, so a new error nudges in even while the banner is already open. */}
              <span key={error} className="banner-text">
                <WarnIcon />
                <span>{error}</span>
              </span>
              <button className="btn" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </Presence>

      <main className="stage">
        <div className="workspace">
          {/* The graph or the code editor; the editor overlays only this area, so a
              tool drawer beside it stays visible. */}
          <div className="workspace-main">
          {graph && layout && scoped ? (
            showEditor ? null : layout.nodes.length === 0 ? (
              <div key={scopeKey(scope)} className="empty shell-empty">
                <EmptyScopeDoodle />
                <h1>Nothing here</h1>
                <p>No loaded commit touches this {scope.kind}.</p>
                <button type="button" className="btn shell-empty-action" onClick={() => changeScope(PROJECT)}>
                  Show the whole project
                </button>
              </div>
            ) : (
              <CommitGraph
                key={scopeKey(scope)}
                graph={scoped.graph}
                layout={layout}
                selected={selected}
                panelOpen={panel !== null}
                scope={scope}
                gone={scoped.gone}
                currentBranch={currentBranch}
                onSelect={pick}
                onAction={(mode) => {
                  setTool(null);
                  setPanel({ mode, id: Date.now() });
                }}
              />
            )
          ) : loading ? (
            // First load: say what's happening. The text fades in after a beat, so a
            // quick open doesn't flash it.
            <div key="opening" className="empty shell-empty is-waiting" aria-live="polite">
              <HistoryDoodle />
              <h1>Reading the history…</h1>
              <p>Following every commit in {path.split(/[/\\]/).filter(Boolean).pop() || "the folder"}.</p>
            </div>
          ) : (
            <div key="start" className="empty shell-empty">
              <HistoryDoodle />
              <h1>Open a repository</h1>
              <p>
                {desktop
                  ? "Pick a Git repository folder, or write its path in the bar above, then choose Open."
                  : "Write a Git repository's folder path in the bar above, then choose Open."}
              </p>
              {desktop && (
                <button type="button" className="btn primary tool-btn shell-empty-action" onClick={() => void browse()}>
                  <FolderIcon />
                  Browse for a folder…
                </button>
              )}
            </div>
          )}

          <Presence show={Boolean(graph && layout && scoped && showEditor)} className="editor-layer" exitMs={160}>
            {graph && layout && scoped && (
              <CodeEditor
                repoPath={graph.repoPath}
                graph={scoped.graph}
                layout={layout}
                selected={selected}
                compare={diffCompare}
                onSelect={pick}
                onCompare={setDiffCompare}
                onClose={closeEditor}
              />
            )}
          </Presence>
          </div>

          <Presence show={Boolean(graph && layout && scoped && selectedNode && panel && !showEditor)} className="slide-panel">
          {graph && layout && scoped && selectedNode && panel && !showEditor && (
            <CommitDetails
              key={`${selectedNode.commit.hash}:${panel.id}`}
              start={panel.mode}
              repoPath={graph.repoPath}
              graph={scoped.graph}
              layout={layout}
              commit={selectedNode.commit}
              lane={layout.lanes[selectedNode.lane]}
              scope={scope}
              pathAtCommit={scoped.pathAt.get(selectedNode.commit.hash)}
              removed={scoped.gone.has(selectedNode.commit.hash)}
              currentBranch={currentBranch}
              onGraphChange={applyGraph}
              onSelect={(hash) => {
                setSelected(hash);
                setPanel({ mode: "details", id: Date.now() });
              }}
              onOpenSideDiff={() => openSideDiff(selectedNode.commit.hash)}
              onClose={() => setPanel(null)}
            />
          )}
          </Presence>

          <Presence show={Boolean(activeTool && !panel)} className="slide-panel">
            {activeTool && (
              <ToolDrawer title={activeTool.title} icon={activeTool.icon} onClose={() => setTool(null)}>
                <div key={activeTool.id} className="tool-swap">
                  {activeTool.id === "ai" && <AiPanel />}
                  {activeTool.id === "reviews" && <BugCheckPanel />}
                  {activeTool.id === "people" && (
                    <ContributorsPanel repoPath={graph?.repoPath ?? path} filePaths={filePaths} />
                  )}
                </div>
              </ToolDrawer>
            )}
          </Presence>
        </div>

        <Presence show={Boolean(graph && showTerminal)} className="dock-panel" exitMs={200}>
          {graph && (
            <Terminal
              repoPath={graph.repoPath}
              repoLabel={repoLabel}
              onGraphChange={applyGraph}
              onClose={() => setShowTerminal(false)}
            />
          )}
        </Presence>

        <div className="dock-toggles" role="toolbar" aria-label="Views">
          <button
            type="button"
            className={`btn dock-key${showEditor ? " primary" : ""}`}
            aria-pressed={showEditor}
            onClick={toggleEditor}
          >
            Code editor
          </button>
          <button
            type="button"
            className={`btn dock-key${showTerminal ? " primary" : ""}`}
            aria-pressed={showTerminal}
            onClick={toggleTerminal}
          >
            Terminal
          </button>
        </div>
      </main>

      <footer className="statusbar">
        {graph ? (
          <>
            <span className="status-path" title={graph.repoPath}>
              {graph.repoPath}
            </span>
            {/* Keyed by value: a changed figure ticks in, so a reload or scope change is noticed. */}
            <span key={`b:${currentBranch}`} className="status-tick">
              {currentBranch ? `On ${currentBranch}` : "Detached HEAD"}
            </span>
            <span key={`c:${scoped?.graph.commits.length ?? 0}:${scope.kind}`} className="status-tick">
              {scoped?.graph.commits.length ?? 0} commits{scope.kind !== "project" ? ` touching this ${scope.kind}` : ""}
            </span>
            <span key={`r:${graph.branches.length}`} className="status-tick">
              {graph.branches.length} branches
            </span>
          </>
        ) : (
          <span className="status-path">{loading ? "Opening…" : "No repository open"}</span>
        )}

        <span
          className={`status-conn${connected === false ? " status-bad" : connected ? " is-ok" : ""}`}
          title={connected === false ? undefined : connected ? "Backend connected" : "Connecting to the backend"}
        >
          <span className="status-dot" aria-hidden />
          {connected === false ? "Backend not connected" : connected ? version : "Connecting…"}
        </span>
      </footer>
    </div>
  );
}

export default App;
