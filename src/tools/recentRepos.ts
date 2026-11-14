// Recently opened repositories: the list behind the path field's dropdown. Pure
// list logic plus storage helpers that never throw, so a blocked or junk-filled
// localStorage just means an empty list.

export const RECENT_REPOS_KEY = "chronos.recentRepos";
export const MAX_RECENT_REPOS = 8;

export interface RecentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Trims spaces and trailing slashes, keeping a root like "/" or "C:\" whole. */
export function cleanRepoPath(path: string): string {
  let p = path.trim();
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** Two paths name the same repository when this matches: case, \ vs / and trailing slashes don't count. */
export function repoKey(path: string): string {
  return cleanRepoPath(path).replace(/\\/g, "/").toLowerCase();
}

export function sameRepo(a: string, b: string): boolean {
  return repoKey(a) === repoKey(b);
}

/** Puts `path` first, drops other spellings of it, and keeps at most `max` entries. */
export function addRecentRepo(list: readonly string[], path: string, max = MAX_RECENT_REPOS): string[] {
  const clean = cleanRepoPath(path);
  if (!clean) return list.slice(0, max);
  const key = repoKey(clean);
  return [clean, ...list.filter((p) => repoKey(p) !== key)].slice(0, max);
}

export function removeRecentRepo(list: readonly string[], path: string): string[] {
  const key = repoKey(path);
  return list.filter((p) => repoKey(p) !== key);
}

/** Reads a stored list, ignoring anything that is not a non-empty string and any duplicates. */
export function parseRecentRepos(raw: string | null | undefined, max = MAX_RECENT_REPOS): string[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (typeof item !== "string") continue;
    const clean = cleanRepoPath(item);
    const key = repoKey(clean);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

/** `storage` is a getter because merely touching window.localStorage can throw when it is blocked. */
export function loadRecentRepos(storage: () => RecentStorage | null | undefined): string[] {
  try {
    return parseRecentRepos(storage()?.getItem(RECENT_REPOS_KEY));
  } catch {
    return [];
  }
}

export function saveRecentRepos(storage: () => RecentStorage | null | undefined, list: readonly string[]): void {
  try {
    storage()?.setItem(RECENT_REPOS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: the list just isn't remembered */
  }
}

/** The folder name to show for a path: "C:\code\chronos\" -> "chronos". */
export function repoName(path: string): string {
  return cleanRepoPath(path).split(/[\\/]/).filter(Boolean).pop() || path;
}

/** A Windows path as git reports it ("C:/code/chronos") gets backslashes back; other paths are kept. */
export function nativeRepoPath(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\//g, "\\") : path;
}
