// Typed wrappers for the Tauri commands in src-tauri/src/lib.rs, each of which
// calls the Chronos C backend in backend/.
import { invoke, isTauri } from "@tauri-apps/api/core";

/* ---------- chronos_graph.json contract ---------- */

export type FileStatus = "A" | "M" | "D" | "R" | "C";
export type SymbolKind = "function" | "method" | "class";
export type ChangeType = "ADDED" | "MODIFIED" | "DELETED";
export type ResolutionStatus = "CLEAN" | "AUTO_RESOLVABLE" | "TRUE_COLLISION";
export type LineRange = [number, number];

export interface SymbolTouched {
  name: string;
  kind: SymbolKind;
  changeType: ChangeType;
  startLine: number;
  endLine: number;
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  symbolsTouched: SymbolTouched[];
}

export interface Commit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  /** Unix time in seconds. */
  timestamp: number;
  message: string;
  refs: string[];
  filesChanged: FileChange[];
}

export interface Branch {
  name: string;
  commitHash: string;
  isHead: boolean;
}

export interface MergeConflict {
  filePath: string;
  symbolName: string | null;
  resolutionStatus: ResolutionStatus;
  oursRange: LineRange | null;
  theirsRange: LineRange | null;
  baseSnippet: string;
  oursSnippet: string;
  theirsSnippet: string;
}

export interface MergeAnalysis {
  active: boolean;
  sourceBranch: string | null;
  targetBranch: string | null;
  mergeBase: string | null;
  canAutoMerge: boolean;
  conflicts: MergeConflict[];
}

export interface ChronosGraph {
  repoPath: string;
  head: string | null;
  generatedAt: number;
  branches: Branch[];
  commits: Commit[];
  mergeAnalysis: MergeAnalysis;
}

export interface GitCommandResult {
  ok: boolean;
  exitCode: number;
  command: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  graphStatus: number;
  graphPath: string | null;
  graphError: string | null;
  error: string | null;
}

/* ---------- blame contract (chronos_blame in backend/include/avatar.h) ---------- */

export interface BlameAuthor {
  name: string;
  email: string;
  lines: number;
  commits: number;
  /** Unix time in seconds of their newest commit that still owns a line. */
  lastTime: number;
  lastCommit: string;
  lastSummary: string;
}

export interface BlameCommit {
  hash: string;
  author: string;
  email: string;
  /** Unix time in seconds. */
  time: number;
  summary: string;
  /** Lines of the file this commit last changed. */
  lines: number;
}

/** Consecutive lines (1-based, inclusive) last changed by one commit. */
export interface BlameRange {
  start: number;
  end: number;
  commit: string;
}

/** A function, method or class detected in the file, with its full extent. */
export interface BlameSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
}

export interface BlameReport {
  repoPath: string;
  path: string;
  /** Full SHA of the blamed revision. */
  revision: string;
  totalLines: number;
  /** Whole-file totals, most lines first. */
  authors: BlameAuthor[];
  /** Newest first. */
  commits: BlameCommit[];
  ranges: BlameRange[];
  symbols: BlameSymbol[];
}

/** Mirrors `ffi::BackendError`: what a command rejects with. */
export interface BackendError {
  code: number;
  message: string;
}

export interface GraphLoad {
  graphPath: string;
  graph: ChronosGraph;
}

export interface CommandRun {
  result: GitCommandResult;
  graphPath: string;
  graph: ChronosGraph | null;
}

/* ---------- commands ---------- */

interface GraphPayloadRaw {
  graphPath: string;
  graphJson: string;
}

interface CommandPayloadRaw {
  resultJson: string;
  graphPath: string;
  graphJson: string | null;
}

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(
      new Error("The C backend is only available inside the app. Start it with `npm run tauri:dev`."),
    );
  }
  return invoke<T>(command, args);
}

export const backendVersion = () => call<string>("backend_version");

export async function exportGraph(
  repoPath: string,
  options: { outputPath?: string; maxCommits?: number } = {},
): Promise<GraphLoad> {
  const raw = await call<GraphPayloadRaw>("export_graph", {
    repoPath,
    outputPath: options.outputPath ?? null,
    maxCommits: options.maxCommits ?? null,
  });
  return { graphPath: raw.graphPath, graph: JSON.parse(raw.graphJson) as ChronosGraph };
}

/** gitArgs excludes the leading "git", e.g. `commit -m "fix parser"`. */
export async function runGitCommand(repoPath: string, gitArgs: string, outputPath?: string): Promise<CommandRun> {
  const raw = await call<CommandPayloadRaw>("run_git_command", {
    repoPath,
    gitArgs,
    outputPath: outputPath ?? null,
  });
  return {
    result: JSON.parse(raw.resultJson) as GitCommandResult,
    graphPath: raw.graphPath,
    graph: raw.graphJson ? (JSON.parse(raw.graphJson) as ChronosGraph) : null,
  };
}

export async function analyzeMerge(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  outputPath?: string,
): Promise<GraphLoad> {
  const raw = await call<GraphPayloadRaw>("analyze_merge", {
    repoPath,
    sourceBranch,
    targetBranch,
    outputPath: outputPath ?? null,
  });
  return { graphPath: raw.graphPath, graph: JSON.parse(raw.graphJson) as ChronosGraph };
}

/** Who wrote each line of `filePath` (relative to the repository root) at `revision` (default HEAD). */
export async function blameFile(repoPath: string, filePath: string, revision?: string): Promise<BlameReport> {
  const raw = await call<{ blameJson: string }>("blame_file", {
    repoPath,
    filePath,
    revision: revision?.trim() || null,
  });
  return JSON.parse(raw.blameJson) as BlameReport;
}

/* ---------- context compiler views (context_views.h) ---------- */

export type ContextScopeKind = "project" | "module" | "file" | "symbol";
export type ContextRelationState =
  | "selected"
  | "omitted"
  | "unresolved"
  | "ambiguous"
  | "unavailable";
export type ContextEvidenceKind = "call" | "contains" | "change" | "source";
export type ContextCoverage = "complete" | "incomplete" | "unavailable";

export interface ContextRange {
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

export interface ContextRevision {
  repositoryId: string;
  commitSha: string;
}

export interface ContextLocation {
  revision: ContextRevision;
  filePath: string;
  range: ContextRange;
}

export interface ContextCall {
  caller: { revision: ContextRevision; id: string };
  calleeText: string;
  callSite: ContextLocation;
  resolution: "resolved" | "unresolved" | "ambiguous";
  callee: { revision: ContextRevision; id: string } | null;
  candidates: { revision: ContextRevision; id: string }[];
}

export interface ContextEvidence {
  id: string;
  kind: ContextEvidenceKind;
  state: ContextRelationState;
  location: ContextLocation | null;
  call: ContextCall | null;
}

export interface ContextCollection<T> {
  status: ContextCoverage;
  items: T[] | null;
}

export interface ContextGraphNode {
  id: string;
  kind: ContextScopeKind;
  parentId: string | null;
  label: string;
  symbol: { revision: ContextRevision; id: string } | null;
  coverage: ContextCoverage;
  state: ContextRelationState;
}

export interface ContextGraphEdge {
  id: string;
  from: string;
  to: string | null;
  kind: ContextEvidenceKind;
  state: ContextRelationState;
  evidenceId: string;
  call: ContextCall | null;
}

export interface ContextGraphDocument {
  schemaVersion: number;
  repositoryId: string;
  revision: ContextRevision;
  nodes: ContextCollection<ContextGraphNode>;
  edges: ContextCollection<ContextGraphEdge>;
  evidence: ContextCollection<ContextEvidence>;
  diagnostics: unknown[];
  adapter: {
    name: string;
    schemaVersion: number;
    graphSchemaVersion: number;
    briefSchemaVersion: number;
    reviewContextSchemaVersion: number;
  };
}

export interface ContextBriefItem {
  text: string;
  evidenceIds: string[];
  state: ContextRelationState;
}

export interface ContextBriefSection {
  id: string;
  title: string;
  items: ContextBriefItem[];
}

export interface ContextBriefDocument {
  schemaVersion: number;
  repositoryId: string;
  revision: ContextRevision;
  comparison: { base: ContextRevision; head: ContextRevision } | null;
  sections: ContextBriefSection[];
  budget: { usedSourceBytes: number };
  omittedEvidenceIds: string[];
  coverage: ContextCoverage;
  evidence: ContextCollection<ContextEvidence>;
}

export interface ContextViews {
  schemaVersion: number;
  repositoryId: string;
  revision: ContextRevision;
  targetCount?: number;
  brief: ContextBriefDocument;
  graph: ContextGraphDocument;
}

export interface ContextTarget {
  path: string;
  qualifiedName: string;
}

export interface CompileViewsOptions {
  revision?: string;
  mode?: "onboarding" | "task" | "review";
  /** Task mode: exact repository-relative path. */
  path?: string;
  /** Task mode: qualified symbol name. */
  qualifiedName?: string;
  maxItems?: number;
  maxSourceBytes?: number;
}

export interface SourceResponse {
  repositoryId: string;
  commitSha: string;
  filePath: string;
  startByte: number;
  endByte: number;
  source: string;
}

export async function compileViews(
  repoPath: string,
  options: CompileViewsOptions = {},
): Promise<ContextViews> {
  const raw = await call<{ viewsJson: string }>("compile_views", {
    repoPath,
    revision: options.revision?.trim() || "HEAD",
    mode: options.mode ?? "onboarding",
    path: options.path?.trim() || null,
    qualifiedName: options.qualifiedName?.trim() || null,
    maxItems: options.maxItems ?? null,
    maxSourceBytes: options.maxSourceBytes ?? null,
  });
  return JSON.parse(raw.viewsJson) as ContextViews;
}

export interface CompileMultiViewsOptions {
  revision?: string;
  mode?: "onboarding" | "task" | "review";
  targets?: ContextTarget[];
  maxItems?: number;
  maxSourceBytes?: number;
}

/** Compiles multiple task targets into one combined brief/graph. */
export async function compileMultiViews(
  repoPath: string,
  options: CompileMultiViewsOptions = {},
): Promise<ContextViews> {
  const raw = await call<{ viewsJson: string }>("compile_multi_views", {
    repoPath,
    revision: options.revision?.trim() || "HEAD",
    mode: options.mode ?? "task",
    targets: (options.targets ?? []).map((target) => ({
      path: target.path.trim(),
      qualifiedName: target.qualifiedName.trim(),
    })),
    maxItems: options.maxItems ?? null,
    maxSourceBytes: options.maxSourceBytes ?? null,
  });
  return JSON.parse(raw.viewsJson) as ContextViews;
}

/** Loads the pinned source range behind one evidence ID/location. */
export async function readSource(
  repoPath: string,
  filePath: string,
  startByte: number,
  endByte: number,
  revision = "HEAD",
): Promise<SourceResponse> {
  const raw = await call<{ sourceJson: string }>("read_source", {
    repoPath,
    revision: revision.trim() || "HEAD",
    filePath,
    startByte,
    endByte,
  });
  return JSON.parse(raw.sourceJson) as SourceResponse;
}

/* ---------- errors ---------- */

function isBackendError(error: unknown): error is BackendError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as BackendError).code === "number" &&
    typeof (error as BackendError).message === "string"
  );
}

/** Turns whatever a command rejected with into a readable message. */
export function errorMessage(error: unknown): string {
  if (isBackendError(error)) return `${error.message} (C status ${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}