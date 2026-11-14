// Turns the commit message typed in the Push dialog into a starting title and description
// for the pull request. Pure text, so it is unit-tested without Tauri.

const MAX_TITLE = 120;

/** First line of the message; with no message, the branch name read as words. */
export function titleFromMessage(message: string, head: string): string {
  const first = message.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (first) return first.slice(0, MAX_TITLE);
  const fromBranch = head.replace(/^.*\//, "").replace(/[-_]+/g, " ").trim();
  return fromBranch || head;
}

/** Everything after the first line of the message. */
export function bodyFromMessage(message: string): string {
  return message.trim().split(/\r?\n/).slice(1).join("\n").trim();
}