// Find a commit: the matcher behind the find bar (Ctrl+F). Pure, so it is tested
// without a DOM.
//
// A query is a list of terms, all of which must match (case-insensitive):
//   - a plain word matches the commit message, the author, or a hash prefix;
//   - "author:name" (or author:"Jane Doe", or "author: jane") matches the author only;
//   - "two words" in quotes is matched as one phrase.
import type { Commit } from "../backend";

export interface FindQuery {
  /** Lower-cased author fragments; each must appear in the author's name. */
  authors: string[];
  /** Lower-cased words or phrases; each must appear in the message or author, or start the hash. */
  words: string[];
}

const AUTHOR = "author:";

/** Splits a query into author filters and plain words. */
export function parseFindQuery(text: string): FindQuery {
  const authors: string[] = [];
  const words: string[] = [];
  // `author:"a b"` or `"a b"` (closing quote optional while typing), else any run of non-space.
  const term = /(author:)?"([^"]*)"?|(\S+)/gi;
  let authorNext = false;
  for (const m of text.matchAll(term)) {
    const phrase = m[2];
    let value: string;
    let isAuthor: boolean;
    if (phrase !== undefined) {
      value = phrase;
      isAuthor = Boolean(m[1]) || authorNext;
    } else {
      const word = m[3];
      if (word.toLowerCase().startsWith(AUTHOR)) {
        value = word.slice(AUTHOR.length);
        isAuthor = true;
        // "author:" on its own applies to the next term: "author: jane".
        if (!value) {
          authorNext = true;
          continue;
        }
      } else {
        value = word;
        isAuthor = authorNext;
      }
    }
    authorNext = false;
    const clean = value.trim().toLowerCase();
    if (!clean) continue;
    (isAuthor ? authors : words).push(clean);
  }
  return { authors, words };
}

export function isEmptyQuery(query: FindQuery): boolean {
  return query.authors.length === 0 && query.words.length === 0;
}

/** Does one commit match every term? An empty query matches nothing. */
export function matchCommit(commit: Commit, query: FindQuery): boolean {
  if (isEmptyQuery(query)) return false;
  const author = commit.author.toLowerCase();
  if (!query.authors.every((a) => author.includes(a))) return false;
  const message = commit.message.toLowerCase();
  const hash = commit.hash.toLowerCase();
  return query.words.every((w) => message.includes(w) || author.includes(w) || hash.startsWith(w));
}

/** The hashes of every matching commit, in the order given (the graph's newest-first order). */
export function findMatches(commits: readonly Commit[], text: string): string[] {
  const query = parseFindQuery(text);
  if (isEmptyQuery(query)) return [];
  const out: string[] = [];
  for (const c of commits) if (matchCommit(c, query)) out.push(c.hash);
  return out;
}

/**
 * The match to go to from `current` (-1: not on a match) in direction `dir`,
 * wrapping around at both ends. -1 when there are no matches.
 */
export function stepMatch(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** "3 of 12", "12 matches", "No matches", or "" for an empty query. */
export function matchSummary(current: number, count: number, hasQuery: boolean): string {
  if (!hasQuery) return "";
  if (count === 0) return "No matches";
  if (current < 0) return count === 1 ? "1 match" : `${count} matches`;
  return `${current + 1} of ${count}`;
}

/**
 * The commit to jump to when the matches change while typing: the first match,
 * unless the selected commit is still one of them. null: stay where you are.
 */
export function findJumpTarget(matches: readonly string[], selected: string | null): string | null {
  if (matches.length === 0) return null;
  if (selected !== null && matches.includes(selected)) return null;
  return matches[0];
}
