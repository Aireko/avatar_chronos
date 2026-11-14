import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { errorMessage, exportGraph, runShellCommand, type ChronosGraph } from "../backend";
import "./details.css";

type Line = { kind: "in" | "out" | "err" | "meta"; text: string };

interface Props {
  repoPath: string;
  repoLabel: string;
  onGraphChange: (graph: ChronosGraph) => void;
  onClose: () => void;
}

/** Bottom dock: run any shell command in the open repository. */
export function Terminal({ repoPath, repoLabel, onGraphChange, onClose }: Props) {
  const [lines, setLines] = useState<Line[]>([
    { kind: "meta", text: `Chronos terminal · ${repoLabel}` },
    { kind: "meta", text: "Shell commands run in the open repository. Try `ls` or `git status`." },
  ]);
  const [input, setInput] = useState("");
  // The command that is running, if any (shown in the bar while it runs).
  const [running, setRunning] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const busy = running !== null;
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Follow new output only while the view is at the bottom, so reading back isn't yanked away.
  const pinned = useRef(true);

  useEffect(() => {
    const last = lines[lines.length - 1];
    if (pinned.current || last?.kind === "in") scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);
  // Count the seconds a long command has been running.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    field.current?.focus();
  }, []);

  async function run(raw: string) {
    const cmd = raw.trim();
    if (!cmd) return;
    if (cmd === "clear" || cmd === "cls") {
      setLines([]);
      setInput("");
      return;
    }

    setLines((prev) => [...prev, { kind: "in", text: `$ ${cmd}` }]);
    setHistory((prev) => (prev[0] === cmd ? prev : [cmd, ...prev].slice(0, 40)));
    setHistIdx(-1);
    setInput("");
    pinned.current = true;
    setElapsed(0);
    setRunning(cmd);
    try {
      const result = await runShellCommand(repoPath, cmd);
      const next: Line[] = [];
      if (result.stdout) next.push({ kind: "out", text: result.stdout.replace(/\n$/, "") });
      if (result.stderr) next.push({ kind: "err", text: result.stderr.replace(/\n$/, "") });
      if (!next.length || !result.ok) {
        next.push({ kind: "meta", text: result.ok ? `(ok, exit ${result.exitCode})` : `exit ${result.exitCode}` });
      }
      setLines((prev) => [...prev, ...next]);
      if (/^\s*git(\s|$)/.test(cmd)) {
        try {
          onGraphChange((await exportGraph(repoPath)).graph);
        } catch {
          /* best-effort */
        }
      }
    } catch (e) {
      setLines((prev) => [...prev, { kind: "err", text: errorMessage(e) }]);
    } finally {
      setRunning(null);
      field.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return onClose();
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      if (!busy) setLines([]);
      return;
    }
    if (busy) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.min(histIdx + 1, history.length - 1);
      if (i >= 0 && history[i]) {
        setHistIdx(i);
        setInput(history[i]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = histIdx - 1;
      setHistIdx(i);
      setInput(i < 0 ? "" : (history[i] ?? ""));
    }
  }

  return (
    <section className="term" aria-label="Terminal">
      <header className="term-bar">
        <span className="term-title">
          <span aria-hidden="true">&gt;_</span> Terminal
        </span>
        {running ? (
          <span className="term-running" title={running}>
            running {running}
            {elapsed > 0 ? ` · ${elapsed}s` : "…"}
          </span>
        ) : null}
        <span className="term-path" title={repoPath}>
          {repoLabel}
        </span>
        <button type="button" className="term-close" onClick={onClose} aria-label="Close terminal">
          ×
        </button>
      </header>
      <div
        className="term-scroll"
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-busy={busy}
        aria-label="Terminal output"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((line, i) => (
          <pre key={i} className={`term-line ${line.kind}`}>
            {line.text}
          </pre>
        ))}
      </div>
      <form
        className={`term-prompt${busy ? " is-busy" : ""}`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!busy) void run(input);
        }}
      >
        <span className="term-dollar" aria-hidden="true">
          $
        </span>
        <input
          ref={field}
          className="term-input"
          value={input}
          // Read-only rather than disabled while a command runs, so focus stays in the prompt.
          readOnly={busy}
          disabled={!repoPath}
          aria-busy={busy}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={onKey}
          placeholder={repoPath ? (busy ? "Running…" : "ls -la") : "Open a repository first"}
          spellCheck={false}
          aria-label="Shell command"
        />
      </form>
    </section>
  );
}
