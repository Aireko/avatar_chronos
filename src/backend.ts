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

/* ---------- file / function scope ---------- */

export interface ScopedActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface FunctionVersions {
  before: string | null;
  after: string | null;
  beforeStart: number;
  afterStart: number;
}

export const listFiles = (repoPath: string) => call<string[]>("list_files", { repoPath });

export const functionVersions = (
  repoPath: string,
  revision: string,
  pathAtRevision: string,
  pathNow: string,
  functionName: string,
) => call<FunctionVersions>("function_versions", { repoPath, revision, pathAtRevision, pathNow, functionName });

export const rebaseFile = (repoPath: string, revision: string, pathAtRevision: string, pathNow: string) =>
  call<ScopedActionResult>("rebase_file", { repoPath, revision, pathAtRevision, pathNow });

export const rebaseFunction = (
  repoPath: string,
  revision: string,
  pathAtRevision: string,
  pathNow: string,
  functionName: string,
) => call<ScopedActionResult>("rebase_function", { repoPath, revision, pathAtRevision, pathNow, functionName });

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