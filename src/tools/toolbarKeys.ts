// Small pure helpers for the toolbar: its keyboard shortcuts, the arrow-key walk
// through its pop-up lists, and the words on the branch key. Kept free of React and
// the DOM so they can be tested in node.

/** The parts of a keyboard event the shortcuts look at. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Ctrl+O or Ctrl+L (Cmd on a Mac): open the repository picker. Like the address bar of
 * a browser, Ctrl+L jumps to the path; Ctrl+O is the usual "open".
 */
export function isRepoShortcut(e: KeyLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  const k = e.key.toLowerCase();
  return k === "o" || k === "l";
}

/**
 * Where an arrow key moves focus in a pop-up list of `count` items when it is on
 * `current` (-1: nowhere in the list yet). Up and Down wrap round; Home and End jump to
 * the ends. Null: the key doesn't move anything.
 */
export function rovingIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** What the branch key says: the branch, "(detached)" without one, or what it is doing. */
export function branchKeyLabel(current: string | null, busy: "switch" | "create" | null): string {
  if (busy === "switch") return "Switching…";
  if (busy === "create") return "Creating…";
  return current ?? "(detached)";
}

/** The branch names with the current one first, so the menu opens on it. */
export function branchMenuOrder(names: readonly string[], current: string | null): string[] {
  if (!current || !names.includes(current)) return [...names];
  return [current, ...names.filter((n) => n !== current)];
}

/** Git's rules for a branch name, as far as the switcher can check before running git. */
export function branchNameProblem(raw: string, existing: readonly string[]): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return "Letters, digits, . _ / and - only";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.includes(".."))
    return "That isn't a valid branch name";
  if (name.endsWith(".lock") || name.includes("//")) return "That isn't a valid branch name";
  if (existing.includes(name)) return "There is already a branch called that";
  return null;
}
