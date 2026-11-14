// Which GitHub repository a local clone belongs to, read from its `origin` remote URL,
// so PR reviews open on the repository that is open in Chronos rather than a fixed one.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `git@github.com:owner/name.git`, `github.com:owner/name` (scp-like syntax). */
const SCP_LIKE = /^(?:[^@\s/]+@)?(?:www\.)?github\.com:\/?(.+)$/i;
/** `https://github.com/owner/name`, `ssh://git@github.com:22/owner/name.git`, `git://...`. */
const URL_LIKE = /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?\/(.+)$/i;

/**
 * The `owner/name` of a github.com repository from a git remote URL (as printed by
 * `git remote get-url origin`), or undefined for any other host or shape.
 */
export function githubRepoFromRemote(remote: string): string | undefined {
  const url = remote.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const path = SCP_LIKE.exec(url)?.[1] ?? URL_LIKE.exec(url)?.[1];
  if (!path) return undefined;
  const parts = path
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts;
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return undefined;
  return `${owner}/${name}`;
}
