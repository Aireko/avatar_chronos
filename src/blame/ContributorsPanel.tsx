// "Who worked on this?": git blame for a file, narrowed to a function or a line
// range, with a pre-filled email draft to each contributor. The draft opens in
// the user's own mail app; nothing is sent from Chronos.
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { useId, useMemo, useState, type FormEvent } from "react";
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
import "./ContributorsPanel.css";

interface ContributorsPanelProps {
  repoPath: string;
  /** Paths seen in the exported graph, offered as suggestions. */
  filePaths: string[];
}

type Scope = { kind: "file" } | { kind: "symbol"; index: number } | { kind: "lines"; start: string; end: string };

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

  async function onCopy(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      setNotice(`Copied ${email}.`);
    } catch {
      setError("Couldn't copy to the clipboard.");
    }
  }

  return (
    <section className="people-panel" aria-labelledby="people-title">
      <h2 id="people-title">Who worked on this?</h2>
      <p className="people-muted">
        Uses git blame to find who last changed each line, then opens an email draft to them in your own mail app.
      </p>

      <form className="people-row" onSubmit={onBlame}>
        <input
          aria-label="File path, relative to the repository root"
          placeholder="src/parser.c"
          list={listId}
          value={filePath}
          onChange={(e) => setFilePath(e.currentTarget.value)}
          className="people-grow"
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
          className="people-narrow"
        />
        <button type="submit" disabled={busy || !repoPath.trim() || !filePath.trim()}>
          {busy ? "Running blame..." : "Find contributors"}
        </button>
      </form>
      {!repoPath.trim() && <p className="people-muted">Enter a repository path at the top first.</p>}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div role="status" aria-live="polite">
        {notice && <p className="people-notice">{notice}</p>}
      </div>

      {report && range && (
        <>
          <div className="people-row">
            <label htmlFor="people-scope">Scope</label>
            <select
              id="people-scope"
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
            {scope.kind === "lines" && (
              <>
                <input
                  aria-label="First line"
                  inputMode="numeric"
                  className="people-num"
                  aria-invalid={range.error ? true : undefined}
                  aria-describedby={range.error ? "people-range-error" : undefined}
                  value={scope.start}
                  onChange={(e) => setScope({ ...scope, start: e.currentTarget.value })}
                />
                <span>to</span>
                <input
                  aria-label="Last line"
                  inputMode="numeric"
                  className="people-num"
                  aria-invalid={range.error ? true : undefined}
                  aria-describedby={range.error ? "people-range-error" : undefined}
                  value={scope.end}
                  onChange={(e) => setScope({ ...scope, end: e.currentTarget.value })}
                />
              </>
            )}
          </div>
          {range.error && (
            <p id="people-range-error" className="error" role="alert">
              {range.error}
            </p>
          )}
          <p className="people-muted">
            Blamed at <code>{report.revision.slice(0, 7)}</code>. Whitespace-only changes are ignored, and moved
            lines are credited to whoever originally wrote them.
          </p>

          <label className="people-question">
            <span>Your question (goes into the email)</span>
            <textarea
              rows={3}
              maxLength={MAX_QUESTION_CHARS}
              aria-describedby="people-question-count"
              value={question}
              placeholder="e.g. Why does this retry three times before giving up?"
              onChange={(e) => setQuestion(e.currentTarget.value)}
            />
            <span id="people-question-count" className="people-muted">
              {question.length} / {MAX_QUESTION_CHARS} characters
            </span>
          </label>

          {people.length === 0 && !range.error ? (
            <p className="people-muted">No committed lines in this range.</p>
          ) : (
            <ul className="people-list">
              {people.map((person) => (
                <PersonRow
                  key={`${person.email}|${person.name}`}
                  person={person}
                  total={range.end - range.start + 1}
                  onEmail={() => onEmail(person)}
                  onCopy={() => onCopy(person.email)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

interface PersonRowProps {
  person: Contributor;
  total: number;
  onEmail(): void;
  onCopy(): void;
}

function PersonRow({ person, total, onEmail, onCopy }: PersonRowProps) {
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
    <li className="people-person">
      <div className="people-who">
        <strong>{person.name || "(no name)"}</strong>
        <span className="people-muted">{person.email || "no email recorded"}</span>
        {bot && <span className="people-tag">bot</span>}
      </div>
      <div className="people-share">
        <span className="people-bar" aria-hidden>
          <span style={{ width: `${share}%` }} />
        </span>
        <span>
          {person.lines} {person.lines === 1 ? "line" : "lines"} ({share}%) in {person.commits}{" "}
          {person.commits === 1 ? "commit" : "commits"}
        </span>
      </div>
      <div className="people-muted">
        Latest: <code>{person.latest.hash.slice(0, 7)}</code> {person.latest.summary} ({date})
      </div>
      {noReply && <div className="people-warn">This looks like a no-reply address, so email may not reach them.</div>}
      {blocked && <div className="people-warn">{blocked}</div>}
      <div className="people-actions">
        <button type="button" onClick={onEmail} disabled={blocked !== ""}>
          Email {person.name.split(/\s+/)[0] || "them"}
        </button>
        {person.email && (
          <button type="button" onClick={onCopy}>
            Copy address
          </button>
        )}
      </div>
    </li>
  );
}
