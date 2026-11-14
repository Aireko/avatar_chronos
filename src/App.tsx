import {
  type ReactElement,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import "@fontsource/patrick-hand/400.css";
// Base doodle styles first, so the tool panels' stylesheets (imported by the
// components below) can refine shared classes like .field and .btn.
import "./graph/graph.css";
import "./tools/tools.css";
import "./graph/find.css";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import AiPanel, { type AiRequest } from "./ai/AiPanel";
import { buildExplainPrompt } from "./ai/explainPrompt";
import { appDataDir, join } from "@tauri-apps/api/path";
import { backendVersion, errorMessage, exportGraph, runGitCommand, type ChronosGraph, type Commit } from "./backend";
import ContributorsPanel from "./blame/ContributorsPanel";
import BugCheckPanel from "./bugcheck/BugCheckPanel";
import { CodeEditor, type DiffCompare } from "./graph/CodeEditor";
import { CommitDetails } from "./graph/CommitDetails";
import { CommitGraph, type PanelMode } from "./graph/CommitGraph";
import { FindBar } from "./graph/FindBar";
import { findJumpTarget, findMatches, stepMatch } from "./graph/findCommits";
import { carryIds, layoutGraph } from "./graph/layout";
import { Terminal } from "./graph/Terminal";
import { CallGraphView } from "./graph/CallGraphView";
import { ScopeBar, type FunctionView } from "./graph/ScopeBar";
import { BranchSwitcher } from "./push/BranchSwitcher";
import { PushPanel } from "./push/PushPanel";
import { PROJECT, scopeGraph, scopeKey, type Scope } from "./graph/scope";
import ContextViewsPanel from "./context/ContextViewsPanel";
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
  SearchIcon,
  SparkIcon,
  ThemeIcon,
  WarnIcon,
} from "./tools/icons";
import { PathField } from "./tools/PathField";
import { Presence } from "./tools/Presence";
import { addRecentRepo, loadRecentRepos, nativeRepoPath, removeRecentRepo, saveRecentRepos } from "./tools/recentRepos";
import { ToolDrawer, type ToolId } from "./tools/ToolDrawer";

const TOOLS: { id: ToolId; label: string; title: string; hint: string; icon: () => ReactElement }[] = [
  { id: "ai", label: "Local AI", title: "Local AI", hint: "Local Qwen model through Ollama", icon: SparkIcon },
  { id: "reviews", label: "PR reviews", title: "PR reviews", hint: "Check GitHub pull requests for bugs", icon: ReviewIcon },
  { id: "people", label: "People", title: "Who worked on this?", hint: "Find who wrote a file and email them", icon: PeopleIcon },
];

/** Merely reading window.localStorage can throw when storage is blocked; the recentRepos helpers catch it. */
const browserStorage = () => window.localStorage;

/**
 * `git show` for "Explain this commit". The backend re-exports the graph after every git
 * command, so it writes to its own scratch file: never the chronos_graph.json that Open
 * and Reload write and read back at the same moment. Never throws: without a patch the
 * prompt explains from the commit's metadata.
 */
async function readPatch(repoPath: string, hash: string): Promise<{ patch: string | null; patchTruncated: boolean }> {
  try {
    const scratch = await join(await appDataDir(), "chronos_explain_graph.json");
    const run = await runGitCommand(repoPath, `show --no-color --format=fuller ${hash}`, scratch);
    if (run.result.ok) return { patch: run.result.stdout, patchTruncated: run.result.stdoutTruncated };
  } catch {
    // Fall through: no patch.
  }
  return { patch: null, patchTruncated: false };
}

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
  const [functionView, setFunctionView] = useState<FunctionView>("history");
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ mode: PanelMode; id: number } | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [diffCompare, setDiffCompare] = useState<DiffCompare | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showPush, setShowPush] = useState(false);
  const [showContext, setShowContext] = useState(false);
  // At most one drawer is open on the right: a tool or the commit details.
  const [tool, setTool] = useState<ToolId | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ids = useRef(new Map<string, string>());
  // Repositories that opened successfully, newest first.
  const [recent, setRecent] = useState(() => loadRecentRepos(browserStorage));
  // Find a commit (Ctrl+F). The query survives closing the bar.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findFocus, setFindFocus] = useState(0);
  // Where focus goes back to when the bar closes; commit nodes on the map are SVG elements.
  const findReturn = useRef<HTMLElement | SVGElement | null>(null);
  const findToggle = useRef<HTMLButtonElement>(null);
  // Fade every other author's commits on the map.
  const [highlightAuthor, setHighlightAuthor] = useState<string | null>(null);
  // "Explain this commit": a prompt handed to the Local AI drawer.
  const [aiRequest, setAiRequest] = useState<AiRequest | null>(null);
  const explainSeq = useRef(0);
  // Explains run their `git show` one at a time, as they share one scratch graph file.
  const explainQueue = useRef<Promise<unknown>>(Promise.resolve());
  const loadSeq = useRef(0);
  const toolRef = useRef(tool);
  toolRef.current = tool;

  const scoped = useMemo(() => (graph ? scopeGraph(graph, scope) : null), [graph, scope]);
  const layout = useMemo(
    () => (scoped ? layoutGraph(scoped.graph.commits, scoped.graph.branches, scoped.graph.head, ids.current) : null),
    [scoped],
  );

  const selectedNode = selected && layout ? layout.byHash.get(selected) : undefined;
  const currentBranch = graph?.branches.find((b) => b.isHead)?.name ?? null;
  const repoLabel = graph?.repoPath.split(/[/\\]/).filter(Boolean).pop() || graph?.repoPath || "repo";

  // The call map replaces the commit map while a function is in scope and "Calls" is chosen.
  const callsShown = Boolean(graph?.head && scope.kind === "function" && functionView === "calls" && !showContext);
  // The map is on screen (not the editor, not an empty scope): find and the author chip live on it.
  const mapShown = Boolean(
    graph && layout && scoped && !showEditor && !showContext && !callsShown && layout.nodes.length > 0,
  );
  const findShown = findOpen && mapShown;
  // Matches among the commits in view, newest first like the history itself.
  // Deferred, so typing stays quick on a big history: the scan, the marks and the jump to
  // the first match follow once React has a moment, and skip the in-between keystrokes.
  const findTerm = useDeferredValue(findQuery);
  const found = useMemo(
    () => (findShown && scoped ? findMatches(scoped.graph.commits, findTerm) : []),
    [findShown, scoped, findTerm],
  );
  const foundIndex = selected ? found.indexOf(selected) : -1;
  // The query the selection last followed; reopening the bar or a reload doesn't move it.
  const jumpedFor = useRef(findQuery);

  useEffect(() => saveRecentRepos(browserStorage, recent), [recent]);

  // The find bar belongs to the map: when the editor or an empty scope replaces the map,
  // close it, so it doesn't spring back (and take focus) when the map returns.
  useEffect(() => {
    if (!mapShown) setFindOpen(false);
  }, [mapShown]);

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

    // Only the newest load may apply its result: an older one that finishes later is dropped.
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");

    try {
      const { graph: next } = await exportGraph(repo);
      if (seq !== loadSeq.current) return;
      // The repository root the backend resolved, so subfolders and other spellings share one entry.
      setRecent((list) => addRecentRepo(list, nativeRepoPath(next.repoPath)));

      if (graph && next.repoPath === graph.repoPath) {
        applyGraph(next);
      } else {
        ids.current = new Map();
        setGraph(next);
        setSelected(null);
        setPanel(null);
        setScope(PROJECT);
        setFunctionView("history");
        setHighlightAuthor(null);
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(errorMessage(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  function changeScope(next: Scope) {
    setScope(next);
    // Picking another function keeps the call map open; any other scope goes back to history.
    if (next.kind !== "function") setFunctionView("history");
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

  /** Selects a commit found by the find bar; the map glides to it, and an open ticket follows. */
  function goToCommit(hash: string) {
    setSelected(hash);
    if (panel) setPanel({ mode: "details", id: Date.now() });
  }

  function openFind() {
    if (!mapShown) return;
    if (!findOpen) {
      const active = document.activeElement;
      findReturn.current =
        (active instanceof HTMLElement || active instanceof SVGElement) && active !== document.body ? active : null;
      setFindOpen(true);
    }
    // Focus (and select) the query, also when the bar is already open.
    setFindFocus((n) => n + 1);
  }

  /** Closes the find bar and puts focus back where it was before it opened. */
  function closeFind() {
    setFindOpen(false);
    const back = findReturn.current;
    findReturn.current = null;
    (back?.isConnected ? back : findToggle.current)?.focus();
  }

  // Typing a new query jumps to the first match, unless the selected commit still matches.
  // It follows the deferred matches (no second scan), and as a transition, so redrawing the
  // map's selection never holds up the next keystroke.
  useEffect(() => {
    if (jumpedFor.current === findTerm) return;
    jumpedFor.current = findTerm;
    const target = findJumpTarget(found, selected);
    if (target) startTransition(() => goToCommit(target));
    // Only a new query moves the selection; `selected` and `panel` are read as they are now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, findTerm]);

  function stepFind(dir: 1 | -1) {
    const next = stepMatch(foundIndex, found.length, dir);
    // A transition, like the jump while typing: holding Enter must not queue map redraws.
    if (next >= 0) startTransition(() => goToCommit(found[next]));
  }

  function clearHighlight() {
    setHighlightAuthor(null);
    // The chip's × goes away with the chip; keep keyboard focus on the map's controls.
    findToggle.current?.focus();
  }

  /** Opens the Local AI drawer and asks it to explain `commit` in plain language. */
  async function explainCommit(commit: Commit) {
    if (!graph) return;
    const seq = ++explainSeq.current;
    const repoPath = graph.repoPath;
    // A scoped map trims the commit's files to the scoped one and rewires its parents to
    // the nearest kept commits; the model gets the real commit.
    const full = graph.commits.find((c) => c.hash === commit.hash) ?? commit;
    setPanel(null);
    setTool("ai");
    toolRef.current = "ai";
    // The drawer says at once what it is waiting for, instead of offering its old prompt.
    setAiRequest({ id: seq, subject: `commit ${full.shortHash}` });
    const read = explainQueue.current.then(() => readPatch(repoPath, full.hash));
    explainQueue.current = read;
    const { patch, patchTruncated } = await read;
    // Dropped when another explain started (its own request replaced this one) ...
    // ... or the drawer was closed meanwhile (closing it bumps the sequence as well).
    if (seq !== explainSeq.current || toolRef.current !== "ai") return;
    const { prompt, system } = buildExplainPrompt({ commit: full, patch, patchTruncated });
    setAiRequest({ id: seq, prompt, system, subject: `commit ${full.shortHash}` });
  }

  const takeAiRequest = useCallback((id: number) => {
    setAiRequest((current) => (current?.id === id ? null : current));
  }, []);

  // A request nobody took (the drawer closed or switched first) must not run the next
  // time the Local AI drawer is opened by hand. That includes an explain whose `git show`
  // is still running: bumping the sequence drops its result when it lands, even if the
  // drawer was opened by hand again meanwhile. (explainCommit opens the drawer in the same
  // batch as it takes its number, so this never cancels the explain that opened it.)
  useEffect(() => {
    if (tool !== "ai") {
      explainSeq.current++;
      setAiRequest(null);
    }
  }, [tool]);

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

  // Esc closes the commit panel, then a tool, the editor, the find bar, the terminal, then
  // clears the author highlight, and finally the selection; inside the find bar, it closes
  // the find bar first. Arrow keys move along the branch.

  // Ctrl+F opens the find bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        // Never the webview's own find bar while the app has focus. Ctrl+F opens the find
        // bar from anywhere, toolbar fields included (in its own field it selects the query
        // again), except inside the code editor or the terminal, where it does nothing.
        e.preventDefault();
        const inEditorOrTerminal =
          target instanceof HTMLElement && target.closest(".editor-layer, .dock-panel") !== null;
        if (!inEditorOrTerminal) openFind();
        return;
      }

      if (typing) return;

      if (e.key === "Escape") {
        // On the find bar's own buttons, Esc closes the find bar first, as it does in its field.
        if (findShown && target instanceof Element && target.closest(".find-bar")) {
          closeFind();
          return;
        }
        if (panel) setPanel(null);
        else if (tool) setTool(null);
        else if (showEditor) {
          setShowEditor(false);
          setDiffCompare(null);
        } else if (findShown) closeFind();
        else if (showTerminal) setShowTerminal(false);
        else if (showContext) setShowContext(false);
        else if (callsShown) setFunctionView("history");
        else if (highlightAuthor !== null) {
          // On the chip's own ×, focus would drop to the page as the chip goes; anywhere
          // else (the map), it stays where it is.
          if (target instanceof Element && target.closest(".highlight-chip")) clearHighlight();
          else setHighlightAuthor(null);
        } else setSelected(null);
        return;
      }

      if (tool || showEditor || showContext || callsShown || !layout || !selected) return;

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
    // openFind / closeFind only read the state listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, selected, panel, tool, showEditor, showTerminal, showContext, callsShown, findOpen, findShown, mapShown, highlightAuthor]);

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
      setShowContext(false);
      return true;
    });
  }


  function toggleTerminal() {
    if (!graph) {
      setError("Open a repository first.");
      return;
    }
    setShowTerminal((v) => !v);
    setShowContext(false);
  }

  function toggleContext() {
    if (!graph) {
      setError("Open a repository first.");
      return;
    }
    setShowContext((visible) => {
      if (!visible) {
        setShowEditor(false);
        setDiffCompare(null);
        setShowTerminal(false);
      }
      return !visible;
    });
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
          <PathField
            value={path}
            onChange={setPath}
            recent={recent}
            onPick={(picked) => {
              setPath(picked);
              void load(picked);
            }}
            onRemove={(gone) => setRecent((list) => removeRecentRepo(list, gone))}
            disabled={loading}
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
        <ScopeBar
          graph={graph}
          scope={scope}
          onChange={changeScope}
          view={functionView}
          onViewChange={(next) => {
            setFunctionView(next);
            if (next === "calls") setPanel(null);
          }}
        />

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
          {/* The graph, context compiler, or code editor; the editor overlays only
              this area, so a tool drawer beside it stays visible. */}
          <div className="workspace-main">
          {graph && showContext ? (
            <div className="context-panel">
              <ContextViewsPanel key={graph.repoPath} repoPath={graph.repoPath} />
            </div>
          ) : graph && layout && scoped ? (
            showEditor ? null : callsShown && scope.kind === "function" && graph.head ? (
              <CallGraphView
                key={`${scopeKey(scope)}@${graph.head}`}
                repoPath={graph.repoPath}
                revision={graph.head}
                path={scope.path}
                name={scope.name}
                onClose={() => setFunctionView("history")}
              />
            ) : layout.nodes.length === 0 ? (
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
                highlightAuthor={highlightAuthor}
                findMarks={findShown ? found : undefined}
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

          {/* Find a commit, and the author highlight chip, pinned to the top right of the map. */}
          {mapShown && (
            <div className="graph-dock">
              <div className="find-row">
                <Presence show={findShown} className="find-pop" exitMs={140}>
                  <FindBar
                    query={findQuery}
                    onQuery={setFindQuery}
                    current={foundIndex}
                    count={found.length}
                    onStep={stepFind}
                    onClose={closeFind}
                    focusKey={findFocus}
                  />
                </Presence>
                <button
                  ref={findToggle}
                  type="button"
                  className="btn tool-btn find-toggle"
                  aria-pressed={findShown}
                  aria-keyshortcuts="Control+F"
                  title="Find a commit (Ctrl+F)"
                  onClick={() => (findShown ? closeFind() : openFind())}
                >
                  <SearchIcon />
                  <span className="tool-label-sm">Find</span>
                </button>
              </div>
              <Presence show={highlightAuthor !== null} className="chip-pop" exitMs={140}>
                {highlightAuthor !== null && (
                  <div className="highlight-chip">
                    <span className="highlight-text" title={`Highlighting ${highlightAuthor}'s commits`}>
                      Highlighting <span className="highlight-name">{highlightAuthor}</span>
                    </span>
                    <button
                      type="button"
                      className="highlight-clear"
                      onClick={clearHighlight}
                      aria-label={`Stop highlighting ${highlightAuthor}`}
                      title="Stop highlighting (Esc)"
                    >
                      ×
                    </button>
                  </div>
                )}
              </Presence>
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
              highlightedAuthor={highlightAuthor}
              onHighlightAuthor={setHighlightAuthor}
              onExplain={() => void explainCommit(selectedNode.commit)}
            />
          )}
          </Presence>

          <Presence show={Boolean(activeTool && !panel)} className="slide-panel">
            {activeTool && (
              <ToolDrawer title={activeTool.title} icon={activeTool.icon} onClose={() => setTool(null)}>
                <div key={activeTool.id} className="tool-swap">
                  {activeTool.id === "ai" && <AiPanel request={aiRequest} onRequestTaken={takeAiRequest} />}
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
          <button
            type="button"
            className={`btn dock-key${showContext ? " primary" : ""}`}
            aria-pressed={showContext}
            onClick={toggleContext}
          >
            Context compiler
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
