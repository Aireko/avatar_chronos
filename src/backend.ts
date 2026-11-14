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

export interface ShellCommandResult {
  ok: boolean;
  exitCode: number;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
}

export interface RepoFile {
  path: string;
  content: string;
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

export const listRepoFiles = (repoPath: string) => call<string[]>("list_repo_files", { repoPath });

export const readRepoFile = (repoPath: string, relativePath: string) =>
  call<RepoFile>("read_repo_file", { repoPath, relativePath });

export const writeRepoFile = (repoPath: string, relativePath: string, content: string) =>
  call<void>("write_repo_file", { repoPath, relativePath, content });

/** Runs an arbitrary shell command with cwd set to the open repository. */
export const runShellCommand = (cwd: string, command: string) =>
  call<ShellCommandResult>("run_shell_command", { cwd, command });

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
  flows?: ContextFlowView[];
  bridges?: ContextBridgeView[];
}

export interface ContextFlowNodeView {
  symbol: { revision: ContextRevision; id: string };
  name: string;
  hop: number;
  relevance: number;
  fanIn: number;
  isSeed: boolean;
  viaIncoming: boolean;
  crossedModule: boolean;
}

export interface ContextFlowEdgeView {
  evidenceId: string;
  from: number;
  to: number;
  forward: boolean;
}

export interface ContextFlowView {
  id: string;
  seed: { revision: ContextRevision; id: string };
  relevance: number;
  nodes: ContextFlowNodeView[];
  edges: ContextFlowEdgeView[];
}

export interface ContextBridgeView {
  kind: "invoke" | "registration" | "dispatch" | "ffi";
  label: string;
  from: { revision: ContextRevision; id: string } | null;
  to: { revision: ContextRevision; id: string } | null;
  evidenceId: string;
  evidence: ContextLocation;
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

export type ContextPageKind = "root" | "module" | "file" | "symbol";

/** Page locations omit the revision; the page envelope is already pinned. */
export interface ContextPageLocation {
  filePath: string;
  range: ContextRange;
}

export interface ContextPageEvidence {
  id: string;
  kind: ContextEvidenceKind;
  state: ContextRelationState;
  location: ContextPageLocation | null;
}

export interface ContextPageNode {
  id: string;
  kind: ContextScopeKind;
  parentId: string | null;
  label: string;
  symbol: { id: string } | null;
  coverage: ContextCoverage;
  state: ContextRelationState;
  childCount: number;
  edgeCount: number;
}

export interface ContextPageEdge {
  id: string;
  from: string;
  to: string | null;
  kind: ContextEvidenceKind | "bridge" | "flow";
  state: ContextRelationState;
  evidenceId: string;
  /** Syntactic callee name; full call records stay in the full-graph API. */
  calleeText: string | null;
}

export interface ContextPageCollection<T> {
  status: ContextCoverage;
  items: T[] | null;
  total: number;
  nextOffset: number;
}

export interface ContextPageDocument {
  schemaVersion: number;
  page: {
    kind: ContextPageKind;
    parentScope: string | null;
    nodeOffset: number;
    edgeOffset: number;
    evidenceOffset: number;
    limits: { maxNodes: number; maxEdges: number; maxEvidence: number };
  };
  repositoryId: string;
  revision: ContextRevision;
  nodes: ContextPageCollection<ContextPageNode>;
  edges: ContextPageCollection<ContextPageEdge>;
  evidence: ContextPageCollection<ContextPageEvidence>;
  counts: { children: number; edges: number };
  diagnostics: unknown[];
}

export interface ContextSourceDocument {
  status: "present" | "absent" | "unavailable";
  location: ContextLocation | null;
  source: string | null;
}

export interface OpenViewsOptions extends CompileViewsOptions {
  targets?: ContextTarget[];
}

export interface SessionLoad {
  sessionId: number;
  brief: ContextBriefDocument;
}

export interface LoadViewsPageOptions {
  kind: ContextPageKind;
  parentScope?: string | null;
  nodeOffset?: number;
  edgeOffset?: number;
  evidenceOffset?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxEvidence?: number;
}

export async function openViews(
  repoPath: string,
  options: OpenViewsOptions = {},
): Promise<SessionLoad> {
  const raw = await call<{ sessionId: number; briefJson: string }>("open_views", {
    repoPath,
    revision: options.revision?.trim() || "HEAD",
    mode: options.mode ?? "onboarding",
    targets: (options.targets ?? []).map((target) => ({
      path: target.path.trim(),
      qualifiedName: target.qualifiedName.trim(),
    })),
    maxItems: options.maxItems ?? null,
    maxSourceBytes: options.maxSourceBytes ?? null,
  });
  return { sessionId: raw.sessionId, brief: JSON.parse(raw.briefJson) as ContextBriefDocument };
}

export async function loadViewsPage(
  sessionId: number,
  options: LoadViewsPageOptions,
): Promise<ContextPageDocument> {
  const raw = await call<{ pageJson: string }>("views_page", {
    sessionId,
    kind: options.kind,
    parentScope: options.parentScope ?? null,
    nodeOffset: options.nodeOffset ?? 0,
    edgeOffset: options.edgeOffset ?? 0,
    evidenceOffset: options.evidenceOffset ?? 0,
    maxNodes: options.maxNodes ?? null,
    maxEdges: options.maxEdges ?? null,
    maxEvidence: options.maxEvidence ?? null,
  });
  return JSON.parse(raw.pageJson) as ContextPageDocument;
}

export async function readSessionSource(
  sessionId: number,
  evidenceId: string,
): Promise<ContextSourceDocument> {
  const raw = await call<{ sourceJson: string }>("views_source", {
    sessionId,
    evidenceId,
  });
  return JSON.parse(raw.sourceJson) as ContextSourceDocument;
}

export async function closeViews(sessionId: number): Promise<void> {
  await call<void>("close_views", { sessionId });
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

/* ---------- call tree (chronos_call_tree in backend/include/avatar.h) ---------- */

export type CallTreeSide = "root" | "caller" | "callee";
export type CallTreeEdgeState = "resolved" | "ambiguous" | "unresolved";

export interface CallTreeSymbol {
  symbol: { revision: ContextRevision; id: string };
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  filePath: string;
  /** One-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Zero-based, end-exclusive, in the original UTF-8 source (see `readSource`). */
  startByte: number;
  endByte: number;
}

export interface CallTreeNode extends CallTreeSymbol {
  id: string;
  side: CallTreeSide;
  /** The root is zero. */
  depth: number;
  /** The node this one was reached from; null for the root. */
  parent: string | null;
  /** Neighbors exist that the depth or node limit left out. */
  hasMore: boolean;
}

/** Runs from caller (`from`) to callee (`to`). `to` is null for unresolved and ambiguous calls. */
export interface CallTreeEdge {
  id: string;
  from: string;
  to: string | null;
  side: CallTreeSide;
  state: CallTreeEdgeState;
  calleeText: string;
  /** Calls folded into this edge; `callSites` holds at most the first eight. */
  callCount: number;
  callSites: ContextLocation[];
  candidateCount: number;
  candidates: CallTreeSymbol[];
}

export interface CallTreeOk {
  schemaVersion: number;
  status: "ok";
  revision: ContextRevision;
  maxDepth: number;
  maxNodes: number;
  truncated: boolean;
  coverage: "complete" | "incomplete";
  root: string;
  nodes: CallTreeNode[];
  edges: CallTreeEdge[];
}

/** The name matched several definitions in the file, or none. */
export interface CallTreeUnresolved {
  schemaVersion: number;
  status: "ambiguous" | "not_found";
  revision: ContextRevision;
  candidates: CallTreeSymbol[];
}

export type CallTree = CallTreeOk | CallTreeUnresolved;

export interface CallTreeOptions {
  /** Defaults to HEAD. */
  revision?: string;
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * The callers and callees of a function in one commit. `name` may be a short name or a
 * qualified one (`Class::method`); `path` is repository-relative.
 */
export async function callTree(
  repoPath: string,
  path: string,
  name: string,
  options: CallTreeOptions = {},
): Promise<CallTree> {
  const raw = await call<{ treeJson: string }>("call_tree", {
    repoPath,
    revision: options.revision?.trim() || "HEAD",
    path,
    name,
    maxDepth: options.maxDepth ?? null,
    maxNodes: options.maxNodes ?? null,
  });
  return JSON.parse(raw.treeJson) as CallTree;
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