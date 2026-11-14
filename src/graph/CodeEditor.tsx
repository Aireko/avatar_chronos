import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { errorMessage, listRepoFiles, readRepoFile, writeRepoFile, type ChronosGraph } from "../backend";
import { buildDiffRows, changeStarts, diffStats, stepChange, type DiffRow } from "./diffRows";
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
}

interface Props {
  repoPath: string;
  graph: ChronosGraph;
  layout: GraphLayout;
  selected: string | null;
  compare: DiffCompare | null;
  onSelect: (hash: string | null) => void;
  onCompare: (compare: DiffCompare | null) => void;
  onClose: () => void;
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
  onSelect,
  onCompare,
  onClose,
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
  // "jump" while the change keys place both panes themselves.
  const syncing = useRef<"left" | "right" | "jump" | null>(null);
  const savedTimer = useRef<number | undefined>(undefined);
  const flashTimer = useRef<number | undefined>(undefined);
  const jumpAt = useRef(-1);
  const [flash, setFlash] = useState<{ from: number; to: number; n: number } | null>(null);
  const loaded = useRef<string | null>(null);
  const diffFile = useRef<string | null>(null);
  const dirtyRightRef = useRef(false);
  const diffing = !!compare;

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
  const lines = Math.max(1, source.split("\n").length);

  const activeChange = changed.find((c) => c.path === active);
  const diffRows = useMemo(() => (diffing ? buildDiffRows(leftText, rightText) : []), [diffing, leftText, rightText]);
  const beforeLines = useMemo(() => rowsToSide(diffRows, "before"), [diffRows]);
  const starts = useMemo(() => changeStarts(diffRows), [diffRows]);
  const stats = useMemo(() => diffStats(diffRows), [diffRows]);
  const saveState = !active ? null : saving ? "saving" : dirty ? "dirty" : notice ? "saved" : null;

  // A new file or comparison starts the change keys from the top again.
  useEffect(() => {
    jumpAt.current = -1;
    setFlash(null);
  }, [active, compare]);
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
        if (!diffing) {
          setActive((prev) => {
            if (prev && paths.includes(prev)) return prev;
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
  }, [repoPath]);

  useEffect(() => {
    if (!compare) {
      setChanged([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    void listChangedPaths(repoPath, compare.baseRev)
      .then((paths) => {
        if (!alive) return;
        setChanged(paths);
        setActive((prev) => {
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
  }, [repoPath, compare, hint]);

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
    if (loaded.current === active) return;
    let alive = true;
    setLoading(true);
    setError("");
    setNotice("");
    void readRepoFile(repoPath, active)
      .then((file) => {
        if (!alive) return;
        loaded.current = active;
        setSource(file.content);
        setSaved(file.content);
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
  }, [repoPath, active, diffing]);

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
    setLoading(true);
    setError("");
    const fileChanged = diffFile.current !== active;
    const leftPath = activeChange?.oldPath || active;
    const rightPath = active;
    void Promise.all([
      activeChange?.status === "A" ? Promise.resolve(null) : readBlob(repoPath, compare.baseRev, leftPath),
      activeChange?.status === "D" ? Promise.resolve(null) : readBlob(repoPath, null, rightPath),
    ])
      .then(([left, right]) => {
        if (!alive) return;
        setLeftText(left);
        // Keep in-progress working-tree edits when only the compared commit changes.
        if (fileChanged || !dirtyRightRef.current) {
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
  }, [repoPath, active, compare, diffing, activeChange?.oldPath, activeChange?.status]);

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
      setNotice("Saved");
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setNotice(""), 1400);
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

  function onEditorKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      setSource(`${source.slice(0, a)}  ${source.slice(b)}`);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = a + 2;
      });
    }
  }

  function syncScroll(from: "left" | "right", e: UIEvent<HTMLElement>) {
    if (syncing.current === "jump") return;
    const other = from === "left" ? rightPane.current : leftPane.current;
    if (!other || syncing.current === (from === "left" ? "right" : "left")) return;
    syncing.current = from;
    other.scrollTop = e.currentTarget.scrollTop;
    other.scrollLeft = e.currentTarget.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = null;
    });
  }

  /** Scroll both panes to the previous or next run of changed lines and flash it. */
  function goToChange(dir: 1 | -1) {
    const at = stepChange(starts, jumpAt.current, dir);
    const left = leftPane.current;
    const row = at == null ? undefined : left?.children[at];
    if (at == null || !left || !row) return;
    jumpAt.current = at;
    let to = at;
    while (to < diffRows.length && diffRows[to].kind !== "context") to++;

    syncing.current = "jump";
    const rowTop = row.getBoundingClientRect().top - left.getBoundingClientRect().top + left.scrollTop;
    left.scrollTop = Math.max(0, rowTop - left.clientHeight / 3);
    left.scrollLeft = 0;
    const right = rightPane.current;
    if (right) {
      // The editable pane holds only working-tree lines, so count the rows that have one.
      let line = 0;
      for (let k = 0; k < at; k++) if (diffRows[k].kind !== "removed") line++;
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
            <span className={`tree-status status-${change.status}`} title={change.status}>
              {change.status}
            </span>
          ) : null}
          <span className="tree-label">{node.name}</span>
        </button>
      );
    });
  }

  return (
    <div className="editor" aria-label={diffing ? "Diff editor" : "Code editor"}>
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
            <span key={saveState} className={`editor-state is-${saveState}`}>
              {saveState === "saving" ? "saving" : saveState === "dirty" ? "edited" : "saved"}
            </span>
          ) : null}
          <span className="details-sr-only" role="status">
            {saving ? "Saving" : notice ? `${active ?? "File"} saved` : ""}
          </span>
          {diffing && active && !loading ? (
            <span className="diff-nav">
              <span className="counts" title={`${stats.added} lines added, ${stats.removed} removed`}>
                <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
              </span>
              <button
                type="button"
                className="btn"
                disabled={starts.length === 0}
                onClick={() => goToChange(-1)}
                aria-label="Previous change"
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
              <button type="button" className="btn editor-close" onClick={stopCompare}>
                Main view
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

        <div className={`editor-body${diffing ? " editor-body-diff" : ""}`}>
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
            <div className="side-diff" aria-label="Side by side diff">
              <DiffPane
                title={`${compare.baseLabel}${activeChange?.oldPath ? ` · ${activeChange.oldPath}` : ""} · read only`}
                lines={beforeLines}
                flash={flash}
                paneRef={leftPane}
                onScroll={(e) => syncScroll("left", e)}
                onKeyDown={onChangeKeys}
              />
              <div className="side-pane">
                <div className="side-pane-head">
                  {compare.headLabel}
                  {active ? ` · ${active}` : ""} · editable
                </div>
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
          ) : (
            <div className="code-edit">
              <div className="code-gutters" aria-hidden="true">
                {Array.from({ length: lines }, (_, i) => (
                  <span key={i}>{i + 1}</span>
                ))}
              </div>
              <textarea
                ref={area}
                className="code-input"
                value={source}
                rows={lines}
                spellCheck={false}
                wrap="off"
                aria-label={active}
                onChange={(e) => setSource(e.currentTarget.value)}
                onKeyDown={onEditorKey}
              />
            </div>
          )}
        </div>

        <MiniMap layout={layout} selected={selected} head={graph.head} onSelect={onSelect} />
      </div>
    </div>
  );
}

function DiffPane({
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
      <pre ref={paneRef} className="side-pane-code" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
        {lines.length === 0 ? (
          <div className="side-line empty">
            <span className="side-num" />
            <code>(empty)</code>
          </div>
        ) : (
          lines.map((line, i) => {
            const lit = !!flash && i >= flash.from && i < flash.to;
            return (
              <div
                key={lit ? `${line.key}-j${flash.n}` : line.key}
                className={`side-line ${line.kind}${lit ? " is-jump" : ""}`}
              >
                <span className="side-num">{line.number ?? ""}</span>
                <code>{line.text || " "}</code>
              </div>
            );
          })
        )}
      </pre>
    </div>
  );
}
