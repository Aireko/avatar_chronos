import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { errorMessage, exportGraph, runShellCommand, type ChronosGraph } from "../backend";

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
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);
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
    setBusy(true);
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
      setBusy(false);
      field.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return onClose();
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
        <span className="term-path" title={repoPath}>
          {repoLabel}
        </span>
        <button type="button" className="term-close" onClick={onClose} aria-label="Close terminal">
          ×
        </button>
      </header>
      <div className="term-scroll" ref={scroller}>
        {lines.map((line, i) => (
          <pre key={i} className={`term-line ${line.kind}`}>
            {line.text}
          </pre>
        ))}
      </div>
      <form
        className="term-prompt"
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
          disabled={busy || !repoPath}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={onKey}
          placeholder={repoPath ? "ls -la" : "Open a repository first"}
          spellCheck={false}
          aria-label="Shell command"
        />
      </form>
    </section>
  );
}
