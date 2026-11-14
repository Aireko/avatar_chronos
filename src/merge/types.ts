// Shared types for Merge Doctor. Pure data: no React, no Tauri.
import type { ChronosGraph, MergeAnalysis, MergeConflict } from "../backend";

export type Step = "setup" | "summary" | "resolver" | "apply" | "result";

export type Confidence = "high" | "medium" | "low";

/** What the local model answers with (see mergeAi.ts). */
export interface AiSuggestion {
  resolution: string;
  explanation: string;
  confidence: Confidence;
}

/** Who wrote the result text: the user (typing or a quick button), or the model, unchanged. */
export type Origin = "hand" | "ai";

/** The three whole-file versions behind a conflict that has no function snippets. */
export interface FileVersions {
  base: string;
  ours: string;
  theirs: string;
  missing: { base: boolean; ours: boolean; theirs: boolean };
  /** The backend cut one of them off, so a whole-file resolution would lose lines. */
  truncated: boolean;
}

/** Everything the user has done to one conflict. Kept for the whole session. */
export interface ConflictState {
  text: string;
  resolved: boolean;
  origin: Origin;
  suggestion: AiSuggestion | null;
  versions: FileVersions | null;
}

/** A TRUE_COLLISION from the analysis that the user has to resolve. */
export interface ConflictItem {
  id: string;
  conflict: MergeConflict;
  /** No symbol and no snippets: a delete/modify, binary or git-only conflict. Resolved as a whole file. */
  fileLevel: boolean;
}

export interface Preview {
  source: string;
  target: string;
  analysis: MergeAnalysis;
  items: ConflictItem[];
  sourceTip: string | null;
  targetTip: string | null;
  /** Same signature = same merge; the user's work is kept when they preview it again. */
  signature: string;
}

/** One resolved conflict, ready for mergeGit.applyMerge. */
export interface ResolvedEntry {
  id: string;
  label: string;
  filePath: string;
  fileLevel: boolean;
  /** Whole-file conflict where the user kept the side that deletes the file. */
  deleteFile: boolean;
  oursSnippet: string;
  theirsSnippet: string;
  text: string;
}

export interface SkippedNote {
  id: string;
  label: string;
  reason: string;
}

export type ApplyOutcome =
  | {
      kind: "committed";
      hash: string;
      graph: ChronosGraph | null;
      applied: string[];
      skipped: SkippedNote[];
      /** The merge commit's changes against the target branch's old tip (best effort, may be empty). */
      diff: string;
    }
  | { kind: "nothing"; message: string; graph: ChronosGraph | null }
  | { kind: "failed"; message: string; aborted: boolean; abortError: string | null; graph: ChronosGraph | null }
  | { kind: "cancelled"; aborted: boolean; abortError: string | null; graph: ChronosGraph | null };

export interface MergeResult {
  source: string;
  target: string;
  hash: string;
  byHand: number;
  byAi: number;
  /** CLEAN and AUTO_RESOLVABLE functions that git merged by itself. */
  autoMerged: number;
  skipped: SkippedNote[];
  graph: ChronosGraph | null;
  diff: string;
}

export interface RunState {
  phase: "idle" | "running" | "failed";
  log: string[];
  aborting: boolean;
  failure: { message: string; aborted: boolean; abortError: string | null } | null;
}