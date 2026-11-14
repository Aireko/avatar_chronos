import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { errorMessage, listRepoFiles, readRepoFile, writeRepoFile, type ChronosGraph } from "../backend";
import {
  buildDiffRows,
  changeStarts,
  describeChange,
  diffStats,
  editMarks,
  lineCount,
  lineToRow,
  rowMap,
  rowToLine,
  stepChange,
  type DiffRow,
  type EditMark,
} from "./diffRows";
import { clamp, trackDrag } from "./drag";
import { listChangedPaths, readBlob, type DiffPath } from "./gitBlob";
import { MiniMap } from "./MiniMap";
import type { GraphLayout } from "./layout";
import "./details.css";

const TREE_MIN = 160;
const TREE_MAX = 520;

/** Open the editor comparing `baseRev` (left) to the working tree (right). */
export interface DiffCompare {
  baseRev: string;
  baseLabel: string;
  headLabel: string;
  /** File to open first (e.g. picked from the commit ticket). Listed even when it has not changed since. */
  path?: string;
}

/** Tree status for a file that is the same in the commit and the working tree. */
const SAME = "=";
const STATUS_TITLE: Record<string, string> = {
  A: "Added since this commit",
  M: "Changed since this commit",
  D: "Deleted since this commit",
  R: "Renamed since this commit",
  C: "Copied since this commit",
  [SAME]: "Unchanged since this commit",
};

interface Props {
  repoPath: string;
  graph: ChronosGraph;
  layout: GraphLayout;
  selected: string | null;
  compare: DiffCompare | null;
  /** File the plain editor opens first, before the selected commit's first file. */
  startPath?: string | null;
  onSelect: (hash: string | null) => void;
  onCompare: (compare: DiffCompare | null) => void;
  onClose: () => void;
  /** Called when the editor gets unsaved edits and again when it has none (after Save, or false on unmount). */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Bump to reload the open file (or comparison) and the file lists from disk in place,
   * keeping the open file, the tree, the caret and the scroll position. The first value
   * does nothing. The app asks about unsaved edits first, so a refresh drops the buffer.
   */
  refreshToken?: number;
}

/** Where the caret and the scrolled panes were, put back after a reload from disk. */
interface ViewSnap {
  scroll: { el: HTMLElement; top: number; left: number }[];
  caret: { el: HTMLTextAreaElement; start: number; end: number; dir: "forward" | "backward" | "none" } | null;
}

/** A callback with a fixed identity that always runs the latest `fn` (for memoised children). */
function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

type TreeNode = { name: string; path: string; kind: "dir" | "file"; children?: TreeNode[] };

type SideLine = {
  key: string;
  number: number | null;
  text: string;
  kind: "context" | "added" | "removed" | "empty";
};

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  const folder = (dirPath: string): TreeNode[] => {
    if (!dirPath) return root;
    const hit = dirs.get(dirPath);
    if (hit?.children) return hit.children;
    let parent = root;
    let acc = "";
    for (const part of dirPath.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      let node = dirs.get(acc);
      if (!node) {
        node = { name: part, path: acc, kind: "dir", children: [] };
        dirs.set(acc, node);
        parent.push(node);
      }
      parent = node.children!;
    }
    return parent;
  };

  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const i = path.lastIndexOf("/");
    folder(i === -1 ? "" : path.slice(0, i)).push({
      name: i === -1 ? path : path.slice(i + 1),
      path,
      kind: "file",
    });
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(root);
  return root;
}

function matchFiles(paths: string[], query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return paths;
  return paths.filter((path) => {
    const hay = path.toLowerCase();
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    return tokens.every((t) => hay.includes(t) || base.includes(t));
  });
}

function rowsToSide(rows: readonly DiffRow[], side: "before" | "after"): SideLine[] {
  return rows.map((row, i) => {
    if (side === "before") {
      if (row.kind === "added") return { key: `b-${i}`, number: null, text: "", kind: "empty" };
      return {
        key: `b-${i}`,
        number: row.oldLine,
        text: row.text,
        kind: row.kind === "removed" ? "removed" : "context",
      };
    }
    if (row.kind === "removed") return { key: `a-${i}`, number: null, text: "", kind: "empty" };
    return {
      key: `a-${i}`,
      number: row.newLine,
      text: row.text,
      kind: row.kind === "added" ? "added" : "context",
    };
  });
}

/** Editable working-tree code view with optional side-by-side diff. */
export function CodeEditor({
  repoPath,
  graph,
  layout,
  selected,
  compare,
  startPath,
  onSelect,
  onCompare,
  onClose,
  onDirtyChange,
  refreshToken,
}: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [changed, setChanged] = useState<DiffPath[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [saved, setSaved] = useState("");
  const [leftText, setLeftText] = useState<string | null>(null);
  const [rightText, setRightText] = useState<string | null>(null);
  const [savedRight, setSavedRight] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [treeWidth, setTreeWidth] = useState(240);
  const area = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const leftPane = useRef<HTMLPreElement>(null);
  const rightPane = useRef<HTMLTextAreaElement>(null);
  const rightMarks = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // "jump" while the change keys place both panes themselves.
  const syncing = useRef<"left" | "right" | "jump" | null>(null);
  const savedTimer = useRef<number | undefined>(undefined);
  const flashTimer = useRef<number | undefined>(undefined);
  const jumpAt = useRef(-1);
  // The change the arrows last jumped to (a row in diffRows), for the "2/5" beside the counts,
  // and what the status line said about it.
  const [jumpRow, setJumpRow] = useState(-1);
  const [changeNote, setChangeNote] = useState("");
  const noteFlip = useRef(false);
  // Esc was just pressed in the plain editor, so the next Tab leaves it instead of indenting.
  const [tabLeaves, setTabLeaves] = useState(false);
  const keysHint = useId();
  const [flash, setFlash] = useState<{ from: number; to: number; n: number } | null>(null);
  const loaded = useRef<string | null>(null);
  const diffFile = useRef<string | null>(null);
  const dirtyRightRef = useRef(false);
  // The comparison whose asked-for file (compare.path) has been opened. It opens once per
  // comparison, so a later re-list (the selection hint changed) keeps the file being edited.
  const pathOpened = useRef<DiffCompare | null>(null);
  const diffing = !!compare;

  // A refresh (see refreshToken) re-runs the loads below quietly: no "Loading…" placeholder,
  // which would unmount the panes and lose the caret and scroll position.
  const seenToken = useRef(refreshToken);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (refreshToken === seenToken.current) return;
    seenToken.current = refreshToken;
    setEpoch((n) => n + 1);
  }, [refreshToken]);
  // The epoch each load last ran at: a load running at a newer one is a refresh.
  const changedEpoch = useRef(0);
  const fileEpoch = useRef(0);
  const blobEpoch = useRef(0);
  const restore = useRef<ViewSnap | null>(null);
  const [, setHeld] = useState(0);

  const selectedCommit = selected ? graph.commits.find((c) => c.hash === selected) : undefined;
  const canCompare = !!selectedCommit && selectedCommit.hash !== graph.head;
  const hint = selectedCommit?.filesChanged[0]?.path;

  const dirtyRight = (rightText ?? "") !== savedRight;
  dirtyRightRef.current = dirtyRight;
  const dirty = diffing ? dirtyRight : source !== saved;
  const searching = !!query.trim();
  const treePaths = diffing ? changed.map((c) => c.path) : files;
  const visible = useMemo(() => matchFiles(treePaths, query), [treePaths, query]);
  const tree = useMemo(() => buildTree(visible), [visible]);
  const lines = useMemo(() => lineCount(source), [source]);
  // The gutter is one text block, rebuilt only when the number of lines changes.
  const gutter = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);

  const activeChange = changed.find((c) => c.path === active);
  // Typing diffs a deferred copy of the text, so the textarea keeps up with the keys and the
  // marks catch up a moment later; a new file or comparison is diffed straight away.
  // `base` (the text as loaded or saved) changes on every load, so a freshly loaded file
  // never shows a deferred copy of the previous one, even when the left sides match
  // (two added files both have no left side).
  const diffInput = useMemo(
    () => ({ left: leftText, right: rightText, file: active, base: savedRight }),
    [leftText, rightText, active, savedRight],
  );
  const typedInput = useDeferredValue(diffInput);
  const diffSource =
    typedInput.left === leftText && typedInput.file === active && typedInput.base === savedRight
      ? typedInput
      : diffInput;
  const diffRows = useMemo(
    () => (diffing ? buildDiffRows(diffSource.left, diffSource.right) : []),
    [diffing, diffSource],
  );
  const beforeLines = useMemo(() => rowsToSide(diffRows, "before"), [diffRows]);
  const starts = useMemo(() => changeStarts(diffRows), [diffRows]);
  const stats = useMemo(() => diffStats(diffRows), [diffRows]);
  const map = useMemo(() => rowMap(diffRows), [diffRows]);
  const marks = useMemo(() => editMarks(diffRows), [diffRows]);
  // The jumped-to change, in working-tree lines, so the editable pane glows with the other side.
  // (An edit can shorten the rows while the glow is still showing; then it just stops.)
  const flashLines = useMemo(
    () =>
      flash && flash.to < map.lineOfRow.length
        ? { from: map.lineOfRow[flash.from], to: map.lineOfRow[flash.to], n: flash.n }
        : null,
    [flash, map],
  );
  const changeIndex = jumpRow === -1 ? -1 : starts.indexOf(jumpRow);
  const saveState = !active ? null : saving ? "saving" : dirty ? "dirty" : notice ? "saved" : null;

  // A new file or comparison starts the change keys from the top again.
  useEffect(() => {
    jumpAt.current = -1;
    setJumpRow(-1);
    setChangeNote("");
    setFlash(null);
  }, [active, compare]);

  // Tell the app when there are unsaved edits, and that there are none once this closes.
  const dirtyReported = useRef(false);
  const reportDirty = useStableHandler((value: boolean) => onDirtyChange?.(value));
  useEffect(() => {
    if (dirty === dirtyReported.current) return;
    dirtyReported.current = dirty;
    reportDirty(dirty);
  }, [dirty, reportDirty]);
  useEffect(
    () => () => {
      dirtyReported.current = false;
      reportDirty(false);
    },
    [reportDirty],
  );

  // The commit map is memoised; give it a click handler that never changes identity.
  const pickCommit = useStableHandler((hash: string) => onSelect(hash));
  useEffect(
    () => () => {
      window.clearTimeout(savedTimer.current);
      window.clearTimeout(flashTimer.current);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void listRepoFiles(repoPath)
      .then((paths) => {
        if (!alive) return;
        setFiles(paths);
        // On a refresh too, the open file stays open while it is still there.
        if (!diffing) {
          setActive((prev) => {
            if (prev && paths.includes(prev)) return prev;
            if (startPath && paths.includes(startPath)) return startPath;
            if (hint && paths.includes(hint)) return hint;
            return paths[0] ?? null;
          });
        }
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, epoch]);

  useEffect(() => {
    const refresh = changedEpoch.current !== epoch;
    changedEpoch.current = epoch;
    if (!compare) {
      setChanged([]);
      return;
    }
    let alive = true;
    if (!refresh) setLoading(true);
    setError("");
    void listChangedPaths(repoPath, compare.baseRev)
      .then((listed) => {
        if (!alive) return;
        // A file asked for by name opens even if it is the same in both, so the
        // commit's version can still be read next to the working tree.
        // A file renamed since the commit is listed under its new name.
        const wanted = listed.find((p) => p.oldPath === compare.path)?.path ?? compare.path;
        const paths =
          wanted && !listed.some((p) => p.path === wanted)
            ? [...listed, { path: wanted, oldPath: null, status: SAME }]
            : listed;
        setChanged(paths);
        const openWanted = !!wanted && pathOpened.current !== compare;
        pathOpened.current = compare;
        setActive((prev) => {
          if (openWanted && wanted) return wanted;
          if (prev && paths.some((p) => p.path === prev)) return prev;
          if (hint && paths.some((p) => p.path === hint)) return hint;
          return paths[0]?.path ?? null;
        });
      })
      .catch((e) => {
        if (!alive) return;
        setChanged([]);
        setError(errorMessage(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoPath, compare, hint, epoch]);

  useEffect(() => {
    if (!active || searching) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      const parts = active.split("/");
      for (let i = 1; i < parts.length; i++) next.delete(parts.slice(0, i).join("/"));
      return next;
    });
  }, [active, searching]);

  // Single-file edit mode
  useEffect(() => {
    if (diffing) return;
    if (!active) {
      loaded.current = null;
      setSource("");
      setSaved("");
      return;
    }
    const refresh = fileEpoch.current !== epoch && loaded.current === active;
    fileEpoch.current = epoch;
    if (loaded.current === active && !refresh) return;
    let alive = true;
    if (!refresh) setLoading(true);
    setError("");
    setNotice("");
    void readRepoFile(repoPath, active)
      .then((file) => {
        if (!alive) return;
        if (refresh) holdView(area.current);
        loaded.current = active;
        setSource(file.content);
        setSaved(file.content);
        if (refresh) noteDone("Reloaded");
      })
      .catch((e) => {
        if (!alive) return;
        loaded.current = null;
        setSource("");
        setSaved("");
        setError(errorMessage(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // holdView and noteDone only read refs and set state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, active, diffing, epoch]);

  // Side-by-side blobs: left is the selected commit; right is the working tree (editable).
  useEffect(() => {
    if (!diffing || !compare || !active) {
      setLeftText(null);
      setRightText(null);
      setSavedRight("");
      diffFile.current = null;
      return;
    }
    let alive = true;
    const fileChanged = diffFile.current !== active;
    const refresh = blobEpoch.current !== epoch && !fileChanged;
    blobEpoch.current = epoch;
    if (!refresh) setLoading(true);
    setError("");
    const leftPath = activeChange?.oldPath || active;
    const rightPath = active;
    void Promise.all([
      activeChange?.status === "A" ? Promise.resolve(null) : readBlob(repoPath, compare.baseRev, leftPath),
      activeChange?.status === "D" ? Promise.resolve(null) : readBlob(repoPath, null, rightPath),
    ])
      .then(([left, right]) => {
        if (!alive) return;
        if (refresh) {
          holdView(rightPane.current);
          noteDone("Reloaded");
        }
        setLeftText(left);
        // Keep in-progress working-tree edits when only the compared commit changes.
        // A refresh reloads them from disk (the app has asked about unsaved edits first).
        if (fileChanged || refresh || !dirtyRightRef.current) {
          const next = right ?? "";
          setRightText(right);
          setSavedRight(next);
          diffFile.current = active;
        }
      })
      .catch((e) => {
        if (!alive) return;
        setLeftText(null);
        if (fileChanged || !dirtyRightRef.current) {
          setRightText(null);
          setSavedRight("");
          diffFile.current = active;
        }
        setError(errorMessage(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // holdView and noteDone only read refs and set state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, active, compare, diffing, activeChange?.oldPath, activeChange?.status, epoch]);

  /** Notes where the caret and the scrolled panes are, to put them back once the reload renders. */
  function holdView(caretEl: HTMLTextAreaElement | null) {
    const scroll = [body.current, leftPane.current, rightPane.current]
      .filter((el): el is HTMLDivElement | HTMLPreElement | HTMLTextAreaElement => !!el)
      .map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft }));
    // Always render once more, so the snapshot is used now even when the file on disk is
    // unchanged (same text, notice already "Reloaded"), never on some later keystroke.
    setHeld((n) => n + 1);
    restore.current = {
      scroll,
      caret: caretEl
        ? {
            el: caretEl,
            start: caretEl.selectionStart,
            end: caretEl.selectionEnd,
            dir: caretEl.selectionDirection ?? "none",
          }
        : null,
    };
  }

  // After a reload renders: setting the new text moved the caret to its end, so put it back
  // (clamped to the new text) and the scroll positions too, without the panes re-syncing.
  useLayoutEffect(() => {
    const snap = restore.current;
    if (!snap) return;
    restore.current = null;
    const { caret } = snap;
    if (caret?.el.isConnected) {
      const n = caret.el.value.length;
      caret.el.setSelectionRange(Math.min(caret.start, n), Math.min(caret.end, n), caret.dir);
    }
    syncing.current = "jump";
    for (const s of snap.scroll) {
      if (!s.el.isConnected) continue;
      s.el.scrollTop = s.top;
      s.el.scrollLeft = s.left;
    }
    moveMarks();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (syncing.current === "jump") syncing.current = null;
      }),
    );
  });

  /** Stamps "saved" or "reloaded" in the bar for a moment. */
  function noteDone(what: "Saved" | "Reloaded") {
    setNotice(what);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setNotice(""), 1400);
  }

  async function save() {
    if (!active || !dirty || saving) return;
    const content = diffing ? (rightText ?? "") : source;
    setSaving(true);
    setError("");
    try {
      await writeRepoFile(repoPath, active, content);
      if (diffing) {
        setSavedRight(content);
        setRightText(content);
        diffFile.current = active;
      } else {
        loaded.current = active;
        setSaved(content);
        setSource(content);
      }
      noteDone("Saved");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
      if (diffing) rightPane.current?.focus();
      else area.current?.focus();
    }
  }

  async function openFile(path: string) {
    if (path === active) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setActive(path);
    if (!diffing) loaded.current = null;
    else diffFile.current = null;
  }

  function startCompare() {
    if (!selectedCommit || selectedCommit.hash === graph.head) return;
    if (!diffing && dirty && !window.confirm("Discard unsaved changes?")) return;
    loaded.current = null;
    onCompare({
      baseRev: selectedCommit.hash,
      baseLabel: selectedCommit.shortHash,
      headLabel: "working tree",
    });
  }

  function stopCompare() {
    if (dirtyRight && !window.confirm("Discard unsaved changes?")) return;
    onCompare(null);
    loaded.current = null;
    diffFile.current = null;
  }

  /**
   * Tab types an indent here, so it can't move focus on: Esc then Tab leaves the editor
   * (the hint in the bar says so), and Shift+Tab always goes back.
   */
  function onEditorKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    const leaving = tabLeaves;
    if (e.key === "Escape") {
      setTabLeaves(true);
      return;
    }
    if (leaving && e.key !== "Shift") setTabLeaves(false);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    } else if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !leaving) {
      e.preventDefault();
      const el = e.currentTarget;
      // insertText keeps the indent on the textarea's own undo stack; fall back to setting the value.
      if (!document.execCommand?.("insertText", false, "  ")) {
        const { selectionStart: a, selectionEnd: b } = el;
        setSource(`${source.slice(0, a)}  ${source.slice(b)}`);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = a + 2;
        });
      }
    }
  }

  /** Height of one row in the read-only pane, and of one line in the editable pane. */
  function paneMetrics() {
    const left = leftPane.current;
    const right = rightPane.current;
    if (!left || !right) return null;
    const leftStyle = getComputedStyle(left);
    const rightStyle = getComputedStyle(right);
    const lineH = parseFloat(rightStyle.lineHeight) || 18.75;
    return {
      left,
      right,
      rowH: (left.firstElementChild as HTMLElement | null)?.getBoundingClientRect().height || lineH,
      lineH,
      leftPad: parseFloat(leftStyle.paddingTop) || 0,
      rightPad: parseFloat(rightStyle.paddingTop) || 0,
    };
  }

  /** The highlight layer behind the editable pane scrolls with its text. */
  function moveMarks() {
    const right = rightPane.current;
    if (rightMarks.current && right) rightMarks.current.style.transform = `translateY(${-right.scrollTop}px)`;
  }

  // A fresh pane, or edits that change the marks: keep the layer where the text is.
  useEffect(moveMarks, [marks, active, loading]);

  /**
   * Scrolling one pane scrolls the other to the same code. The read-only pane has a
   * spacer row for every added line and the editable pane has no row for removed
   * lines, so positions are matched row to line (see rowMap), not pixel to pixel.
   */
  function syncScroll(from: "left" | "right", e: UIEvent<HTMLElement>) {
    if (from === "right") moveMarks();
    if (syncing.current === "jump") return;
    const m = paneMetrics();
    if (!m || syncing.current === (from === "left" ? "right" : "left")) return;
    syncing.current = from;
    if (from === "left") {
      const row = (m.left.scrollTop - m.leftPad) / m.rowH;
      m.right.scrollTop = rowToLine(map, row) * m.lineH + m.rightPad;
      m.right.scrollLeft = e.currentTarget.scrollLeft;
    } else {
      const line = (m.right.scrollTop - m.rightPad) / m.lineH;
      m.left.scrollTop = lineToRow(map, line) * m.rowH + m.leftPad;
      m.left.scrollLeft = e.currentTarget.scrollLeft;
    }
    requestAnimationFrame(() => {
      syncing.current = null;
    });
  }

  /** Scroll both panes to the previous or next run of changed lines and flash it. */
  function goToChange(dir: 1 | -1) {
    const from = jumpAt.current;
    const at = stepChange(starts, from, dir);
    const left = leftPane.current;
    const row = at == null ? undefined : left?.children[at];
    if (at == null || !left || !row) return;
    jumpAt.current = at;
    setJumpRow(at);
    // Focus stays on the key that was pressed, so say where the jump landed. A trailing
    // space on every other jump makes a repeated message ("the only change") speak again.
    // (Counted here, not from the flash, which is cleared a second after each jump.)
    noteFlip.current = !noteFlip.current;
    setChangeNote(`${describeChange(starts, from, at, dir, map.lineOfRow[at])}${noteFlip.current ? "\u00a0" : ""}`);
    let to = at;
    while (to < diffRows.length && diffRows[to].kind !== "context") to++;

    syncing.current = "jump";
    const rowTop = row.getBoundingClientRect().top - left.getBoundingClientRect().top + left.scrollTop;
    left.scrollTop = Math.max(0, rowTop - left.clientHeight / 3);
    left.scrollLeft = 0;
    const right = rightPane.current;
    if (right) {
      // The editable pane holds only working-tree lines, so count the rows that have one.
      const line = map.lineOfRow[at];
      // Park the caret there too, so typing after focusing the pane edits this change.
      let offset = 0;
      for (let k = 0; k < line && offset !== -1; k++) {
        const nl = right.value.indexOf("\n", offset);
        offset = nl === -1 ? -1 : nl + 1;
      }
      if (offset !== -1) right.setSelectionRange(offset, offset);
      const lineHeight = parseFloat(getComputedStyle(right).lineHeight) || 18.75;
      right.scrollTop = Math.max(0, line * lineHeight - right.clientHeight / 3);
      right.scrollLeft = 0;
      moveMarks();
    }
    // The scroll events from these moves arrive before the second frame; let them pass.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (syncing.current === "jump") syncing.current = null;
      }),
    );

    setFlash((prev) => ({ from: at, to, n: (prev?.n ?? 0) + 1 }));
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1000);
  }

  function onChangeKeys(e: KeyboardEvent<HTMLElement>) {
    if (!e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    goToChange(e.key === "ArrowDown" ? 1 : -1);
  }

  // Fixed identities, so the memoised read-only pane re-renders only when its rows change.
  const onLeftScroll = useStableHandler((e: UIEvent<HTMLElement>) => syncScroll("left", e));
  const onLeftKey = useStableHandler(onChangeKeys);

  function onDiffEditorKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    } else {
      onChangeKeys(e);
    }
  }

  function onResizerKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = treeWidth - step;
    else if (e.key === "ArrowRight") next = treeWidth + step;
    else if (e.key === "Home") next = TREE_MIN;
    else if (e.key === "End") next = TREE_MAX;
    if (next == null) return;
    e.preventDefault();
    setTreeWidth(clamp(next, TREE_MIN, TREE_MAX));
  }

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((node) => {
      if (node.kind === "dir") {
        const open = searching || !collapsed.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              className="tree-row tree-folder"
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={open}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              }
            >
              <span className="tree-chevron" aria-hidden="true">
                ▸
              </span>
              <span className="tree-label">{node.name}</span>
            </button>
            {open && node.children?.length ? (
              <div className="tree-children">{renderNodes(node.children, depth + 1)}</div>
            ) : null}
          </div>
        );
      }
      const change = changed.find((c) => c.path === node.path);
      return (
        <button
          key={node.path}
          type="button"
          className={`tree-row tree-file${node.path === active ? " active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 + 16 }}
          title={node.path}
          aria-current={node.path === active ? "true" : undefined}
          onClick={() => void openFile(node.path)}
        >
          {diffing && change ? (
            <span
              className={`tree-status ${change.status === SAME ? "is-same" : `status-${change.status}`}`}
              title={STATUS_TITLE[change.status] ?? change.status}
            >
              {change.status}
            </span>
          ) : null}
          <span className="tree-label">{node.name}</span>
        </button>
      );
    });
  }

  return (
    <div className="editor" role="region" aria-label={diffing ? "Diff editor" : "Code editor"}>
      <aside className="file-tree" aria-label="Files" style={{ width: treeWidth }}>
        <div className="file-tree-head">
          <span>{diffing ? "Changed" : "Files"}</span>
          <span className="file-tree-rev">{diffing ? compare?.baseLabel : "working tree"}</span>
        </div>
        <div className="file-search">
          <input
            ref={search}
            className="file-search-input"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") return query ? setQuery("") : e.currentTarget.blur();
              if ((e.key === "Enter" || e.key === "ArrowDown") && visible[0]) {
                e.preventDefault();
                void openFile(visible[0]);
              }
            }}
            placeholder={diffing ? "Search changed files" : "Search files"}
            aria-label="Search files"
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="file-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
              ×
            </button>
          ) : null}
        </div>
        <div className="file-tree-scroll">
          {tree.length === 0 ? (
            <p className={`file-tree-empty${loading ? " is-loading" : ""}`}>
              {loading
                ? "Loading…"
                : searching
                  ? "No matching files."
                  : diffing
                    ? "No differences since this commit."
                    : "No files in this repository."}
            </p>
          ) : (
            renderNodes(tree, 0)
          )}
        </div>
      </aside>

      <div
        className="tree-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file tree"
        aria-valuenow={treeWidth}
        aria-valuemin={TREE_MIN}
        aria-valuemax={TREE_MAX}
        tabIndex={0}
        onKeyDown={onResizerKey}
        onPointerDown={(e) => {
          const start = treeWidth;
          trackDrag(e, {
            onMove: (dx) => setTreeWidth(clamp(start + dx, TREE_MIN, TREE_MAX)),
          });
        }}
      />

      <div className="editor-main">
        <header className="editor-bar">
          <span className="editor-path">
            {diffing && compare ? (
              <>
                Diff · {active ?? "—"} · {compare.baseLabel} → {compare.headLabel}
              </>
            ) : (
              (active ?? "Code editor")
            )}
          </span>
          {saveState ? (
            <span key={saveState === "saved" ? notice : saveState} className={`editor-state is-${saveState}`}>
              {saveState === "saving"
                ? "saving"
                : saveState === "dirty"
                  ? "edited"
                  : notice === "Reloaded"
                    ? "reloaded"
                    : "saved"}
            </span>
          ) : null}
          <span className="details-sr-only" role="status">
            {saving
              ? "Saving"
              : notice === "Reloaded"
                ? `${active ?? "File"} reloaded from disk`
                : notice
                  ? `${active ?? "File"} saved`
                  : ""}
          </span>
          <span className="details-sr-only" role="status">
            {diffing ? changeNote : ""}
          </span>
          {!diffing && active ? (
            <span id={keysHint} className={`editor-keys quiet${tabLeaves ? " is-armed" : ""}`}>
              {tabLeaves ? "Tab now leaves the editor" : "Esc, then Tab, leaves"}
            </span>
          ) : null}
          {diffing && active && !loading ? (
            <span className="diff-nav">
              <span className="counts" title={`${stats.added} lines added, ${stats.removed} removed`}>
                <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
              </span>
              {changeIndex !== -1 ? (
                <span key={changeIndex} className="change-pos quiet" title="The change the arrows last jumped to">
                  {changeIndex + 1}/{starts.length}
                </span>
              ) : null}
              <button
                type="button"
                className="btn"
                disabled={starts.length === 0}
                onClick={() => goToChange(-1)}
                aria-label="Previous change"
                aria-keyshortcuts="Alt+ArrowUp"
                title="Previous change (Alt+Up)"
              >
                ↑
              </button>
              <button
                type="button"
                className="btn"
                disabled={starts.length === 0}
                onClick={() => goToChange(1)}
                aria-label="Next change"
                aria-keyshortcuts="Alt+ArrowDown"
                title="Next change (Alt+Down)"
              >
                ↓
              </button>
            </span>
          ) : null}
          {diffing ? (
            <>
              <button
                type="button"
                className="btn primary editor-close"
                disabled={!dirty || saving || !active}
                onClick={() => void save()}
              >
                {saving ? "Saving" : "Save"}
              </button>
              <button
                type="button"
                className="btn editor-close"
                title="Leave the side-by-side view and edit the working tree on its own"
                onClick={stopCompare}
              >
                Stop comparing
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn editor-close"
                disabled={!canCompare}
                title={
                  canCompare
                    ? "Compare this commit to the working tree side by side"
                    : "Select a commit that is not HEAD to compare"
                }
                onClick={startCompare}
              >
                Side by side
              </button>
              <button
                type="button"
                className="btn primary editor-close"
                disabled={!dirty || saving || !active}
                onClick={() => void save()}
              >
                {saving ? "Saving" : "Save"}
              </button>
            </>
          )}
          <button type="button" className="btn editor-close" onClick={onClose}>
            Back to map
          </button>
        </header>

        <div ref={body} className={`editor-body${diffing ? " editor-body-diff" : ""}`}>
          {error && (
            <p className="editor-banner" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="editor-placeholder is-loading">Loading…</p>
          ) : !active ? (
            <p className="editor-placeholder">{diffing ? "Pick a changed file." : "Pick a file from the tree."}</p>
          ) : diffing && compare ? (
            <div className="side-diff" role="group" aria-label="Side by side diff">
              <DiffPane
                title={`${compare.baseLabel}${activeChange?.oldPath ? ` · ${activeChange.oldPath}` : ""} · read only`}
                lines={beforeLines}
                flash={flash}
                paneRef={leftPane}
                onScroll={onLeftScroll}
                onKeyDown={onLeftKey}
              />
              <div className="side-pane">
                <div className="side-pane-head">
                  {compare.headLabel}
                  {active ? ` · ${active}` : ""} · editable
                </div>
                <div className="side-edit">
                  <EditMarks layerRef={rightMarks} marks={marks} flash={flashLines} />
                  <textarea
                    ref={rightPane}
                    className="side-pane-code side-pane-edit"
                    value={rightText ?? ""}
                    spellCheck={false}
                    wrap="off"
                    aria-label={`${active ?? "file"} working tree`}
                    onChange={(e) => setRightText(e.currentTarget.value)}
                    onKeyDown={onDiffEditorKey}
                    onScroll={(e) => syncScroll("right", e)}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="code-edit">
              <div className="code-gutters" aria-hidden="true">
                {gutter}
              </div>
              <textarea
                ref={area}
                className="code-input"
                value={source}
                rows={lines}
                spellCheck={false}
                wrap="off"
                aria-label={active}
                aria-describedby={keysHint}
                onChange={(e) => setSource(e.currentTarget.value)}
                onKeyDown={onEditorKey}
                onBlur={() => setTabLeaves(false)}
              />
            </div>
          )}
        </div>

        <MiniMap layout={layout} selected={selected} head={graph.head} onSelect={pickCommit} />
      </div>
    </div>
  );
}

/** The read-only side. Memoised: typing on the other side re-renders it only once the diff changes. */
const DiffPane = memo(function DiffPane({
  title,
  lines,
  flash,
  paneRef,
  onScroll,
  onKeyDown,
}: {
  title: string;
  lines: SideLine[];
  /** Rows [from, to) glow once; `n` restarts the glow on each jump. */
  flash: { from: number; to: number; n: number } | null;
  paneRef: RefObject<HTMLPreElement | null>;
  onScroll: (e: UIEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <div className="side-pane">
      <div className="side-pane-head">{title}</div>
      {/* Focusable so the read-only side can be scrolled and stepped with the keyboard. */}
      <pre
        ref={paneRef}
        className="side-pane-code"
        tabIndex={0}
        aria-label={title}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        {lines.length === 0 ? (
          <div className="side-line empty">
            <span className="side-num" />
            <code>(empty)</code>
          </div>
        ) : (
          lines.map((line, i) => {
            const lit = !!flash && i >= flash.from && i < flash.to;
            return (
              <SideRow
                key={lit ? `${line.key}-j${flash.n}` : line.key}
                kind={line.kind}
                number={line.number}
                text={line.text}
                lit={lit}
              />
            );
          })
        )}
      </pre>
    </div>
  );
});

/** One row of the read-only pane; rows whose content is unchanged skip re-rendering. */
const SideRow = memo(function SideRow({
  kind,
  number,
  text,
  lit,
}: {
  kind: SideLine["kind"];
  number: number | null;
  text: string;
  lit: boolean;
}) {
  return (
    <div className={`side-line ${kind}${lit ? " is-jump" : ""}`}>
      <span className="side-num">{number ?? ""}</span>
      <code>{text || " "}</code>
    </div>
  );
});

/**
 * Highlights drawn behind the editable pane (a textarea can't colour its own lines):
 * a bar for each run of added lines and a dashed rule where lines were removed.
 * Positioned in lines, so it lines up with the textarea's text as long as both use
 * the same font and line height; syncScroll moves it with the text.
 */
const EditMarks = memo(function EditMarks({
  layerRef,
  marks,
  flash,
}: {
  layerRef: RefObject<HTMLDivElement | null>;
  marks: EditMark[];
  /** Working-tree lines [from, to) glow once; an empty range glows at the gap. */
  flash: { from: number; to: number; n: number } | null;
}) {
  return (
    <div ref={layerRef} className="side-edit-marks" aria-hidden="true">
      {marks.map((m) => (
        <div
          key={`${m.kind}-${m.line}`}
          className={`side-edit-mark is-${m.kind}`}
          style={{ "--at": m.line, "--n": m.count } as CSSProperties}
        />
      ))}
      {flash ? (
        <div
          key={`jump-${flash.n}`}
          className={`side-edit-mark is-jump${flash.to > flash.from ? "" : " is-gap"}`}
          style={{ "--at": flash.from, "--n": Math.max(0, flash.to - flash.from) } as CSSProperties}
        />
      ) : null}
    </div>
  );
});
