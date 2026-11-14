import { useState } from "react";
import { errorMessage, type ChronosGraph } from "../backend";
import { branchNames, createBranch, switchBranch } from "./git";

interface Props {
  graph: ChronosGraph | undefined;
  currentBranch: string | null;
  onGraphChange: (g: ChronosGraph) => void;
  onError: (msg: string) => void;
}

export function BranchSwitcher({ graph, currentBranch, onGraphChange, onError }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  if (!graph) return null;
  const repo = graph.repoPath;
  const names = branchNames(graph);

  async function change(branch: string) {
    try {
      onError("");
      onGraphChange(await switchBranch(repo, branch));
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  async function create() {
    const branch = name.trim();
    if (!branch) return;
    try {
      onError("");
      onGraphChange(await createBranch(repo, branch));
      setName("");
      setCreating(false);
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  if (creating) {
    return (
      <form
        className="open-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          className="field branch-switch"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="new-branch-name"
          aria-label="New branch name"
          spellCheck={false}
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={!name.trim()}>Create</button>
        <button className="btn" type="button" onClick={() => { setCreating(false); setName(""); }}>Cancel</button>
      </form>
    );
  }

  return (
    <>
      <select
        className="field branch-switch"
        value={currentBranch ?? ""}
        onChange={(e) => void change(e.currentTarget.value)}
        aria-label="Switch branch"
      >
        {currentBranch === null && <option value="">(detached)</option>}
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <button className="btn" type="button" onClick={() => setCreating(true)} title="Create a new branch">
        + Branch
      </button>
    </>
  );
}