import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  errorMessage,
  exportGraph,
  functionVersions,
  rebaseFile,
  rebaseFunction,
  runGitCommand,
  type ChronosGraph,
  type Commit,
  type GitCommandResult,
  type ScopedActionResult,
} from "../backend";
import { functionDiffText } from "./functionDiff";
import { scopeNoun, scopeTarget, type Scope } from "./scope";
import { formatAge, truncate, type GraphLayout, type Lane } from "./layout";
import "./details.css";

interface Props {
  repoPath: string;
  graph: ChronosGraph;
  layout: GraphLayout;
  commit: Commit;
  lane: Lane;
  start: "details" | "diff" | "rebase";
  scope: Scope;
  pathAtCommit?: string;
  removed?: boolean;
  currentBranch: string | null;
  /** A rebase is paused on a conflict (App shows the way out in a note). */
  rebasePaused?: boolean;
  /** Take keyboard focus when the ticket opens (not when arrow keys walk the map). */
  autoFocus?: boolean;
  onGraphChange: (graph: ChronosGraph) => void;
  onSelect: (hash: string) => void;
  onOpenSideDiff: () => void;
  /** Open one of this commit's files in the editor (side by side with the working tree, or plain at HEAD). */
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

type Action = "rebase" | "diff" | "abort";

const STATUS_NAME: Record<string, string> = { A: "Added", M: "Changed", D: "Deleted", R: "Renamed", C: "Copied" };

function asResult(r: ScopedActionResult): GitCommandResult {
  return {
    ok: r.ok,
    exitCode: r.ok ? 0 : 1,
    command: "",
    stdout: r.stdout,
    stderr: r.stderr,
    stdoutTruncated: false,
    graphStatus: 0,
    graphPath: null,
    graphError: null,
    error: r.error,
  };
}

export function CommitDetails({
  repoPath,
  graph,
  layout,
  commit,
  lane,
  start,
  scope,
  pathAtCommit,
  removed,
  currentBranch,
  rebasePaused = false,
  autoFocus = false,
  onGraphChange,
  onSelect,
  onOpenSideDiff,
  onOpenFile,
  onClose,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [outcome, setOutcome] = useState<{ action: Action; result: GitCommandResult } | null>(null);
  const [diff, setDiff] = useState<GitCommandResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const cancelKey = useRef<HTMLButtonElement>(null);
  const rebaseKey = useRef<HTMLButtonElement>(null);
  const refocusRebase = useRef(false);
  const sheet = useRef<HTMLElement>(null);

  // Opened from the commit's action bar (which has just gone away), so the keyboard
  // carries on here instead of falling back to the top of the page.
  useEffect(() => {
    if (autoFocus) sheet.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard focus follows the rebase question: onto Cancel when it opens (the safe
  // choice), and back to the Rebase key when it is cancelled.
  useEffect(() => {
    if (confirming) cancelKey.current?.focus();
    else if (refocusRebase.current) rebaseKey.current?.focus();
    refocusRebase.current = false;
  }, [confirming]);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  function cancelConfirm() {
    refocusRebase.current = true;
    setConfirming(false);
  }

  const branchLabel = currentBranch ?? "your checkout";
  const isHead = commit.hash === graph.head;
  const scoped = scope.kind !== "project";
  const noun = scopeNoun(scope);
  const target = scoped ? scopeTarget(scope) : branchLabel;
  const pathThen = pathAtCommit ?? (scope.kind === "project" ? "" : scope.path);
  const canRebase = scoped ? !isHead && !removed : !!currentBranch && !isHead;
  const otherBranches = graph.branches.filter((b) => b.commitHash === commit.hash && b.name !== lane.name);
  const tags = commit.refs.filter((r) => r.startsWith("tag: ")).map((r) => r.slice(5));
  const children = layout.childrenOf.get(commit.hash) ?? [];
  const additions = commit.filesChanged.reduce((n, f) => n + f.additions, 0);
  const deletions = commit.filesChanged.reduce((n, f) => n + f.deletions, 0);
  const when = new Date(commit.timestamp * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  async function runGit(action: Action, args: string): Promise<GitCommandResult | null> {
    setBusy(action);
    setError("");
    try {
      const run = await runGitCommand(repoPath, args);
      if (run.graph) onGraphChange(run.graph);
      return run.result;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function act(action: Action, args: string) {
    const result = await runGit(action, args);
    setOutcome(result ? { action, result } : null);
  }

  async function rebase() {
    setConfirming(false);
    setDiff(null);
    if (scope.kind === "project") {
      await act("rebase", `rebase ${commit.hash}`);
      return;
    }
    setBusy("rebase");
    setError("");
    try {
      const run =
        scope.kind === "file"
          ? await rebaseFile(repoPath, commit.hash, pathThen, scope.path)
          : await rebaseFunction(repoPath, commit.hash, pathThen, scope.path, scope.name);
      if (run.ok) onGraphChange((await exportGraph(repoPath)).graph);
      setOutcome({ action: "rebase", result: asResult(run) });
    } catch (e) {
      setError(errorMessage(e));
      setOutcome(null);
    } finally {
      setBusy(null);
    }
  }

  async function showDiff() {
    setOutcome(null);
    if (scope.kind === "project") {
      setDiff(await runGit("diff", `diff --stat --patch -M ${commit.hash}...HEAD`));
      return;
    }
    if (scope.kind === "file") {
      const paths = [...new Set([scope.path, pathThen])].map((p) => `"${p.replace(/"/g, '\\"')}"`).join(" ");
      setDiff(await runGit("diff", `diff --stat --patch -M ${commit.hash} HEAD -- ${paths}`));
      return;
    }
    setBusy("diff");
    setError("");
    try {
      const v = await functionVersions(repoPath, commit.hash, pathThen, scope.path, scope.name);
      const text = functionDiffText(scope.path, scope.name, v.before, v.after, v.beforeStart, v.afterStart);
      setDiff(asResult({ ok: true, stdout: text, stderr: "", error: null }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }

  // Do what the bubble on the map asked for, once, when the ticket opens.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (start === "diff" && !isHead) void showDiff();
    if (start === "rebase" && canRebase) setConfirming(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const output = outcome ? [outcome.result.stdout, outcome.result.stderr].filter(Boolean).join("\n") : "";
  const stuck = !!outcome && !outcome.result.ok && /CONFLICT|rebase --(continue|abort)/.test(output);
  let outcomeTitle = "";
  if (outcome) {
    if (outcome.action === "abort") outcomeTitle = outcome.result.ok ? "Rebase aborted" : "Could not abort the rebase";
    else if (outcome.result.ok) outcomeTitle = `Rebased ${target}`;
    else outcomeTitle = stuck ? "Rebase stopped on a conflict" : "Rebase did not run";
  }

  const busyText = !busy
    ? ""
    : busy === "diff"
      ? "Comparing…"
      : busy === "abort"
        ? "Aborting the rebase…"
        : "Rebasing…";

  const rebaseNote = isHead
    ? scoped
      ? "This is already the latest version"
      : `${branchLabel} is already here`
    : scoped
      ? removed
        ? "It was deleted here"
        : `Put ${target} back to this commit`
      : currentBranch
        ? `Move ${currentBranch} onto this commit`
        : rebasePaused
          ? "Finish or abort the paused rebase first"
          : "Check out a branch first";

  return (
    <aside
      ref={sheet}
      tabIndex={-1}
      className="ticket"
      style={{ "--line": lane.color, "--on": lane.on } as CSSProperties}
      aria-label="Commit details"
    >
      <div className="ticket-band">
        <span className="ticket-line">{lane.name}</span>
        <button className="ticket-close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>

      <div className="ticket-scroll">
        <div className="ticket-head">
          <h2 className="ticket-title">{commit.message}</h2>
          {(isHead || otherBranches.length > 0 || tags.length > 0) && (
            <div className="marks">
              {isHead && <span className="mark solid">HEAD</span>}
              {otherBranches.map((b) => (
                <span key={b.name} className="mark">
                  {b.name}
                </span>
              ))}
              {tags.map((t) => (
                <span key={t} className="mark dashed">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>

        <dl className="facts">
          <dt>Author</dt>
          <dd>{commit.author}</dd>
          <dt>Committed</dt>
          <dd>
            {when} <span className="quiet">({formatAge(commit.timestamp)})</span>
          </dd>
          <dt>Commit ID</dt>
          <dd>
            <button
              className="link"
              onClick={copyHash}
              title="Copy the full commit ID"
              aria-label={`Copy commit ID ${commit.shortHash}`}
            >
              {copied ? <span className="copy-stamp">Copied</span> : commit.shortHash}
            </button>
            <span className="details-sr-only" role="status">
              {copied ? "Commit ID copied" : ""}
            </span>
          </dd>
          <dt>Comes after</dt>
          <dd className="stops">
            {commit.parents.length === 0 && <span className="quiet">Nothing. This is the first commit.</span>}
            {commit.parents.map((p) => (
              <StopLink key={p} hash={p} layout={layout} onSelect={onSelect} />
            ))}
          </dd>
          {children.length > 0 && (
            <>
              <dt>Followed by</dt>
              <dd className="stops">
                {children.map((c) => (
                  <StopLink key={c} hash={c} layout={layout} onSelect={onSelect} />
                ))}
              </dd>
            </>
          )}
        </dl>

        <div className="perforation" />

        <div className="actions">
          {confirming ? (
            <div
              className="confirm"
              role="group"
              aria-label="Confirm rebase"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Escape backs out of the question without closing the whole ticket.
                e.stopPropagation();
                cancelConfirm();
              }}
            >
              {scoped ? (
                <p>
                  Put <strong>{target}</strong> back to how it was at this commit? A new commit is added to{" "}
                  {branchLabel} that changes only {scope.kind === "file" ? "this file" : "this function"}. Every other
                  file{scope.kind === "function" ? " and the rest of this file" : ""} stays exactly as it is.
                </p>
              ) : (
                <p>
                  Rebase <strong>{currentBranch}</strong> onto this commit? Its own commits are replayed on top, which
                  rewrites the history of {currentBranch}.
                </p>
              )}
              <div className="confirm-keys">
                <button ref={cancelKey} className="key plain" onClick={cancelConfirm}>
                  Cancel
                </button>
                <button className="key amber" onClick={rebase}>
                  Rebase {scoped ? noun : currentBranch}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="key plain tall" disabled={busy !== null || isHead} onClick={onOpenSideDiff}>
                <strong>View in editor</strong>
                <span>{isHead ? "Nothing newer to compare" : "Side-by-side comparison"}</span>
              </button>
              <button
                ref={rebaseKey}
                className="key plain tall"
                disabled={busy !== null || !canRebase}
                onClick={() => setConfirming(true)}
              >
                <strong>Rebase</strong>
                <span>{rebaseNote}</span>
              </button>
            </>
          )}
        </div>

        <div className="ticket-body">
          {/* One live region that is always present, so screen readers hear progress and results. */}
          <p className="details-sr-only" role="status">
            {busyText || outcomeTitle}
          </p>
          {busy && (
            <p className="working">
              <span className="working-dot" />
              {busyText}
            </p>
          )}
          {error && (
            <p className="notice bad" role="alert">
              {error}
            </p>
          )}

          {outcome && (
            <section className={`notice ${outcome.result.ok ? "good" : "bad"}`}>
              <h3>{outcomeTitle}</h3>
              {outcome.result.error && <p>{outcome.result.error}</p>}
              {output && <pre>{output}</pre>}
              {stuck && (
                <p className="quiet">
                  Fix the conflicts and continue in the terminal, or abort here. The note at the top of the window
                  keeps both ways out after this ticket closes.
                </p>
              )}
              {stuck && (
                <button
                  className="key plain"
                  disabled={busy !== null}
                  onClick={() => act("abort", "rebase --abort")}
                >
                  Abort rebase
                </button>
              )}
            </section>
          )}

          {diff && <DiffPanel result={diff} branch={target} />}

          <section>
            <h3 className="section-title">
              Files in this commit
              <span className="counts">
                <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
              </span>
            </h3>
            {commit.filesChanged.length === 0 && <p className="quiet">This commit changes no files.</p>}
            <ul className="files">
              {commit.filesChanged.map((f, i) => {
                const row = (
                  <>
                    <span className={`status status-${f.status}`} title={STATUS_NAME[f.status] ?? f.status}>
                      {f.status}
                    </span>
                    <span className="file-main">
                      <span className="file-path">
                        {f.oldPath && <span className="quiet">{f.oldPath} to </span>}
                        {f.path}
                      </span>
                      {f.symbolsTouched.length > 0 && (
                        <span className="symbols">
                          {f.symbolsTouched.map((s) => (
                            <span
                              key={s.name}
                              className={`symbol symbol-${s.changeType.toLowerCase()}`}
                              title={`${s.kind}, ${s.changeType.toLowerCase()}, lines ${s.startLine} to ${s.endLine}`}
                            >
                              {s.name}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="counts">
                      <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                    </span>
                  </>
                );
                // A file this commit deleted has nothing to show at this commit.
                return (
                  <li key={f.path} style={{ "--i": i } as CSSProperties}>
                    {f.status === "D" ? (
                      <div className="file-row" title="Deleted in this commit">
                        {row}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="file-row"
                        disabled={busy !== null}
                        title={
                          isHead
                            ? `Open ${f.path} in the code editor`
                            : `Open ${f.path} side by side: this commit next to the working tree`
                        }
                        onClick={() => onOpenFile(f.path)}
                      >
                        {row}
                        <span className="file-open" aria-hidden="true">
                          ↗
                        </span>
                        <span className="details-sr-only">, open in the editor</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </aside>
  );
}

function StopLink({ hash, layout, onSelect }: { hash: string; layout: GraphLayout; onSelect: (hash: string) => void }) {
  const node = layout.byHash.get(hash);
  if (!node) return <span className="quiet">Older history that is not loaded</span>;
  return (
    <button
      className="stop-link"
      style={{ "--line": node.color } as CSSProperties}
      title={node.commit.message}
      onClick={() => onSelect(hash)}
    >
      <span className="stop-dot" />
      {truncate(node.commit.message, 34)}
    </button>
  );
}

/* ---------- diff ---------- */

interface DiffFile {
  name: string;
  lines: string[];
  additions: number;
  deletions: number;
}

const MAX_LINES_PER_FILE = 2000;

function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith("diff --git "));
  if (first === -1) return files;
  for (const line of lines.slice(first)) {
    if (line.startsWith("diff --git ")) {
      const b = line.lastIndexOf(" b/");
      files.push({ name: b === -1 ? line.slice(11) : line.slice(b + 3), lines: [], additions: 0, deletions: 0 });
      continue;
    }
    const file = files[files.length - 1];
    if (!file) continue;
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    file.lines.push(line);
    if (line.startsWith("+")) file.additions++;
    else if (line.startsWith("-")) file.deletions++;
  }
  return files;
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "d-hunk";
  if (line.startsWith("+")) return "d-add";
  if (line.startsWith("-")) return "d-del";
  return "";
}

function DiffPanel({ result, branch }: { result: GitCommandResult; branch: string }) {
  if (!result.ok) {
    return (
      <section className="notice bad">
        <h3>The comparison did not run</h3>
        <pre>{result.error ?? result.stderr}</pre>
      </section>
    );
  }
  const files = parseDiff(result.stdout);
  if (files.length === 0) return <p className="notice">Nothing has changed on {branch} since this commit.</p>;

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <section className="diff">
      <h3 className="section-title">
        Changed on {branch} since this commit
        <span className="counts">
          <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
        </span>
      </h3>
      {result.stdoutTruncated && <p className="quiet">Only the first 1 MB of the comparison is shown.</p>}
      {files.map((f, i) => (
        <details key={i} className="diff-file" open={files.length <= 4}>
          <summary>
            <span className="diff-caret" aria-hidden="true">
              ▸
            </span>
            <span className="diff-name">{f.name}</span>
            <span className="counts">
              <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
            </span>
          </summary>
          <pre className="diff-code">
            {f.lines.slice(0, MAX_LINES_PER_FILE).map((line, j) => (
              <div key={j} className={lineClass(line)}>
                {line || " "}
              </div>
            ))}
            {f.lines.length > MAX_LINES_PER_FILE && (
              <div className="d-hunk">{f.lines.length - MAX_LINES_PER_FILE} more lines not shown</div>
            )}
          </pre>
        </details>
      ))}
    </section>
  );
}