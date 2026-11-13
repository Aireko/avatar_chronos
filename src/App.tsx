import { useEffect, useState } from "react";
import {
  analyzeMerge,
  backendVersion,
  errorMessage,
  exportGraph,
  runGitCommand,
  type ChronosGraph,
  type GitCommandResult,
  type LineRange,
} from "./backend";
import AiPanel from "./ai/AiPanel";
import "./App.css";

const fmtRange = (r: LineRange | null) => (r ? `${r[0]}-${r[1]}` : "-");
const preStyle = { maxHeight: 240, overflow: "auto", textAlign: "left" as const, whiteSpace: "pre-wrap" as const };

function App() {
  const [version, setVersion] = useState<string>();
  const [repoPath, setRepoPath] = useState("");
  const [gitArgs, setGitArgs] = useState("status --short --branch");
  const [source, setSource] = useState("feature");
  const [target, setTarget] = useState("main");
  const [graph, setGraph] = useState<ChronosGraph>();
  const [graphPath, setGraphPath] = useState("");
  const [command, setCommand] = useState<GitCommandResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    backendVersion().then(setVersion, (e: unknown) => setError(errorMessage(e)));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const onExport = () =>
    run(async () => {
      const r = await exportGraph(repoPath);
      setGraph(r.graph);
      setGraphPath(r.graphPath);
    });

  const onMerge = () =>
    run(async () => {
      const r = await analyzeMerge(repoPath, source, target);
      setGraph(r.graph);
      setGraphPath(r.graphPath);
    });

  const onCommand = () =>
    run(async () => {
      const r = await runGitCommand(repoPath, gitArgs);
      setCommand(r.result);
      if (r.graph) setGraph(r.graph);
      setGraphPath(r.graphPath);
    });

  const disabled = busy || repoPath.trim() === "";
  const merge = graph?.mergeAnalysis;

  return (
    <main className="container">
      <h1>Chronos</h1>
      <p className="subtitle">{version ? `C backend: ${version}` : "C backend not connected"}</p>

      <div className="row">
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.currentTarget.value)}
          placeholder="C:\path\to\repo"
          style={{ flex: 1 }}
        />
        <button onClick={onExport} disabled={disabled}>
          Export graph
        </button>
      </div>

      <div className="row">
        <input value={source} onChange={(e) => setSource(e.currentTarget.value)} placeholder="source branch" />
        <span>into</span>
        <input value={target} onChange={(e) => setTarget(e.currentTarget.value)} placeholder="target branch" />
        <button onClick={onMerge} disabled={disabled}>
          Analyze merge
        </button>
      </div>

      <div className="row">
        <span>git</span>
        <input value={gitArgs} onChange={(e) => setGitArgs(e.currentTarget.value)} style={{ flex: 1 }} />
        <button onClick={onCommand} disabled={disabled}>
          Run
        </button>
      </div>

      {busy && <p>Working...</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {command && (
        <section>
          <h2>
            {command.command}: {command.ok ? "ok" : `failed (exit ${command.exitCode})`}
          </h2>
          {command.error && <p className="error">{command.error}</p>}
          {command.graphError && <p className="error">graph: {command.graphError}</p>}
          {command.stdout && <pre style={preStyle}>{command.stdout}</pre>}
          {command.stderr && <pre style={preStyle}>{command.stderr}</pre>}
        </section>
      )}

      {graph && (
        <section>
          <h2>Graph</h2>
          <p>
            {graph.commits.length} commits, {graph.branches.length} branches, HEAD {graph.head?.slice(0, 7) ?? "none"}
            <br />
            <small>{graphPath}</small>
          </p>
          <p>
            {graph.branches.map((b) => (
              <span key={b.name} style={{ marginRight: 12, fontWeight: b.isHead ? 700 : 400 }}>
                {b.name} @ {b.commitHash.slice(0, 7)}
              </span>
            ))}
          </p>
          <table>
            <thead>
              <tr>
                <th>commit</th>
                <th>message</th>
                <th>parents</th>
                <th>refs</th>
                <th>files / symbols</th>
              </tr>
            </thead>
            <tbody>
              {graph.commits.slice(0, 50).map((c) => (
                <tr key={c.hash}>
                  <td>{c.shortHash}</td>
                  <td>{c.message}</td>
                  <td>{c.parents.length}</td>
                  <td>{c.refs.join(", ")}</td>
                  <td>
                    {c.filesChanged
                      .map((f) => `${f.status} ${f.path} [${f.symbolsTouched.map((s) => s.name).join(", ")}]`)
                      .join("; ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {merge?.active && (
        <section>
          <h2>
            Merge {merge.sourceBranch} into {merge.targetBranch}:{" "}
            {merge.canAutoMerge ? "can auto-merge" : "has true collisions"}
          </h2>
          <table>
            <thead>
              <tr>
                <th>file</th>
                <th>symbol</th>
                <th>status</th>
                <th>ours</th>
                <th>theirs</th>
              </tr>
            </thead>
            <tbody>
              {merge.conflicts.map((c, i) => (
                <tr key={i}>
                  <td>{c.filePath}</td>
                  <td>{c.symbolName ?? "(file)"}</td>
                  <td>{c.resolutionStatus}</td>
                  <td>{fmtRange(c.oursRange)}</td>
                  <td>{fmtRange(c.theirsRange)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {merge.conflicts
            .filter((c) => c.resolutionStatus === "TRUE_COLLISION")
            .map((c, i) => (
              <details key={i}>
                <summary>
                  {c.filePath} / {c.symbolName ?? "(file)"}
                </summary>
                <p>base</p>
                <pre style={preStyle}>{c.baseSnippet}</pre>
                <p>ours ({merge.targetBranch})</p>
                <pre style={preStyle}>{c.oursSnippet}</pre>
                <p>theirs ({merge.sourceBranch})</p>
                <pre style={preStyle}>{c.theirsSnippet}</pre>
              </details>
            ))}
        </section>
      )}

      <AiPanel />
    </main>
  );
}

export default App;