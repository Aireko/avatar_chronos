import type { ChronosGraph, Commit, FileChange, SymbolKind } from "../backend";

export type Scope =
  | { kind: "project" }
  | { kind: "file"; path: string }
  | { kind: "function"; path: string; name: string };

export const PROJECT: Scope = { kind: "project" };

export function scopeKey(scope: Scope): string {
  if (scope.kind === "project") return "project";
  if (scope.kind === "file") return `file:${scope.path}`;
  return `function:${scope.path}#${scope.name}`;
}

export const scopeNoun = (scope: Scope): "branch" | "file" | "function" =>
  scope.kind === "project" ? "branch" : scope.kind;

export function scopeTarget(scope: Scope): string {
  if (scope.kind === "project") return "project";
  if (scope.kind === "file") return scope.path;
  return `${scope.name}()`;
}

export interface ScopedGraph {
  graph: ChronosGraph;
  pathAt: Map<string, string>;
  gone: Set<string>;
}

interface Touch {
  commit: Commit;
  change: FileChange;
}

function touchesOf(commits: Commit[], path: string): Touch[] {
  const names = new Set([path]);
  const touches: Touch[] = [];
  for (const commit of commits) {
    const change = commit.filesChanged.find((f) => names.has(f.path));
    if (!change) continue;
    if (change.oldPath && change.status === "R") names.add(change.oldPath);
    touches.push({ commit, change });
  }
  return touches;
}

const unique = (items: string[]) => [...new Set(items)];

export function scopeGraph(full: ChronosGraph, scope: Scope): ScopedGraph {
  if (scope.kind === "project") return { graph: full, pathAt: new Map(), gone: new Set() };

  const pathAt = new Map<string, string>();
  const gone = new Set<string>();
  const kept = new Map<string, Commit>();

  for (const { commit, change } of touchesOf(full.commits, scope.path)) {
    if (scope.kind === "function") {
      const symbol = change.symbolsTouched.find((s) => s.name === scope.name);
      if (!symbol) continue;
      kept.set(commit.hash, { ...commit, filesChanged: [{ ...change, symbolsTouched: [symbol] }] });
      if (symbol.changeType === "DELETED") gone.add(commit.hash);
    } else {
      kept.set(commit.hash, { ...commit, filesChanged: [change] });
      if (change.status === "D") gone.add(commit.hash);
    }
    pathAt.set(commit.hash, change.path);
  }

  const loaded = new Set(full.commits.map((c) => c.hash));
  const nearest = new Map<string, string[]>();
  const reach = (hash: string): string[] => (loaded.has(hash) ? (nearest.get(hash) ?? []) : [hash]);
  const commits: Commit[] = [];

  for (let i = full.commits.length - 1; i >= 0; i--) {
    const c = full.commits[i];
    const up = unique(c.parents.flatMap(reach));
    const keptCommit = kept.get(c.hash);
    if (keptCommit) {
      nearest.set(c.hash, [c.hash]);
      commits.push({ ...keptCommit, parents: up });
    } else {
      nearest.set(c.hash, up);
    }
  }
  commits.reverse();

  const standIn = (hash: string | null) => (hash ? (nearest.get(hash) ?? []).find((h) => kept.has(h)) : undefined);

  const branches = full.branches.flatMap((b) => {
    const tip = standIn(b.commitHash);
    return tip ? [{ ...b, commitHash: tip }] : [];
  });

  return { graph: { ...full, head: standIn(full.head) ?? null, branches, commits }, pathAt, gone };
}

export interface FunctionChoice {
  name: string;
  kind: SymbolKind;
  atHead: boolean;
}

export function functionChoices(
  full: ChronosGraph,
  path: string,
  atHead: { name: string; kind: SymbolKind }[],
): FunctionChoice[] {
  const byName = new Map<string, FunctionChoice>();
  for (const s of atHead) byName.set(s.name, { name: s.name, kind: s.kind, atHead: true });
  for (const { change } of touchesOf(full.commits, path)) {
    for (const s of change.symbolsTouched) {
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, kind: s.kind, atHead: false });
    }
  }
  return [...byName.values()].sort((a, b) => Number(b.atHead) - Number(a.atHead) || a.name.localeCompare(b.name));
}