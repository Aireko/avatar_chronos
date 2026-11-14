// Pure logic for Merge Doctor: no React, no Tauri, no git. Everything here is
// covered by resolution.test.ts.
import type { MergeConflict } from "../backend";
import { buildDiffRows, type DiffRow } from "../graph/diffRows";
import type { ConflictItem, ConflictState, FileVersions } from "./types";

/* ---------- names, ids, counts ---------- */

/** What a conflict looks like before the user has touched it. */
export const EMPTY_STATE: ConflictState = { text: "", resolved: false, origin: "hand", suggestion: null, versions: null };

const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * The pattern the app uses everywhere, plus what makes a name unsafe to put on a git
 * command line: a leading "-" would be read as an option, ".." is a range.
 */
export function isValidBranchName(name: string): boolean {
  return BRANCH_NAME.test(name) && !name.startsWith("-") && !name.includes("..");
}

export function isFileLevel(c: MergeConflict): boolean {
  return c.symbolName === null && !c.baseSnippet.trim() && !c.oursSnippet.trim() && !c.theirsSnippet.trim();
}

/** What a conflict is called in the UI. */
export function conflictLabel(c: MergeConflict): string {
  if (c.symbolName) return c.symbolName;
  return isFileLevel(c) ? "whole file" : "file region";
}

/** Stable for one analysis: position + file + symbol. */
export function conflictId(c: MergeConflict, index: number): string {
  return `${index}:${c.filePath}:${c.symbolName ?? ""}`;
}

/** The conflicts the user has to resolve: every TRUE_COLLISION, in analysis order. */
export function collisionItems(conflicts: readonly MergeConflict[]): ConflictItem[] {
  const items: ConflictItem[] = [];
  conflicts.forEach((conflict, index) => {
    if (conflict.resolutionStatus === "TRUE_COLLISION") {
      items.push({ id: conflictId(conflict, index), conflict, fileLevel: isFileLevel(conflict) });
    }
  });
  return items;
}

export interface StatusCounts {
  clean: number;
  auto: number;
  collision: number;
}

export function countStatuses(conflicts: readonly MergeConflict[]): StatusCounts {
  const counts: StatusCounts = { clean: 0, auto: 0, collision: 0 };
  for (const c of conflicts) {
    if (c.resolutionStatus === "CLEAN") counts.clean++;
    else if (c.resolutionStatus === "AUTO_RESOLVABLE") counts.auto++;
    else counts.collision++;
  }
  return counts;
}

export interface FileGroup {
  filePath: string;
  conflicts: MergeConflict[];
}

/** Groups by file, files in alphabetical order, conflicts in analysis order. */
export function groupByFile(conflicts: readonly MergeConflict[]): FileGroup[] {
  const groups = new Map<string, MergeConflict[]>();
  for (const c of conflicts) {
    const list = groups.get(c.filePath);
    if (list) list.push(c);
    else groups.set(c.filePath, [c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([filePath, list]) => ({ filePath, conflicts: list }));
}

/** The base / ours / theirs text to show and to act on: the snippets, or whole files for file-level conflicts. */
export function panesOf(
  item: ConflictItem,
  versions: FileVersions | null,
): { base: string; ours: string; theirs: string } | null {
  if (!item.fileLevel) {
    const c = item.conflict;
    return { base: c.baseSnippet, ours: c.oursSnippet, theirs: c.theirsSnippet };
  }
  return versions ? { base: versions.base, ours: versions.ours, theirs: versions.theirs } : null;
}

/**
 * Paths from `git diff --name-only` come back quoted ("caf\303\251.c") when they hold
 * special characters. Undoes that quoting; an unquoted path is returned as it is.
 */
export function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  const chars = Array.from(s.slice(1, -1));
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch !== "\\" || i + 1 >= chars.length) {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = chars[i + 1];
    if (/[0-7]/.test(next)) {
      let digits = next;
      while (digits.length < 3 && i + 1 + digits.length < chars.length && /[0-7]/.test(chars[i + 1 + digits.length])) {
        digits += chars[i + 1 + digits.length];
      }
      bytes.push(parseInt(digits, 8) & 0xff);
      i += digits.length;
    } else if (next in simple) {
      bytes.push(simple[next]);
      i += 1;
    } else {
      bytes.push(...encoder.encode(next));
      i += 1;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/* ---------- conflict markers ---------- */

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

export interface MarkerRegion {
  /** 0-based index of the "<<<<<<<" line. */
  start: number;
  /** 0-based index of the ">>>>>>>" line. */
  end: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  /** Only with merge.conflictStyle = diff3 / zdiff3. */
  base: string[] | null;
  theirs: string[];
}

export interface ParsedMarkers {
  lines: string[];
  eol: "\n" | "\r\n";
  regions: MarkerRegion[];
}

const OPEN = /^<{7}(?: (.*))?$/;
const BASE_MARK = /^\|{7}(?: .*)?$/;
const MIDDLE = /^={7}$/;
const CLOSE = /^>{7}(?: (.*))?$/;

/**
 * Finds the conflict regions git wrote into a file. Handles the default and
 * diff3 styles and both line endings. Throws a ResolutionError for a region
 * that never closes or that nests, so a damaged file is never half-edited.
 */
export function parseConflictMarkers(text: string): ParsedMarkers {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const regions: MarkerRegion[] = [];

  let i = 0;
  while (i < lines.length) {
    const open = OPEN.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const region: MarkerRegion = {
      start: i,
      end: -1,
      oursLabel: open[1] ?? "",
      theirsLabel: "",
      ours: [],
      base: null,
      theirs: [],
    };
    let part: "ours" | "base" | "theirs" = "ours";
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (OPEN.test(line)) throw new ResolutionError(`A conflict marker is nested inside another at line ${j + 1}.`);
      if (part === "ours" && BASE_MARK.test(line)) {
        part = "base";
        region.base = [];
        continue;
      }
      if (part !== "theirs" && MIDDLE.test(line)) {
        part = "theirs";
        continue;
      }
      const close = CLOSE.exec(line);
      if (part === "theirs" && close) {
        region.end = j;
        region.theirsLabel = close[1] ?? "";
        break;
      }
      if (part === "ours") region.ours.push(line);
      else if (part === "base") region.base?.push(line);
      else region.theirs.push(line);
    }
    if (region.end < 0) {
      throw new ResolutionError(`The conflict that starts at line ${i + 1} never closes with ">>>>>>>".`);
    }
    regions.push(region);
    i = region.end + 1;
  }
  return { lines, eol, regions };
}

/* ---------- classifying and matching ---------- */

export type ResolutionKind = "ours" | "theirs" | "both" | "custom";

function blockLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const normBlock = (text: string) => blockLines(text).join("\n");

/**
 * Is the result exactly one of the quick actions (Take ours / theirs / both)?
 * Those are applied per git region (the side git wrote for that region), which is
 * exact even when git's region and the backend's snippet differ in extent.
 * Anything else is "custom" and replaces the whole region as typed.
 */
export function classifyResolution(text: string, oursSnippet: string, theirsSnippet: string): ResolutionKind {
  const t = normBlock(text);
  const o = normBlock(oursSnippet);
  const th = normBlock(theirsSnippet);
  if (t === o) return "ours";
  if (t === th) return "theirs";
  if (o !== "" && th !== "" && t === `${o}\n${th}`) return "both";
  return "custom";
}

/** Braces, parentheses and blank lines appear everywhere; they say nothing about which function a region is. */
const TRIVIAL = /^[\s{}();,]*$/;

function significant(lines: readonly string[]): string[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => !TRIVIAL.test(l) && !l.startsWith("[... snippet truncated"));
}

function overlap(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1);
  let shared = 0;
  for (const line of a) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      shared++;
      counts.set(line, left - 1);
    }
  }
  return shared;
}

/**
 * How well one side of a git region fits one snippet: -1 when they disagree, 0 when
 * one of them has nothing to compare, otherwise the number of shared lines. They fit
 * when the smaller of the two is contained in the larger: the snippet covers only the
 * changed lines, while git's region can be larger (a deleted function) or smaller
 * (common lines trimmed off).
 */
function sideScore(region: readonly string[], snippet: string): number {
  const r = significant(region);
  const s = significant(snippet.split(/\r?\n/));
  const smaller = Math.min(r.length, s.length);
  if (smaller === 0) return 0;
  const shared = overlap(r, s);
  return shared === smaller ? shared : -1;
}

export interface RegionEntry {
  id: string;
  label: string;
  oursSnippet: string;
  theirsSnippet: string;
  /** The user's result. */
  text: string;
}

function matchScore(region: MarkerRegion, entry: RegionEntry): number {
  const o = sideScore(region.ours, entry.oursSnippet);
  const t = sideScore(region.theirs, entry.theirsSnippet);
  return o < 0 || t < 0 ? -1 : o + t;
}

function firstText(region: MarkerRegion): string {
  const line = [...region.ours, ...region.theirs].find((l) => l.trim() !== "") ?? "";
  const t = line.trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/** A result's lines: one trailing newline is not a blank line, and an empty result is no lines at all. */
function textLines(text: string): string[] {
  const t = text.replace(/\r\n/g, "\n");
  if (t === "") return [];
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
}

export interface SkippedEntry {
  id: string;
  label: string;
  reason: string;
}

export interface ApplyReport {
  text: string;
  applied: string[];
  skipped: SkippedEntry[];
}

/**
 * Puts the user's results into a file that git left with conflict markers.
 *
 * Every marker region must belong to exactly one resolved function; if one can't be
 * matched, or matches several equally well, this throws and changes nothing. A function
 * with no region in the file (git merged it cleanly, or the file has no markers at all)
 * is reported as skipped instead of being forced in.
 */
export function applyResolutions(fileText: string, entries: readonly RegionEntry[], fileLabel = "this file"): ApplyReport {
  const { lines, eol, regions } = parseConflictMarkers(fileText);

  if (regions.length === 0) {
    return {
      text: fileText,
      applied: [],
      skipped: entries.map((e) => ({ id: e.id, label: e.label, reason: `${fileLabel} has no conflict markers` })),
    };
  }

  const kinds = entries.map((e) => classifyResolution(e.text, e.oursSnippet, e.theirsSnippet));
  const shared = new Set<number>();

  // Which resolved function does each region belong to?
  const owner: number[] = [];
  regions.forEach((region) => {
    const scored = entries
      .map((entry, index) => ({ index, score: matchScore(region, entry) }))
      .filter((s) => s.score >= 1);
    const where = `lines ${region.start + 1}-${region.end + 1} of ${fileLabel}`;
    if (scored.length === 0) {
      throw new ResolutionError(
        `The conflict at ${where} ("${firstText(region)}") doesn't match any function you resolved, so nothing was guessed.`,
      );
    }
    const best = Math.max(...scored.map((s) => s.score));
    const top = scored.filter((s) => s.score === best);
    if (top.length > 1) {
      const first = kinds[top[0].index];
      const agree = first !== "custom" && top.every((s) => kinds[s.index] === first);
      if (!agree) {
        const names = top.map((s) => entries[s.index].label).join(", ");
        throw new ResolutionError(
          `The conflict at ${where} ("${firstText(region)}") fits several functions equally well (${names}). Resolve them all with the same quick action (Take ours / theirs / both), or resolve them in the Terminal.`,
        );
      }
      top.slice(1).forEach((s) => shared.add(s.index));
    }
    owner.push(top[0].index);
  });

  const regionsOf: number[][] = entries.map(() => []);
  owner.forEach((entryIndex, regionIndex) => regionsOf[entryIndex].push(regionIndex));

  // A function that owns several regions is replaced from its first to its last one,
  // so no other function's region may sit in between.
  regionsOf.forEach((list, entryIndex) => {
    for (let r = list[0]; list.length > 1 && r <= list[list.length - 1]; r++) {
      if (owner[r] !== entryIndex) {
        throw new ResolutionError(
          `The conflicts of ${entries[entryIndex].label} in ${fileLabel} are interleaved with another function's conflict, so nothing was guessed.`,
        );
      }
    }
  });

  const out: string[] = [];
  let cursor = 0;
  let r = 0;
  while (r < regions.length) {
    const region = regions[r];
    const entryIndex = owner[r];
    while (cursor < region.start) out.push(lines[cursor++]);

    const kind = kinds[entryIndex];
    if (kind === "custom") {
      const last = regionsOf[entryIndex][regionsOf[entryIndex].length - 1];
      out.push(...textLines(entries[entryIndex].text));
      cursor = regions[last].end + 1;
      r = last + 1;
    } else {
      if (kind !== "theirs") out.push(...region.ours);
      if (kind !== "ours") out.push(...region.theirs);
      cursor = region.end + 1;
      r++;
    }
  }
  while (cursor < lines.length) out.push(lines[cursor++]);

  const applied: string[] = [];
  const skipped: SkippedEntry[] = [];
  entries.forEach((entry, index) => {
    if (regionsOf[index].length > 0 || shared.has(index)) applied.push(entry.id);
    else skipped.push({ id: entry.id, label: entry.label, reason: `git merged it without a conflict in ${fileLabel}` });
  });

  return { text: out.join(eol), applied, skipped };
}

/* ---------- short diffs for the final review ---------- */

export type ShortDiffRow = DiffRow | { kind: "gap"; hidden: number };

/** A diff with only the changed lines and a little context; unchanged stretches become one "gap" row. */
export function shortDiff(before: string, after: string, context = 2): ShortDiffRow[] {
  const rows = buildDiffRows(before, after);
  const keep = rows.map(() => false);
  rows.forEach((row, i) => {
    if (row.kind === "context") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });

  const out: ShortDiffRow[] = [];
  let hidden = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (hidden > 0) out.push({ kind: "gap", hidden });
      hidden = 0;
      out.push(row);
    } else {
      hidden++;
    }
  });
  if (hidden > 0) out.push({ kind: "gap", hidden });
  return out;
}

/** Quotes a value for run_git_command: backslashes become "/" and quotes are escaped. */
export function quoteGitArg(value: string): string {
  return `"${value.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}