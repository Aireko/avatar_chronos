// Checks the blame JSON from the C backend before the People panel renders it, so
// a partial or null answer shows an error message instead of crashing the panel.
import type { BlameCommit, BlameRange, BlameReport, BlameSymbol, SymbolKind } from "../backend";
import { isRecord, list, num, oneOf, optNum, str } from "../ai/coerce";

const KINDS: readonly SymbolKind[] = ["function", "method", "class"];

function normalizeCommit(value: unknown): BlameCommit | undefined {
  if (!isRecord(value) || typeof value.hash !== "string" || !value.hash) return undefined;
  return {
    hash: value.hash,
    author: str(value.author),
    email: str(value.email),
    time: num(value.time),
    summary: str(value.summary),
    lines: Math.max(0, num(value.lines)),
  };
}

function normalizeRange(value: unknown): BlameRange | undefined {
  if (!isRecord(value) || typeof value.commit !== "string") return undefined;
  const start = optNum(value.start);
  const end = optNum(value.end);
  if (start === undefined || end === undefined || end < start) return undefined;
  return { start, end, commit: value.commit };
}

function normalizeSymbol(value: unknown): BlameSymbol | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const startLine = optNum(value.startLine);
  const endLine = optNum(value.endLine);
  if (startLine === undefined || endLine === undefined || endLine < startLine) return undefined;
  return { name: value.name, kind: oneOf(value.kind, KINDS, "function"), startLine, endLine };
}

/** The blame report, or an Error (with a readable message) when it can't be used. */
export function normalizeBlameReport(value: unknown): BlameReport {
  if (!isRecord(value) || typeof value.path !== "string") {
    throw new Error("Git blame returned an unexpected answer. Try again, or pick another file.");
  }
  const authors = Array.isArray(value.authors) ? (value.authors as BlameReport["authors"]) : [];
  return {
    repoPath: str(value.repoPath),
    path: value.path,
    revision: str(value.revision),
    totalLines: Math.max(0, Math.round(num(value.totalLines))),
    authors,
    commits: list(value.commits, normalizeCommit),
    ranges: list(value.ranges, normalizeRange),
    symbols: list(value.symbols, normalizeSymbol),
  };
}
