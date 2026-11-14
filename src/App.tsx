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
import "./tools/toolbar.css";
import "./graph/find.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import AiPanel, { type AiRequest } from "./ai/AiPanel";
import { buildExplainPrompt } from "./ai/explainPrompt";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  backendVersion,
  errorMessage,
  exportGraph,
  runGitCommand,
  runShellCommand,
  type ChronosGraph,
  type Commit,
} from "./backend";
import ContributorsPanel from "./blame/ContributorsPanel";
import { PanelBoundary } from "./tools/PanelBoundary";
import BugCheckPanel from "./bugcheck/BugCheckPanel";
import { CodeEditor, type DiffCompare } from "./graph/CodeEditor";
import { CommitDetails } from "./graph/CommitDetails";
import { CommitGraph, type PanelMode } from "./graph/CommitGraph";
import { FindBar } from "./graph/FindBar";
import { findJumpTarget, findMatches, stepMatch } from "./graph/findCommits";
import { carryIds, layoutGraph } from "./graph/layout";
import { Terminal } from "./graph/Terminal";
import { CallGraphView } from "./graph/CallGraphView";
import { ScopeBar } from "./graph/ScopeBar";
import { FunctionViewSwitch, callsOffReason, type FunctionView } from "./graph/FunctionViewSwitch";
import { BranchSwitcher } from "./push/BranchSwitcher";
import { PushPanel } from "./push/PushPanel";
import { PROJECT, scopeGraph, scopeKey, type Scope } from "./graph/scope";
import ContextViewsPanel from "./context/ContextViewsPanel";
import { useTheme, type Theme } from "./tools/theme";
import { crossFade } from "./tools/crossFade";
import {
  EmptyScopeDoodle,
  FolderIcon,
  HistoryDoodle,
  PeopleIcon,
  PushIcon,
  ReviewIcon,
  SearchIcon,
  SparkIcon,
  ThemeIcon,
  WarnIcon,
} from "./tools/icons";
import { PathField } from "./tools/PathField";
import { Presence } from "./tools/Presence";
import { RepoTicket } from "./tools/RepoTicket";
import { Tip } from "./tools/Tip";
import { isRepoShortcut } from "./tools/toolbarKeys";
import { addRecentRepo, loadRecentRepos, nativeRepoPath, removeRecentRepo, saveRecentRepos } from "./tools/recentRepos";
import { ToolDrawer, type ToolId } from "./tools/ToolDrawer";
import { historyChanged, isToolSwap } from "./tools/appLogic";
import { busyFinishedNote, headText, pauseCopy, pausedOp, withBusy, type PausedOp } from "./tools/appStatus";

/** How long the "History up to date" note stays after a reload. */
const RELOAD_NOTE_MS = 2600;

/** What the "unsaved edits" question says about the step that would lose them. */
type LeaveAsk = { title: string; discard: string };
const LEAVE_CLOSE: LeaveAsk = { title: "Close the editor?", discard: "Discard and close" };
const LEAVE_SCOPE: LeaveAsk = { title: "Switch the history view?", discard: "Discard and switch" };
const LEAVE_REPO: LeaveAsk = { title: "Open the other repository?", discard: "Discard and open" };
const LEAVE_REFRESH: LeaveAsk = { title: "Reload the editor's files?", discard: "Discard and reload" };
const LEAVE_COMPARE: LeaveAsk = { title: "Compare with another commit?", discard: "Discard and compare" };
const LEAVE_QUIT: LeaveAsk = { title: "Close Chronos?", discard: "Discard and close Chronos" };

/** How long a "finished working" announcement stays in the live region. */
const TOOL_NOTE_MS = 5000;

/** Panels whose opener gets the keyboard back when they close. */
type Opener = "panel" | "tool" | "editor" | "terminal" | "context" | "leave";

/**
 * After a panel closes, put keyboard focus on `target` if focus was dropped with the
 * panel (onto <body>, or still inside the closing, inert copy). Runs after React commits.
 */
function focusLater(target: () => Element | null | undefined) {
  window.requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest("[inert],[hidden]")) return;
    const el = target();
    if (el instanceof HTMLElement || el instanceof SVGElement) {
      if (el.isConnected && !el.closest("[inert],[hidden]")) el.focus({ preventScroll: true });
    }
  });
}

/** Put the keyboard in the terminal's prompt once the dock is showing. */
function focusTerminalSoon() {
  window.requestAnimationFrame(() =>
    document.querySelector<HTMLInputElement>(".dock-panel:not(.is-leaving) .term-input")?.focus({ preventScroll: true }),
  );
}

/** The commit the map has selected, as a focusable node. */
function selectedNodeEl(): Element | null {
  return document.querySelector(".stage .node.selected");
}

/**
 * Where the keyboard lands when nothing better is left: the toolbar's path field before a
 * repository is open (or in the open repository pop-up), otherwise the repository ticket.
 */
function pathInputEl(): HTMLElement | null {
  return (
    // Not the field of a pop-up that is still playing its exit (it is inert by then).
    document.querySelector<HTMLInputElement>(
      ".toolbar .open-form .path-input:not(:disabled), .toolbar .repo-pop:not(.is-leaving) .path-input:not(:disabled)",
    ) ??
    document.querySelector<HTMLButtonElement>(".toolbar .repo-ticket")
  );
}

/** What a reload found, in a few words for the status bar. */
function reloadText(added: number, dropped: number): string {
  if (added > 0) return `${added} new commit${added === 1 ? "" : "s"}`;
  if (dropped > 0) return `${dropped} commit${dropped === 1 ? "" : "s"} gone`;
  return "History up to date";
}

/** A small hand-drawn tick for the reload note; it draws itself in. */
function TickGlyph() {
  return (
    <svg className="reload-tick" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M2.2 7.6 L5.4 10.6 L11.8 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
      />
    </svg>
  );
}

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
  // `focus`: the ticket takes the keyboard when it opens (not while arrow keys walk the map).
  const [panel, setPanel] = useState<{ mode: PanelMode; id: number; focus: boolean } | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [diffCompare, setDiffCompare] = useState<DiffCompare | null>(null);
  // File the plain editor opens first (a HEAD file picked in the commit ticket).
  const [editorStart, setEditorStart] = useState<string | null>(null);
  // The editor has edits that are not saved (reported by CodeEditor).
  const [editorDirty, setEditorDirty] = useState(false);
  // Bumped to make the editor read its files again in place (keeping the open file,
  // cursor and scroll). Only bumped once unsaved edits have been asked about.
  const [refreshToken, setRefreshToken] = useState(0);
  // The history moved while the editor was open, so its files may be out of date.
  const [editorStale, setEditorStale] = useState(false);
  // A step that would close or reload the editor, waiting for "Discard" or "Keep editing".
  const [leave, setLeave] = useState<(LeaveAsk & { go: () => void }) | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showPush, setShowPush] = useState(false);
  const [showContext, setShowContext] = useState(false);
  // At most one drawer is open on the right: a tool or the commit details.
  const [tool, setTool] = useState<ToolId | null>(null);
  // The drawer keeps showing the last tool while it slides away, and every tool that
  // has been opened stays mounted (hidden), so its downloads and checks keep going.
  const [lastTool, setLastTool] = useState<ToolId | null>(null);
  const [openedTools, setOpenedTools] = useState<ReadonlySet<ToolId>>(() => new Set());
  // Switching straight from one tool to another re-inks the drawer (opening does not).
  const [toolSwap, setToolSwap] = useState(false);
  // Tools working in the background (a model download, a PR check), as they report it.
  const [busyTools, setBusyTools] = useState<ReadonlySet<ToolId>>(() => new Set());
  // "Local AI finished working.", for screen readers, when it happened out of sight.
  const [toolNote, setToolNote] = useState("");
  // A rebase or merge stopped on a conflict and is waiting to be continued or aborted.
  const [paused, setPaused] = useState<PausedOp | null>(null);
  const [pauseBusy, setPauseBusy] = useState<"abort" | "continue" | null>(null);
  // Bumped to look again for a paused rebase or merge (after continuing or aborting one).
  const [pauseCheck, setPauseCheck] = useState(0);
  const rebasePaused = paused === "rebase";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // What the last reload found; keyed by `n` so a repeat reload stamps it again.
  const [reloadNote, setReloadNote] = useState<{ text: string; fresh: boolean; n: number } | null>(null);
  const ids = useRef(new Map<string, string>());
  // Repositories that opened successfully, newest first.
  const [recent, setRecent] = useState(() => loadRecentRepos(browserStorage));
  // The repository pop-up under the toolbar's ticket (Ctrl+O / Ctrl+L), and a counter
  // bumped to put the keyboard back in its path field.
  const [repoPop, setRepoPop] = useState(false);
  const [repoFocus, setRepoFocus] = useState(0);
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

  // Read by callbacks that outlive a render (a terminal command finishing later, say).
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const errorRef = useRef(error);
  errorRef.current = error;
  const showEditorRef = useRef(showEditor);
  showEditorRef.current = showEditor;
  const dirtyRef = useRef(false);
  const busyRef = useRef<ReadonlySet<ToolId>>(busyTools);
  // The tool whose pane is on screen right now (none while the drawer is closed).
  const toolInViewRef = useRef<ToolId | null>(null);
  toolInViewRef.current = tool && !panel ? tool : null;

  // Where keyboard focus goes back to when each panel closes.
  const openers = useRef<Partial<Record<Opener, Element | null>>>({});
  const editorKey = useRef<HTMLButtonElement>(null);
  const terminalKey = useRef<HTMLButtonElement>(null);
  const contextKey = useRef<HTMLButtonElement>(null);
  const toolKeys = useRef(new Map<ToolId, HTMLButtonElement>());
  const leaveKeep = useRef<HTMLButtonElement>(null);
  const leaveDiscard = useRef<HTMLButtonElement>(null);

  function rememberOpener(kind: Opener) {
    const el = document.activeElement;
    openers.current[kind] = el && el !== document.body ? el : null;
  }

  function returnFocus(kind: Opener, fallback?: () => Element | null | undefined) {
    const saved = openers.current[kind];
    openers.current[kind] = null;
    focusLater(() => (saved?.isConnected && !saved.closest("[inert],[hidden]") ? saved : fallback?.()));
  }

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    setEditorDirty(dirty);
  }, []);

  /**
   * Runs `go`, a step that closes, reloads or retargets the editor, but first asks
   * when the editor has unsaved edits.
   */
  function guardEditor(ask: LeaveAsk, go: () => void) {
    if (!showEditorRef.current || !dirtyRef.current) {
      go();
      return;
    }
    // Asked again while the question is already up (a second click on the window's X):
    // keep the first opener, or focus would end up on the question's own button.
    if (!leave) rememberOpener("leave");
    setLeave({ ...ask, go });
  }

  function keepEditing() {
    setLeave(null);
    returnFocus("leave");
  }

  function discardEdits() {
    const go = leave?.go;
    const opener = openers.current.leave;
    setLeave(null);
    openers.current.leave = null;
    dirtyRef.current = false;
    setEditorDirty(false);
    go?.();
    // Steps that move the keyboard themselves (closing the editor, say) have already
    // queued that, and this runs after them: it only catches focus left behind on the
    // closing question (e.g. after choosing another commit to compare with).
    focusLater(() =>
      opener?.isConnected && !opener.closest("[inert],[hidden]")
        ? opener
        : (document.querySelector(".editor-layer:not(.is-leaving) .file-search-input") ?? pathInputEl()),
    );
  }

  // The question takes the keyboard while it is up ("Keep editing" is the safe choice).
  useEffect(() => {
    if (leave) leaveKeep.current?.focus({ preventScroll: true });
  }, [leave]);

  // Reloading or closing the window would drop unsaved edits too, so the browser asks.
  useEffect(() => {
    if (!editorDirty || !showEditor) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Already discarded (the window is being closed after the question): let it go.
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editorDirty, showEditor]);

  // The desktop window's own close (title-bar X, Alt+F4) asks the same question as the
  // editor does. Only listened for while there are unsaved edits: with a listener in
  // place Tauri leaves closing to us, so the rest of the time the window closes as usual.
  const guardRef = useRef(guardEditor);
  guardRef.current = guardEditor;
  useEffect(() => {
    if (!editorDirty || !showEditor || !isTauri()) return;
    const win = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void) | undefined;
    win
      .onCloseRequested((event) => {
        // Saved in the meantime: let it close (the API destroys the window for us).
        if (!dirtyRef.current || !showEditorRef.current) return;
        event.preventDefault();
        guardRef.current(LEAVE_QUIT, () => {
          win.destroy().catch((e: unknown) => setError(`Couldn't close the window: ${errorMessage(e)}`));
        });
      })
      .then(
        (stop) => {
          if (alive) unlisten = stop;
          else stop();
        },
        () => {
          /* not in a Tauri window after all: the browser's own question still covers it */
        },
      );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [editorDirty, showEditor]);

  /** A tool reports that its long work started or stopped (see onBusyChange). */
  const setToolBusy = useCallback((id: ToolId, busy: boolean) => {
    const prev = busyRef.current;
    const next = withBusy(prev, id, busy);
    if (next === prev) return;
    busyRef.current = next;
    setBusyTools(next);
    const label = TOOLS.find((t) => t.id === id)?.label ?? "A tool";
    const note = busyFinishedNote(label, prev.has(id), busy, toolInViewRef.current === id);
    if (note) setToolNote(note);
  }, []);
  // One stable callback per tool, so the panels' effects don't re-run on every render.
  const onBusy = useMemo(
    () => ({
      ai: (busy: boolean) => setToolBusy("ai", busy),
      reviews: (busy: boolean) => setToolBusy("reviews", busy),
    }),
    [setToolBusy],
  );

  // The announcement clears itself, so the same words can be announced again next time.
  useEffect(() => {
    if (!toolNote) return;
    const timer = window.setTimeout(() => setToolNote(""), TOOL_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [toolNote]);

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

  // The reload note tidies itself away.
  useEffect(() => {
    if (!reloadNote) return;
    const timer = window.setTimeout(() => setReloadNote(null), RELOAD_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [reloadNote]);

  // Ask git whether a rebase or merge stopped on a conflict. A paused rebase leaves HEAD
  // detached, so REBASE_HEAD is only looked for then; a paused merge stays on its branch.
  useEffect(() => {
    if (!graph || !isTauri()) {
      setPaused(null);
      return;
    }
    let alive = true;
    const repo = graph.repoPath;
    const has = (ref: string) =>
      runShellCommand(repo, `git rev-parse -q --verify ${ref}`).then(
        (r) => r.ok && r.stdout.trim().length > 0,
        () => false,
      );
    void Promise.all([currentBranch ? false : has("REBASE_HEAD"), has("MERGE_HEAD")]).then(([rebase, merge]) => {
      if (alive) setPaused(pausedOp(rebase, merge));
    });
    return () => {
      alive = false;
    };
  }, [graph, currentBranch, pauseCheck]);

  /**
   * The files under the open editor may have changed on disk. Without unsaved edits it
   * just reads them again in place; with some, a note offers to (saving would overwrite).
   */
  function editorFilesMoved() {
    if (!showEditorRef.current) return;
    if (dirtyRef.current) {
      setEditorStale(true);
      return;
    }
    // Fresh files now, so an earlier "out of date" note (from before a save) goes too.
    setEditorStale(false);
    setRefreshToken((n) => n + 1);
  }

  /**
   * Swap in fresh history. Within the same repository, commits keep their identity so
   * changes animate. `filesMoved` says the files on disk may have changed even if the
   * history didn't (an explicit Reload).
   */
  function applyGraph(next: ChronosGraph, filesMoved = false) {
    const prev = graphRef.current;
    // A command from a repository that has since been closed: not this history.
    if (prev && next.repoPath !== prev.repoPath) return;
    ids.current = carryIds(prev?.commits ?? [], ids.current, next.commits);
    graphRef.current = next;
    setGraph(next);
    setSelected((current) =>
      current && next.commits.some((c) => c.hash === current) ? current : null,
    );
    // A checkout, pull or rebase can change the files the editor has open.
    if (filesMoved || historyChanged(prev, next)) editorFilesMoved();
  }

  /**
   * After a git command in the terminal. Many (checkout -- file, stash, restore) change
   * files without moving the history, so a clean editor reads its files again anyway;
   * with unsaved edits the note only comes up when the history moved.
   */
  function applyTerminalGraph(next: ChronosGraph) {
    const sameRepo = graphRef.current?.repoPath === next.repoPath;
    const moved = historyChanged(graphRef.current, next);
    applyGraph(next);
    if (sameRepo && !moved && !dirtyRef.current) editorFilesMoved();
  }

  /**
   * Close the editor now (callers have already asked about unsaved edits). `refocus`:
   * hand the keyboard back to whatever opened the editor (not when another view replaces it).
   */
  function closeEditorNow(refocus = true) {
    setShowEditor(false);
    setDiffCompare(null);
    setEditorStale(false);
    dirtyRef.current = false;
    setEditorDirty(false);
    if (refocus) returnFocus("editor", () => editorKey.current);
    else openers.current.editor = null;
  }

  function closeEditor() {
    guardEditor(LEAVE_CLOSE, closeEditorNow);
  }

  /** Read the editor's files again, in place: the open file, cursor and scroll stay. */
  function refreshEditor() {
    guardEditor(LEAVE_REFRESH, () => {
      setRefreshToken((n) => n + 1);
      setEditorStale(false);
      dirtyRef.current = false;
      setEditorDirty(false);
      // The note's button goes away; if the keyboard was on it, it lands in the editor.
      focusLater(() => document.querySelector(".editor-layer:not(.is-leaving) .file-search-input"));
    });
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
      // The field shows that root too, ready for the repository pop-up next time.
      const remember = () => {
        const root = nativeRepoPath(next.repoPath);
        setRecent((list) => addRecentRepo(list, root));
        setPath(root);
      };
      const current = graphRef.current;

      if (current && next.repoPath === current.repoPath) {
        const before = new Set(current.commits.map((c) => c.hash));
        const after = new Set(next.commits.map((c) => c.hash));
        const added = next.commits.filter((c) => !before.has(c.hash)).length;
        const dropped = current.commits.filter((c) => !after.has(c.hash)).length;
        remember();
        // Reload is the user asking for fresh files, so an open editor gets them too.
        applyGraph(next, true);
        setReloadNote((prev) => ({
          text: reloadText(added, dropped),
          fresh: added > 0 || dropped > 0,
          n: (prev?.n ?? 0) + 1,
        }));
      } else {
        // Another repository: everything tied to the old one goes (the editor, terminal,
        // context view and People tool are keyed by the repository, so they start over).
        // Kept editing instead: the other repository wasn't opened, so it isn't recorded.
        guardEditor(LEAVE_REPO, () => {
          remember();
          setReloadNote(null);
          ids.current = new Map();
          graphRef.current = next;
          setGraph(next);
          setSelected(null);
          setPanel(null);
          setScope(PROJECT);
          setFunctionView("history");
          setHighlightAuthor(null);
          setEditorStart(null);
          setPaused(null);
          // An explain still reading the old repository's patch is dropped when it lands.
          explainSeq.current++;
          setAiRequest(null);
          if (showEditorRef.current) closeEditorNow();
        });
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(errorMessage(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  /**
   * Opens or closes the repository pop-up. Opening fills the field with the open
   * repository, unless the last open failed: then the typed path stays, to be fixed.
   */
  const showRepoPop = useCallback((next: boolean) => {
    const current = graphRef.current;
    if (next && current && !errorRef.current) setPath(nativeRepoPath(current.repoPath));
    setRepoPop(next);
  }, []);

  /** Ctrl+O / Ctrl+L: the repository pop-up, or the toolbar's path field before one is open. */
  function openRepoPicker() {
    if (graphRef.current) {
      if (!repoPop) showRepoPop(true);
      setRepoFocus((n) => n + 1);
      return;
    }
    const field = document.querySelector<HTMLInputElement>(".toolbar .open-form .path-input");
    field?.focus();
    field?.select();
  }

  function changeScope(next: Scope) {
    const go = () => {
      setScope(next);
      // Picking another function keeps the call map open; any other scope, or a function
      // whose file has no call map (where Calls is off), goes back to history.
      if (next.kind !== "function" || callsOffReason(Boolean(graphRef.current?.head), next.path) !== null) {
        setFunctionView("history");
      }
      setSelected(null);
      setPanel(null);
      if (showEditorRef.current) closeEditorNow();
    };
    if (showEditor) guardEditor(LEAVE_SCOPE, go);
    else go();
  }

  /** Clicking a commit shows its action bar; the details panel only opens from that bar. */
  function pick(hash: string | null) {
    const commit = hash && graph ? graph.commits.find((c) => c.hash === hash) : undefined;
    // In the side-by-side editor, picking another commit compares with that one instead,
    // which reloads the working-tree pane.
    if (showEditor && diffCompare && commit && graph && commit.hash !== graph.head && commit.hash !== diffCompare.baseRev) {
      guardEditor(LEAVE_COMPARE, () => {
        setSelected(commit.hash);
        setPanel(null);
        setDiffCompare({ baseRev: commit.hash, baseLabel: commit.shortHash, headLabel: "working tree" });
      });
      return;
    }
    setSelected(hash);
    setPanel(null);
  }

  /**
   * Compare a commit with the working tree side by side, optionally opening one of its
   * files first. HEAD has nothing newer to compare, so its files open in the plain editor.
   */
  function openSideDiff(hash: string, path?: string) {
    const commit = graph?.commits.find((c) => c.hash === hash);
    if (!commit) return;
    if (commit.hash === graph?.head) {
      if (!path) return;
      setDiffCompare(null);
      setEditorStart(path);
    } else {
      setDiffCompare({
        baseRev: commit.hash,
        baseLabel: commit.shortHash,
        headLabel: "working tree",
        path,
      });
    }
    // The ticket's file button goes away with the ticket; closing the editor falls back
    // to the dock's Code editor key.
    rememberOpener("editor");
    setSelected(hash);
    setPanel(null);
    setEditorStale(false);
    // The editor and the context view each take the map's place: one at a time.
    setShowContext(false);
    setShowEditor(true);
  }

  /** Selects a commit found by the find bar; the map glides to it, and an open ticket follows. */
  function goToCommit(hash: string) {
    setSelected(hash);
    // The keyboard stays in the find bar; the new ticket doesn't take it.
    if (panel) setPanel({ mode: "details", id: Date.now(), focus: false });
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
    showTool("ai");
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

  /**
   * Show tool `next` in the drawer (or close the drawer for null). A tool, once opened,
   * stays mounted while hidden, so its work carries on.
   */
  function showTool(next: ToolId | null) {
    setToolSwap(isToolSwap(tool, next));
    setTool(next);
    if (next) {
      setLastTool(next);
      setOpenedTools((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    }
  }

  /** Opening a tool closes the commit details (they share the right-hand side), and vice versa. */
  function toggleTool(id: ToolId) {
    showTool(tool === id ? null : id);
    setPanel(null);
  }

  /** Close the tool drawer and hand the keyboard back to its toolbar button. */
  function closeTool() {
    const id = tool;
    setTool(null);
    setToolSwap(false);
    if (id) focusLater(() => toolKeys.current.get(id));
  }

  /** Close the commit ticket; the keyboard goes back to the commit on the map. */
  function closePanel() {
    setPanel(null);
    focusLater(selectedNodeEl);
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

  // Esc closes the commit panel, then a tool, the editor (asking about unsaved edits), the
  // find bar, the terminal, the context view, goes from the call map back to the history,
  // then clears the author highlight, and finally the selection; inside the find bar, it
  // closes the find bar first. Arrow keys move along the branch (not on the call map).

  // Ctrl+F opens the find bar, Ctrl+E toggles the editor and Ctrl+` the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The unsaved-edits question handles its own keys.
      if (leave) return;
      const target = e.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      // The Push dialog covers the window: the map, editor and terminal shortcuts wait until
      // it closes (they would act behind it). Esc closes it, as its Close key does, except
      // while typing the commit message.
      if (showPush) {
        if (e.key === "Escape" && !typing && !e.defaultPrevented) {
          e.preventDefault();
          setShowPush(false);
        }
        return;
      }

      // Ctrl+O / Ctrl+L (Cmd on a Mac) open the repository pop-up from anywhere but the
      // code editor and the terminal, which keep their own keys (Ctrl+L selects a line).
      if (isRepoShortcut(e)) {
        const inEditorOrTerminal =
          target instanceof HTMLElement && target.closest(".editor-layer, .dock-panel") !== null;
        if (inEditorOrTerminal) return;
        e.preventDefault();
        openRepoPicker();
        return;
      }

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

      // Ctrl+` toggles the terminal from anywhere, its own prompt included. Ctrl+E
      // toggles the editor, but not while typing, so it can't drop unsaved edits.
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        if (e.code === "Backquote" || e.key === "`") {
          e.preventDefault();
          toggleTerminal();
          return;
        }
        if (!typing && e.key.toLowerCase() === "e") {
          e.preventDefault();
          toggleEditor();
          return;
        }
      }

      if (typing) return;

      if (e.key === "Escape") {
        // On the find bar's own buttons, Esc closes the find bar first, as it does in its field.
        if (findShown && target instanceof Element && target.closest(".find-bar")) {
          closeFind();
          return;
        }
        if (panel) closePanel();
        else if (tool) closeTool();
        else if (showEditor) closeEditor();
        else if (findShown) closeFind();
        else if (showTerminal) closeTerminal();
        else if (showContext) closeContext();
        else if (callsShown) closeCalls();
        else if (highlightAuthor !== null) {
          // On the chip's own ×, focus would drop to the page as the chip goes; anywhere
          // else (the map), it stays where it is.
          if (target instanceof Element && target.closest(".highlight-chip")) clearHighlight();
          else setHighlightAuthor(null);
        } else setSelected(null);
        return;
      }

      // The map may handle its own arrow keys; then there is nothing left to do here.
      if (e.defaultPrevented) return;
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
        e.preventDefault();
        setSelected(next);
        // The ticket is replaced for the new commit; if the keyboard was in it, the new
        // one takes it (otherwise focus would drop to the top of the page).
        const inTicket = target instanceof Element && Boolean(target.closest(".slide-panel .ticket"));
        if (panel) setPanel({ mode: "details", id: Date.now(), focus: inTicket });
        // Keyboard focus walks with the selection, so Enter acts on the commit you see
        // highlighted (only when it was on the map to begin with).
        const onMap = target === document.body || (target instanceof Element && target.closest(".stage .node"));
        if (onMap) {
          window.requestAnimationFrame(() => {
            const node = selectedNodeEl();
            if (node instanceof SVGElement || node instanceof HTMLElement) node.focus({ preventScroll: true });
          });
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openFind / closeFind, openRepoPicker, toggleEditor, toggleTerminal and the close
    // helpers only read `graph`, the editor state and the rest of the state listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graph,
    layout,
    selected,
    panel,
    tool,
    showEditor,
    showTerminal,
    showContext,
    callsShown,
    findOpen,
    findShown,
    mapShown,
    highlightAuthor,
    leave,
    diffCompare,
    showPush,
    repoPop,
  ]);

  function toggleEditor() {
    if (!graph) {
      setError("Open a repository first.");
      return;
    }
    if (showEditor) {
      closeEditor();
      return;
    }
    rememberOpener("editor");
    setEditorStart(null);
    setEditorStale(false);
    setPanel(null);
    // The editor takes the context view's place, as it does the map's.
    setShowContext(false);
    openers.current.context = null;
    setShowEditor(true);
  }

  function closeTerminal() {
    setShowTerminal(false);
    returnFocus("terminal", () => terminalKey.current);
  }

  function toggleTerminal() {
    if (!graph) {
      setError("Open a repository first.");
      return;
    }
    if (showTerminal) {
      closeTerminal();
      return;
    }
    rememberOpener("terminal");
    // The terminal and the context view don't share the stage.
    setShowContext(false);
    openers.current.context = null;
    setShowTerminal(true);
    focusTerminalSoon();
  }

  function closeContext() {
    setShowContext(false);
    returnFocus("context", () => contextKey.current);
  }

  /**
   * History | Calls for the function in scope (the switch on the stage). Either one takes
   * the stage, so the editor (after asking about unsaved edits) and the context view make
   * way, should either be up; the switch itself is only shown when they are not. The
   * keyboard stays on the tab. The call map has no commit ticket, so choosing it closes it.
   */
  function changeFunctionView(next: FunctionView) {
    const go = () => {
      if (showEditorRef.current) closeEditorNow(false);
      setShowContext(false);
      openers.current.context = null;
      if (next === "calls") setPanel(null);
      setFunctionView(next);
    };
    if (showEditor) guardEditor(LEAVE_CLOSE, go);
    else go();
  }

  /** Back from the call map to the function's history; the keyboard goes to the Calls tab. */
  function closeCalls() {
    setFunctionView("history");
    focusLater(() => document.querySelector(".view-switch-pop:not(.is-leaving) .view-calls") ?? pathInputEl());
  }

  /** The context view takes the map's place (closing the editor, after asking, and the terminal). */
  function toggleContext() {
    if (!graph) {
      setError("Open a repository first.");
      return;
    }
    if (showContext) {
      closeContext();
      return;
    }
    rememberOpener("context");
    guardEditor(LEAVE_CLOSE, () => {
      // The keyboard stays on the context view's key rather than going back to the editor's opener.
      if (showEditorRef.current) closeEditorNow(false);
      setShowTerminal(false);
      openers.current.terminal = null;
      // The commit ticket belongs to the map, like it does when the editor opens.
      setPanel(null);
      setShowContext(true);
    });
  }

  /** Way out of a rebase or merge that stopped on a conflict. */
  async function finishPaused(op: PausedOp, how: "abort" | "continue") {
    const repo = graphRef.current?.repoPath;
    if (!repo) return;
    setPauseBusy(how);
    setError("");
    try {
      // (The backend runs git with a no-op editor, so continuing keeps each commit's
      // message, and a merge gets git's own "Merge branch …" message.)
      const run = await runGitCommand(repo, `${op} --${how}`);
      // Either way the working tree changes, even when the history doesn't (an abort).
      if (run.graph) applyGraph(run.graph, true);
      else editorFilesMoved();
      if (!run.result.ok) {
        const why = (run.result.error ?? run.result.stderr ?? "").trim() || `git exited with ${run.result.exitCode}`;
        setError(how === "abort" ? `Couldn't abort the ${op}: ${why}` : `The ${op} can't continue yet: ${why}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPauseBusy(null);
      // Look again even if the history didn't move (an abort with nothing committed yet).
      setPauseCheck((n) => n + 1);
      focusLater(() => selectedNodeEl() ?? pathInputEl());
    }
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
  const drawerOpen = Boolean(tool && !panel);
  // While the drawer slides away (or waits, closed) it keeps the last tool's band.
  const drawerTool = TOOLS.find((t) => t.id === (tool ?? lastTool));
  const editorUp = Boolean(graph && layout && scoped && showEditor);
  // History | Calls sits on the stage while a function's history or call map is there
  // (not over the editor or the context view, which have the stage to themselves).
  const viewSwitchUp = Boolean(graph && layout && scoped && scope.kind === "function" && !showEditor && !showContext);

  return (
    <div className="app" data-theme={theme}>
      {/* While the unsaved-edits question is up, the rest of the window waits. */}
      <div className="app-body" inert={leave ? true : undefined}>
      <header className={`toolbar${graph ? " has-repo" : ""}`}>
        <span className="app-name">Chronos</span>

        {/* Before a repository is open: just the path (the start screen offers Browse).
            Once one is open, the form folds into a ticket with the repository's name. */}
        {graph ? (
          <RepoTicket
            name={repoLabel}
            repoPath={graph.repoPath}
            open={repoPop}
            onOpenChange={showRepoPop}
            focusKey={repoFocus}
            path={path}
            onPathChange={setPath}
            recent={recent}
            onRemoveRecent={(gone) => setRecent((list) => removeRecentRepo(list, gone))}
            onOpenPath={(target) => {
              setPath(target);
              void load(target);
            }}
            onBrowse={() => void browse()}
            onExplorer={() => void showInExplorer()}
            onReload={() => void load(graph.repoPath)}
            loading={loading}
            desktop={desktop}
          />
        ) : (
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
            <button className="btn primary" type="submit" disabled={loading || !path.trim()}>
              Open
            </button>
          </form>
        )}

        {graph && <ScopeBar graph={graph} scope={scope} onChange={changeScope} />}

        {/* The branch and Push share one cluster: both are about where the work goes. */}
        {graph && (
          <div className="git-cluster" role="group" aria-label="Git">
            <BranchSwitcher
              graph={graph}
              currentBranch={currentBranch}
              onGraphChange={applyGraph}
              onError={setError}
            />
            <button
              type="button"
              className="btn primary tool-btn push-key"
              onClick={() => setShowPush(true)}
              aria-label="Push to Git"
              title="Commit and push to Git"
            >
              <PushIcon />
              <span className="push-key-label">Push</span>
            </button>
          </div>
        )}

        <div className="tools" role="group" aria-label="Tools">
          {TOOLS.map(({ id, label, hint, icon: Icon }) => {
            // Working out of sight: a little chalk dot on the button says so.
            const working = busyTools.has(id) && !(drawerOpen && tool === id);
            return (
              <button
                key={id}
                ref={(el) => {
                  if (el) toolKeys.current.set(id, el);
                  else toolKeys.current.delete(id);
                }}
                type="button"
                className={`btn tool-btn icon-only${working ? " is-working" : ""}`}
                aria-pressed={tool === id}
                aria-label={working ? `${label} (working)` : label}
                onClick={() => toggleTool(id)}
              >
                <Icon />
                {/* Near the window's right edge, so the tip lines up with the key's right side. */}
                <Tip align="end">
                  <strong className="tip-title">{label}</strong>
                  <span className="tip-text">{working ? `${hint}. Still working…` : hint}</span>
                </Tip>
                {working && <span className="tool-busy-dot" aria-hidden="true" />}
              </button>
            );
          })}
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
              <button
                className="btn"
                onClick={() => {
                  setError("");
                  focusLater(pathInputEl);
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </Presence>

      {/* A rebase or merge that stopped on a conflict stays in view until it is finished
          or aborted, whatever happens to the commit ticket (or terminal) it started from. */}
      <Presence show={Boolean(graph && paused)} className="banner-roll" exitMs={160}>
        {paused && (
          <div className="banner-clip">
            <section className="banner rebase-note" aria-label={pauseCopy(paused).label}>
              <span className="banner-text">
                <WarnIcon />
                <span>
                  <strong className="rebase-note-title">{pauseCopy(paused).title}</strong>{" "}
                  <span className="rebase-note-help">
                    Fix the files and stage them (<code>git add</code>), {pauseCopy(paused).help}
                  </span>
                </span>
              </span>
              <span className="rebase-note-keys">
                <button
                  type="button"
                  className="btn"
                  disabled={pauseBusy !== null}
                  onClick={() => {
                    if (!showTerminal) {
                      rememberOpener("terminal");
                      setShowContext(false);
                      openers.current.context = null;
                      setShowTerminal(true);
                    }
                    focusTerminalSoon();
                  }}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={pauseBusy !== null}
                  aria-busy={pauseBusy === "continue" || undefined}
                  onClick={() => void finishPaused(paused, "continue")}
                >
                  {pauseBusy === "continue" ? "Continuing…" : "Continue"}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={pauseBusy !== null}
                  aria-busy={pauseBusy === "abort" || undefined}
                  onClick={() => void finishPaused(paused, "abort")}
                >
                  {pauseBusy === "abort" ? "Aborting…" : pauseCopy(paused).abort}
                </button>
              </span>
            </section>
          </div>
        )}
      </Presence>

      <main className="stage">
        <div className="workspace">
          {/* The graph, context compiler, or code editor; the editor overlays only
              this area, so a tool drawer beside it stays visible. */}
          <div className="workspace-main">
          {/* History | Calls for the function in scope, in the top-left corner of the stage.
              First in the page, so Tab reaches it before the history or call map it
              switches (as it reads), not after every box on the call map. */}
          <Presence show={viewSwitchUp} className="view-switch-pop" exitMs={140}>
            {graph && scope.kind === "function" && (
              <FunctionViewSwitch
                view={functionView}
                onViewChange={changeFunctionView}
                callsOff={callsOffReason(Boolean(graph.head), scope.path)}
              />
            )}
          </Presence>

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
                onClose={closeCalls}
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
                  setToolSwap(false);
                  setPanel({ mode, id: Date.now(), focus: true });
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

          <Presence show={editorUp} className="editor-layer" exitMs={160}>
            {graph && layout && scoped && (
              <CodeEditor
                // A new repository starts the editor over; a refresh reads the files in place.
                key={graph.repoPath}
                refreshToken={refreshToken}
                repoPath={graph.repoPath}
                graph={scoped.graph}
                layout={layout}
                selected={selected}
                compare={diffCompare}
                startPath={editorStart}
                onSelect={pick}
                onCompare={setDiffCompare}
                onDirtyChange={onDirtyChange}
                onClose={closeEditor}
              />
            )}
          </Presence>

          {/* The history moved under the open editor (Reload, a git command, a rebase). */}
          <Presence show={editorUp && editorStale} className="editor-note" exitMs={140}>
            <div className="editor-note-card" role="status">
              <p className="editor-note-text">
                The repository changed. Files in the editor may be out of date
                {editorDirty ? ", and saving would write over the new version." : "."}
              </p>
              <span className="editor-note-keys">
                <button type="button" className="btn" onClick={refreshEditor}>
                  Reload files
                </button>
                <button
                  type="button"
                  className="ticket-close"
                  aria-label="Dismiss the note"
                  title="Dismiss"
                  onClick={() => {
                    setEditorStale(false);
                    focusLater(() => document.querySelector(".editor-layer:not(.is-leaving) .file-search-input"));
                  }}
                >
                  ×
                </button>
              </span>
            </div>
          </Presence>
          </div>

          <Presence show={Boolean(graph && layout && scoped && selectedNode && panel && !showEditor)} className="slide-panel">
          {graph && layout && scoped && selectedNode && panel && !showEditor && (
            <CommitDetails
              key={`${selectedNode.commit.hash}:${panel.id}`}
              start={panel.mode}
              autoFocus={panel.focus}
              repoPath={graph.repoPath}
              graph={scoped.graph}
              layout={layout}
              commit={selectedNode.commit}
              lane={layout.lanes[selectedNode.lane]}
              scope={scope}
              pathAtCommit={scoped.pathAt.get(selectedNode.commit.hash)}
              removed={scoped.gone.has(selectedNode.commit.hash)}
              currentBranch={currentBranch}
              rebasePaused={rebasePaused}
              mergePaused={paused === "merge"}
              onGraphChange={applyGraph}
              onSelect={(hash) => {
                setSelected(hash);
                setPanel({ mode: "details", id: Date.now(), focus: true });
              }}
              onOpenSideDiff={() => openSideDiff(selectedNode.commit.hash)}
              onOpenFile={(file) => openSideDiff(selectedNode.commit.hash, file)}
              onClose={closePanel}
              highlightedAuthor={highlightAuthor}
              onHighlightAuthor={setHighlightAuthor}
              onExplain={() => void explainCommit(selectedNode.commit)}
            />
          )}
          </Presence>

          {/* Kept mounted while closed, so a model download or a PR check carries on. */}
          <Presence show={drawerOpen} className="slide-panel" keepMounted>
            {drawerTool && (
              <ToolDrawer
                title={drawerTool.title}
                icon={drawerTool.icon}
                open={drawerOpen}
                swap={toolSwap}
                onClose={closeTool}
              >
                {TOOLS.filter((t) => openedTools.has(t.id)).map((t) => (
                  <div
                    key={t.id}
                    className={`tool-pane${toolSwap && t.id === tool ? " is-swap" : ""}`}
                    hidden={t.id !== drawerTool.id || undefined}
                  >
                    <PanelBoundary name={t.label}>
                      {t.id === "ai" && (
                        <AiPanel request={aiRequest} onRequestTaken={takeAiRequest} onBusyChange={onBusy.ai} />
                      )}
                      {t.id === "reviews" && <BugCheckPanel repoPath={graph?.repoPath} onBusyChange={onBusy.reviews} />}
                      {t.id === "people" && (
                        <ContributorsPanel
                          key={graph?.repoPath ?? ""}
                          repoPath={graph?.repoPath ?? path}
                          filePaths={filePaths}
                        />
                      )}
                    </PanelBoundary>
                  </div>
                ))}
              </ToolDrawer>
            )}
          </Presence>
        </div>

        {/* Kept mounted while closed, so the output and any running command survive. */}
        <Presence show={Boolean(graph && showTerminal)} className="dock-panel" exitMs={200} keepMounted>
          {graph && (
            <Terminal
              key={graph.repoPath}
              repoPath={graph.repoPath}
              repoLabel={repoLabel}
              onGraphChange={applyTerminalGraph}
              onClose={closeTerminal}
            />
          )}
        </Presence>

        <div className="dock-toggles" role="toolbar" aria-label="Views">
          {/* In the editor, "Back to map" (and Ctrl+E) closes it; this key would only sit
              on top of the file tree. */}
          {!showEditor && (
            <button
              ref={editorKey}
              type="button"
              className="btn dock-key"
              aria-pressed={false}
              aria-keyshortcuts="Control+E"
              title="Open the code editor (Ctrl+E)"
              onClick={toggleEditor}
            >
              <span>Code editor</span>
              <kbd className="dock-kbd" aria-hidden="true">
                Ctrl E
              </kbd>
            </button>
          )}
          <button
            ref={terminalKey}
            type="button"
            className={`btn dock-key${showTerminal ? " primary" : ""}`}
            aria-pressed={showTerminal}
            aria-keyshortcuts="Control+`"
            title={showTerminal ? "Close the terminal (Ctrl+`)" : "Open the terminal (Ctrl+`)"}
            onClick={toggleTerminal}
          >
            <span>Terminal</span>
            <kbd className="dock-kbd" aria-hidden="true">
              Ctrl `
            </kbd>
          </button>
          <button
            ref={contextKey}
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
            <span key={`b:${currentBranch}:${paused}`} className="status-tick">
              {headText(currentBranch, paused)}
            </span>
            <span key={`c:${scoped?.graph.commits.length ?? 0}:${scope.kind}`} className="status-tick">
              {scoped?.graph.commits.length ?? 0} commits{scope.kind !== "project" ? ` touching this ${scope.kind}` : ""}
            </span>
            <span key={`r:${graph.branches.length}`} className="status-tick">
              {graph.branches.length} branches
            </span>
            {/* After a reload: a little note that it worked and what it found. */}
            <Presence show={Boolean(reloadNote)} className="reload-note" exitMs={160}>
              {reloadNote && (
                <span key={reloadNote.n} className={`reload-note-tag${reloadNote.fresh ? " is-fresh" : ""}`}>
                  {!reloadNote.fresh && <TickGlyph />}
                  {reloadNote.text}
                </span>
              )}
            </Presence>
          </>
        ) : (
          <span className="status-path">{loading ? "Opening…" : "No repository open"}</span>
        )}

        {/* Always present, so screen readers hear each reload's result. */}
        <span className="details-sr-only" role="status">
          {reloadNote ? `Reloaded: ${reloadNote.text}` : ""}
        </span>
        {/* A tool that finished its work while its pane was out of sight. */}
        <span className="details-sr-only" role="status" aria-live="polite">
          {toolNote}
        </span>

        <span
          className={`status-conn${connected === false ? " status-bad" : connected ? " is-ok" : ""}`}
          title={connected === false ? undefined : connected ? "Backend connected" : "Connecting to the backend"}
        >
          <span className="status-dot" aria-hidden />
          {connected === false ? "Backend not connected" : connected ? version : "Connecting…"}
        </span>

        {/* Paper or blackboard: a quiet corner key, out of the toolbar's way. */}
        <button
          type="button"
          className="status-theme"
          onClick={() => switchTheme(theme === "paper" ? "board" : "paper")}
          aria-label={theme === "paper" ? "Switch to the blackboard theme" : "Switch to the paper theme"}
        >
          {/* Keyed so the new icon turns into place when the theme flips. */}
          <span key={theme} className={`theme-glyph${themeFlipped ? " is-turning" : ""}`}>
            <ThemeIcon to={theme === "paper" ? "board" : "paper"} />
          </span>
          <span className="status-theme-label">{theme === "paper" ? "Blackboard" : "Paper"}</span>
          <Tip side="above" align="end">
            {theme === "paper" ? "Switch to the blackboard theme" : "Switch to the paper theme"}
          </Tip>
        </button>
      </footer>
      </div>

      {/* Closing or reloading the editor would drop unsaved edits: ask first, in the
          same hand-drawn style, instead of the browser's own dialog. */}
      <Presence show={Boolean(leave)} className="leave-scrim" exitMs={140}>
        {leave && (
          <div
            className="leave-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-title"
            aria-describedby="leave-text"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                keepEditing();
              } else if (e.key === "Tab") {
                // Keep the keyboard inside the question.
                e.preventDefault();
                const next = document.activeElement === leaveKeep.current ? leaveDiscard.current : leaveKeep.current;
                next?.focus();
              }
            }}
          >
            <h2 id="leave-title" className="section-title leave-title">
              {leave.title}
            </h2>
            <p id="leave-text" className="leave-text">
              The file in the editor has <span className="leave-mark">unsaved edits</span>. They will be lost.
            </p>
            <div className="leave-keys">
              <button ref={leaveDiscard} type="button" className="btn leave-discard" onClick={discardEdits}>
                {leave.discard}
              </button>
              <button ref={leaveKeep} type="button" className="btn primary" onClick={keepEditing}>
                Keep editing
              </button>
            </div>
          </div>
        )}
      </Presence>
    </div>
  );
}

export default App;
