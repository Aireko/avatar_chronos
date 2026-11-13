// Pure logic behind the Contributors panel: who wrote a part of a file
// (according to git blame), and the email draft used to contact them.
import type { BlameCommit, BlameReport } from "../backend";

export interface Contributor {
  name: string;
  email: string;
  /** Lines in the scope that this person last changed. */
  lines: number;
  /** Distinct commits of theirs that own lines in the scope. */
  commits: number;
  /** Their newest commit that owns a line in the scope. */
  latest: BlameCommit;
}

/** Same grouping rule as the C backend: email (case-insensitive), or name when an email is missing. */
function personKey(commit: BlameCommit): string {
  return commit.email ? `email:${commit.email.toLowerCase()}` : `name:${commit.author}`;
}

/** Contributors to lines `start..end` (1-based, inclusive), most lines first, then most recent. */
export function contributorsInRange(report: BlameReport, start: number, end: number): Contributor[] {
  const commits = new Map(report.commits.map((c) => [c.hash, c]));
  const linesByCommit = new Map<string, number>();
  for (const range of report.ranges) {
    const lo = Math.max(range.start, start);
    const hi = Math.min(range.end, end);
    if (lo > hi) continue;
    linesByCommit.set(range.commit, (linesByCommit.get(range.commit) ?? 0) + hi - lo + 1);
  }

  const people = new Map<string, Contributor>();
  for (const [hash, lines] of linesByCommit) {
    const commit = commits.get(hash);
    if (!commit) continue;
    const key = personKey(commit);
    const person = people.get(key);
    if (!person) {
      people.set(key, { name: commit.author, email: commit.email, lines, commits: 1, latest: commit });
      continue;
    }
    person.lines += lines;
    person.commits += 1;
    if (commit.time > person.latest.time) {
      person.latest = commit;
      person.name = commit.author;
      person.email = commit.email;
    }
  }

  // A commit without an email is the same person as an emailed group with the
  // same name (the C backend groups the same way), so don't list them twice.
  for (const [key, person] of [...people]) {
    if (!key.startsWith("name:")) continue;
    const target = [...people.entries()].find(([k, p]) => k.startsWith("email:") && p.name === person.name)?.[1];
    if (!target) continue;
    target.lines += person.lines;
    target.commits += person.commits;
    if (person.latest.time > target.latest.time) target.latest = person.latest;
    people.delete(key);
  }

  return [...people.values()].sort(
    (a, b) => b.lines - a.lines || b.latest.time - a.latest.time || a.name.localeCompare(b.name),
  );
}

/** Whether git recorded an address that mail can actually be sent to. */
export function isMailable(email: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && !/^not\.committed\.yet$/i.test(email);
}

/** No-reply addresses (noreply@..., do-not-reply@..., GitHub's users.noreply.github.com). */
export function isNoReply(email: string): boolean {
  return /^(no-?reply|do-?not-?reply)@/i.test(email) || /(^|[.@])(users\.)?noreply\./i.test(email);
}

/** Addresses that can never receive mail: GitHub's private commit emails. */
export function isUndeliverable(email: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(email);
}

/** Bot accounts such as dependabot[bot]. */
export function isBot(name: string, email: string): boolean {
  return /\[bot\]$/i.test(name) || /\[bot\]@/i.test(email);
}

export interface DraftContext {
  repoName: string;
  path: string;
  /** e.g. "kv_put" when the scope is a function, otherwise null. */
  feature: string | null;
  start: number;
  end: number;
  totalLines: number;
  /** What the sender wants to ask; may be empty. */
  question: string;
}

/** Some mail apps (notably on Windows) fail to open mailto: links much longer than ~2,000 characters. */
export const MAX_MAILTO_LENGTH = 1900;
/** Limit for the question box; the link is still shortened further if it would be too long. */
export const MAX_QUESTION_CHARS = 800;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function shortDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function draftSubject(ctx: DraftContext): string {
  const what = ctx.feature ? `${ctx.feature} in ${ctx.path}` : ctx.path;
  return `Question about ${what} (${ctx.repoName})`;
}

export function draftBody(person: Contributor, ctx: DraftContext): string {
  const whole = ctx.start === 1 && ctx.end >= ctx.totalLines;
  const scope = ctx.feature
    ? `${ctx.feature} in ${ctx.path} (lines ${ctx.start}-${ctx.end})`
    : whole
      ? ctx.path
      : `${ctx.path} (lines ${ctx.start}-${ctx.end})`;
  const share = `${person.lines} of ${ctx.end - ctx.start + 1} lines`;
  const latest = `${person.latest.hash.slice(0, 7)} "${person.latest.summary}" on ${shortDate(person.latest.time)}`;
  const question = ctx.question.trim();

  return [
    `Hi ${firstName(person.name)},`,
    "",
    `I'm looking at ${scope} in ${ctx.repoName}. Git blame shows you wrote ${share} there, most recently in ${latest}.`,
    "",
    question || "[Your question]",
    "",
    "Thanks!",
  ].join("\r\n");
}

export interface Draft {
  url: string;
  /** True when the question had to be cut to keep the link short enough. */
  shortened: boolean;
}

/** The email draft for a contributor, cutting the question (by whole characters) if the link would be too long. */
export function buildDraft(person: Contributor, ctx: DraftContext): Draft {
  const subject = draftSubject(ctx);
  let chars = Array.from(ctx.question.trim()); // code points, so an emoji is never split
  let shortened = false;
  for (;;) {
    const question = shortened ? `${chars.join("")} [...]` : chars.join("");
    const url = mailtoUrl(person.email, subject, draftBody(person, { ...ctx, question }));
    if (url.length <= MAX_MAILTO_LENGTH || chars.length === 0) return { url, shortened };
    // A character encodes to at most 12 URL characters; drop at least one per round.
    const excess = url.length - MAX_MAILTO_LENGTH;
    chars = chars.slice(0, Math.max(0, chars.length - Math.max(1, Math.ceil(excess / 12))));
    shortened = true;
  }
}

/** A mailto: URL with the subject and body pre-filled (RFC 6068). */
export function mailtoUrl(email: string, subject: string, body: string): string {
  const to = encodeURIComponent(email).replace(/%40/g, "@");
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The last path segment of a repository path, for the email subject. */
export function repoName(repoPath: string): string {
  const parts = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || repoPath;
}
