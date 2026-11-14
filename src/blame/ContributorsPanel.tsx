// "Who worked on this?": git blame for a file, narrowed to a function or a line
// range, with a pre-filled email draft to each contributor. The draft opens in
// the user's own mail app; nothing is sent from Chronos.
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { blameFile, errorMessage, type BlameReport } from "../backend";
import {
  MAX_QUESTION_CHARS,
  buildDraft,
  contributorsInRange,
  isBot,
  isMailable,
  isNoReply,
  isUndeliverable,
  repoName,
  type Contributor,
  type DraftContext,
} from "./contributors";
import { initials } from "./initials";
import "./ContributorsPanel.css";

interface ContributorsPanelProps {
  repoPath: string;
  /** Paths seen in the exported graph, offered as suggestions. */
  filePaths: string[];
}

type Scope = { kind: "file" } | { kind: "symbol"; index: number } | { kind: "lines"; start: string; end: string };

/** Contributor rows ease in one after another; past this many they share the last delay. */
const MAX_STAGGER = 6;
/** How long "Copied" stays on the copy button. */
const COPIED_MS = 1600;

export default function ContributorsPanel({ repoPath, filePaths }: ContributorsPanelProps) {
  const [filePath, setFilePath] = useState("");
  const [revision, setRevision] = useState("");
  const [report, setReport] = useState<BlameReport>();
  const [scope, setScope] = useState<Scope>({ kind: "file" });
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const listId = useId();

  async function onBlame(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setReport(await blameFile(repoPath, filePath.trim(), revision));
      setScope({ kind: "file" });
    } catch (e) {
      setReport(undefined);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // The line range the current scope covers, or an error for a bad custom range.
  const range = useMemo(() => {
    if (!report) return null;
    if (scope.kind === "file") return { start: 1, end: report.totalLines, feature: null, error: "" };
    if (scope.kind === "symbol") {
      const s = report.symbols[scope.index];
      return s ? { start: s.startLine, end: s.endLine, feature: s.name, error: "" } : null;
    }
    const start = Number(scope.start);
    const end = Number(scope.end || scope.start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > report.totalLines) {
      return { start: 1, end: 0, feature: null, error: `Enter lines between 1 and ${report.totalLines}.` };
    }
    return { start, end, feature: null, error: "" };
  }, [report, scope]);

  const people = useMemo(
    () => (report && range && !range.error ? contributorsInRange(report, range.start, range.end) : []),
    [report, range],
  );

  async function onEmail(person: Contributor) {
    if (!report || !range) return;
    const ctx: DraftContext = {
      repoName: repoName(report.repoPath),
      path: report.path,
      feature: range.feature,
      start: range.start,
      end: range.end,
      totalLines: report.totalLines,
      question,
    };
    setError("");
    setNotice("");
    try {
      const draft = buildDraft(person, ctx);
      if (isTauri()) await openUrl(draft.url);
      else window.location.href = draft.url;
      setNotice(
        `Opened a draft to ${person.name} in your mail app. Review it there and send it yourself.` +
          (draft.shortened ? " Your question was shortened to fit in an email link; paste the rest into the draft." : ""),
      );
    } catch (e) {
      setError(`Couldn't open your mail app: ${errorMessage(e)}`);
    }
  }

  async function onCopy(email: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(email);
      setNotice(`Copied ${email}.`);
      return true;
    } catch {
      setError("Couldn't copy to the clipboard.");
      return false;
    }
  }

  // Reveal the blamed file in Explorer / Finder / the desktop file manager.
  async function onReveal() {
    if (!report) return;
    setError("");
    setNotice("");
    let fullPath = `${report.repoPath.replace(/[\\/]+$/, "")}/${report.path}`;
    if (navigator.userAgent.includes("Windows")) fullPath = fullPath.replace(/\//g, "\\");
    try {
      await revealItemInDir(fullPath);
    } catch (e) {
      setError(`Couldn't open the file explorer: ${errorMessage(e)}`);
    }
  }

  const inTauri = isTauri();

  return (
    <section className="people-panel" aria-labelledby="people-title">
      <h2 id="people-title" className="people-sr-only">
        Who worked on this?
      </h2>
      <p className="people-muted people-intro">
        Uses git blame to find who last changed each line, then opens an email draft to them in your own mail app.
      </p>

      <form className="people-find" onSubmit={onBlame}>
        <input
          aria-label="File path, relative to the repository root"
          placeholder="src/parser.c"
          list={listId}
          value={filePath}
          onChange={(e) => setFilePath(e.currentTarget.value)}
          className="field people-path"
        />
        <datalist id={listId}>
          {filePaths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <input
          aria-label="Revision (default HEAD)"
          placeholder="HEAD"
          value={revision}
          onChange={(e) => setRevision(e.currentTarget.value)}
          className="field people-rev"
        />
        <button className="btn primary" type="submit" disabled={busy || !repoPath.trim() || !filePath.trim()}>
          {busy ? "Running blame..." : "Find contributors"}
        </button>
      </form>
      {!repoPath.trim() && <p className="people-muted">Enter a repository path at the top first.</p>}

      {error && (
        // Keyed by the text, so a different error is noticed even where one was already shown.
        <p key={error} className="error people-error" role="alert">
          {error}
        </p>
      )}
      <div role="status" aria-live="polite">
        {notice && (
          <p key={notice} className="people-notice">
            {notice}
          </p>
        )}
      </div>

      {busy && !report && (
        <p className="working people-working" role="status">
          <span className="working-dot" aria-hidden="true" />
          Reading git blame for {filePath.trim()}...
        </p>
      )}

      {report && range && (
        // A fresh blame (another file or revision) eases in again; changing the scope does not.
        <div
          key={`${report.path}@${report.revision}`}
          className="people-report"
          aria-busy={busy || undefined}
        >
          <div className="people-scope">
            <label className="people-label" htmlFor="people-scope">
              Scope
            </label>
            <div className="people-scope-row">
              <select
                id="people-scope"
                className="field people-select"
                value={scope.kind === "symbol" ? `symbol:${scope.index}` : scope.kind}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  if (v === "file") setScope({ kind: "file" });
                  else if (v === "lines") setScope({ kind: "lines", start: "1", end: String(report.totalLines) });
                  else setScope({ kind: "symbol", index: Number(v.slice("symbol:".length)) });
                }}
              >
                <option value="file">
                  Whole file ({report.path}, {report.totalLines} lines)
                </option>
                {report.symbols.length > 0 && (
                  <optgroup label="Function or class">
                    {report.symbols.map((s, i) => (
                      <option key={`${s.name}:${s.startLine}`} value={`symbol:${i}`}>
                        {s.name} ({s.kind}, lines {s.startLine}-{s.endLine})
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="lines">Custom line range...</option>
              </select>
              <button
                type="button"
                className="btn"
                onClick={onReveal}
                disabled={!inTauri}
                title={inTauri ? `Show ${report.path} in your file explorer` : "Only available in the desktop app"}
              >
                Show in Explorer
              </button>
            </div>
            {scope.kind === "lines" && (
              <div className="people-lines">
                <input
                  aria-label="First line"
                  inputMode="numeric"
                  className="field people-num"
                  aria-invalid={range.error ? true : undefined}
                  aria-describedby={range.error ? "people-range-error" : undefined}
                  value={scope.start}
                  onChange={(e) => setScope({ ...scope, start: e.currentTarget.value })}
                />
                <span>to</span>
                <input
                  aria-label="Last line"
                  inputMode="numeric"
                  className="field people-num"
                  aria-invalid={range.error ? true : undefined}
                  aria-describedby={range.error ? "people-range-error" : undefined}
                  value={scope.end}
                  onChange={(e) => setScope({ ...scope, end: e.currentTarget.value })}
                />
              </div>
            )}
          </div>
          {range.error && (
            <p id="people-range-error" className="error people-error" role="alert">
              {range.error}
            </p>
          )}
          <p className="people-muted">
            Blamed at <code>{report.revision.slice(0, 7)}</code>. Whitespace-only changes are ignored, and moved
            lines are credited to whoever originally wrote them.
          </p>

          <label className="people-question">
            <span className="people-label">Your question (goes into the email)</span>
            <textarea
              rows={3}
              className="field people-textarea"
              maxLength={MAX_QUESTION_CHARS}
              aria-describedby="people-question-count"
              value={question}
              placeholder="e.g. Why does this retry three times before giving up?"
              onChange={(e) => setQuestion(e.currentTarget.value)}
            />
            <span
              id="people-question-count"
              // Turns to the warning pen when the question is close to the limit.
              className={`people-muted people-count${question.length >= MAX_QUESTION_CHARS * 0.9 ? " people-near" : ""}`}
            >
              {question.length} / {MAX_QUESTION_CHARS} characters
            </span>
          </label>

          {people.length === 0 && !range.error ? (
            <p className="people-empty">No committed lines in this range.</p>
          ) : (
            <ul className="people-list">
              {people.map((person, index) => (
                <PersonRow
                  key={`${person.email}|${person.name}`}
                  person={person}
                  order={index}
                  total={range.end - range.start + 1}
                  onEmail={() => onEmail(person)}
                  onCopy={() => onCopy(person.email)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

interface PersonRowProps {
  person: Contributor;
  /** Position in the list, for the staggered entrance. */
  order: number;
  total: number;
  onEmail(): void;
  /** Resolves true when the address reached the clipboard. */
  onCopy(): Promise<boolean>;
}

function PersonRow({ person, order, total, onEmail, onCopy }: PersonRowProps) {
  // The copy button says "Copied" for a moment, right where the user is looking.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  async function copy() {
    if (!(await onCopy())) return;
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }

  const share = total > 0 ? Math.round((person.lines / total) * 100) : 0;
  const bot = isBot(person.name, person.email);
  const undeliverable = isUndeliverable(person.email);
  const noReply = !undeliverable && isNoReply(person.email);
  const blocked = !isMailable(person.email)
    ? "Git has no usable email address for this person."
    : bot
      ? "This is a bot account."
      : undeliverable
        ? "This is a private GitHub address that can't receive email. Reach them through the commit on GitHub instead."
        : "";
  const date = new Date(person.latest.time * 1000).toLocaleDateString();

  return (
    <li className="people-person" style={{ "--i": Math.min(order, MAX_STAGGER) } as CSSProperties}>
      <div className="people-id">
        {/* Initials in this person's pen, the same pen as their share bar. */}
        <span className="people-avatar" aria-hidden="true">
          {initials(person.name, person.email)}
        </span>
        <div className="people-who">
          <strong className="people-name">{person.name || "(no name)"}</strong>
          {bot && <span className="mark dashed people-tag">bot</span>}
          <span className="people-email">{person.email || "no email recorded"}</span>
        </div>
      </div>
      <div className="people-share">
        <span className="people-bar" aria-hidden>
          <span className="people-bar-fill" style={{ width: `${share}%` }} />
        </span>
        <span>
          {person.lines} {person.lines === 1 ? "line" : "lines"} ({share}%) in {person.commits}{" "}
          {person.commits === 1 ? "commit" : "commits"}
        </span>
      </div>
      <div className="people-muted people-latest">
        Latest: <code>{person.latest.hash.slice(0, 7)}</code> {person.latest.summary} ({date})
      </div>
      {noReply && <div className="people-warn">This looks like a no-reply address, so email may not reach them.</div>}
      {blocked && <div className="people-warn">{blocked}</div>}
      <div className="people-actions">
        <button type="button" className="btn primary" onClick={onEmail} disabled={blocked !== ""}>
          Email {person.name.split(/\s+/)[0] || "them"}
        </button>
        {person.email && (
          <button
            type="button"
            className={copied ? "btn people-copied" : "btn"}
            onClick={() => void copy()}
          >
            {/* Both labels share one grid cell so the button keeps its width; the hidden one is
                visibility: hidden, which also keeps it out of the accessible name. */}
            <span className="people-swap">
              <span className={copied ? "is-off" : undefined}>Copy address</span>
              <span className={copied ? "people-copied-label" : "is-off"}>Copied</span>
            </span>
          </button>
        )}
      </div>
    </li>
  );
}
