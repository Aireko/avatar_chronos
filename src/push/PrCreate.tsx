import { useEffect, useId, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bugCheckErrorMessage } from "../bugcheck/bugCheckService";
import { bodyFromMessage, titleFromMessage } from "./prText";
import { createPr, githubRepoOf, prInfo, type CreatedPr, type ExistingPr } from "./prService";

interface Props {
  repoPath: string;
  /** The branch that was just pushed to origin. */
  head: string;
  /** The commit message typed in the Push dialog (may be empty). */
  message: string;
  /** Branch names of the repo, offered as the base. */
  branches: string[];
  onDone: () => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "exists"; pr: ExistingPr }
  | { kind: "form" }
  | { kind: "created"; pr: CreatedPr };

function openLink(url: string) {
  if (isTauri()) void openUrl(url).catch(() => {});
}

/** The step after a push: open a pull request for the branch that was just pushed. */
export function PrCreate({ repoPath, head, message, branches, onDone }: Props) {
  const ids = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [repo, setRepo] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [base, setBase] = useState("");
  const [title, setTitle] = useState(() => titleFromMessage(message, head));
  const [body, setBody] = useState(() => bodyFromMessage(message));
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const origin = await githubRepoOf(repoPath);
        if (!origin) {
          if (live) {
            setPhase({
              kind: "unavailable",
              reason: "This repository's origin is not on GitHub, so there is nowhere to open a pull request.",
            });
          }
          return;
        }
        const info = await prInfo(origin, head);
        if (!live) return;
        setRepo(origin);
        setDefaultBranch(info.defaultBranch);
        setBase(info.defaultBranch);
        if (info.existing) {
          setPhase({ kind: "exists", pr: info.existing });
        } else if (info.defaultBranch === head) {
          setPhase({
            kind: "unavailable",
            reason: `You pushed straight to ${head}, the default branch, so there is no branch to open a pull request from.`,
          });
        } else {
          setPhase({ kind: "form" });
        }
      } catch (e) {
        if (live) setPhase({ kind: "unavailable", reason: bugCheckErrorMessage(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [repoPath, head]);

  const bases = Array.from(new Set([defaultBranch, ...branches])).filter((b) => b && b !== head);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const pr = await createPr({ repo, head, base, title: title.trim(), body, draft });
      setPhase({ kind: "created", pr });
    } catch (e) {
      setError(bugCheckErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === "loading") {
    return (
      <div className="push-note push-reviewing" role="status">
        <span className="working-dot" aria-hidden="true" />
        Checking GitHub…
      </div>
    );
  }

  if (phase.kind === "unavailable") {
    return (
      <>
        <div className="push-note warn" role="status">
          Can't offer a pull request: {phase.reason}
        </div>
        <div className="push-actions">
          <button type="button" className="btn primary" onClick={onDone}>Done</button>
        </div>
      </>
    );
  }

  if (phase.kind === "exists") {
    return (
      <>
        <div className="push-note ok" role="status">
          A pull request is already open for {head}: #{phase.pr.number} {phase.pr.title}. Your push updated it.
        </div>
        <div className="push-actions">
          <button type="button" className="btn" onClick={() => openLink(phase.pr.url)}>View on GitHub</button>
          <button type="button" className="btn primary" onClick={onDone}>Done</button>
        </div>
      </>
    );
  }

  if (phase.kind === "created") {
    return (
      <>
        <div className="push-note ok" role="status">
          Pull request #{phase.pr.number} created.
        </div>
        <div className="push-actions">
          <button type="button" className="btn" onClick={() => openLink(phase.pr.url)}>Open on GitHub</button>
          <button type="button" className="btn primary" onClick={onDone}>Done</button>
        </div>
      </>
    );
  }

  return (
    <>
      {error && (
        <div key={error} className="push-note bad push-error" role="alert">
          {error}
        </div>
      )}
      <label className="push-label" htmlFor={`${ids}-title`}>Pull request title</label>
      <input
        id={`${ids}-title`}
        className="field"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        maxLength={256}
        autoFocus
      />
      <label className="push-label" htmlFor={`${ids}-body`}>Description (optional)</label>
      <textarea
        id={`${ids}-body`}
        className="push-text"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        placeholder="What does this change do, and how can someone check it?"
      />
      <label className="push-label" htmlFor={`${ids}-base`}>Merge into</label>
      <select id={`${ids}-base`} className="field" value={base} onChange={(e) => setBase(e.currentTarget.value)}>
        {bases.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
      <label className="push-label">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.currentTarget.checked)} /> Open as draft
      </label>
      <div className="push-actions">
        <span className="push-target">{head} → {base}</span>
        <button type="button" className="btn" disabled={busy} onClick={onDone}>Skip</button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !title.trim() || !base}
          onClick={() => void create()}
        >
          {busy && <span className="working-dot" aria-hidden="true" />}
          {busy ? "Creating…" : "Create pull request"}
        </button>
      </div>
    </>
  );
}