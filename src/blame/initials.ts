// The letters in a contributor's initial bubble.

/**
 * Words of letters or digits, e.g. "Ada", "Lovelace" from "Ada Lovelace (work)".
 * Combining marks stay in their word, so "अमित" or a decomposed "Émile" is one word.
 */
function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
}

/**
 * The first character of a word with any marks on it, kept whole even outside
 * the Basic Multilingual Plane.
 */
function firstChar(word: string): string {
  return word.match(/^[^\p{M}]\p{M}*/u)?.[0] ?? "";
}

/**
 * One or two initials for a person: first and last word of the name ("Ada
 * Lovelace" -> "AL"), else the first letter of the email's local part, else "?".
 */
export function initials(name: string, email: string): string {
  const parts = words(name);
  if (parts.length > 0) {
    const first = firstChar(parts[0]);
    const last = parts.length > 1 ? firstChar(parts[parts.length - 1]) : "";
    return (first + last).toLocaleUpperCase();
  }
  const local = words(email.split("@")[0] ?? "");
  return local.length > 0 ? firstChar(local[0]).toLocaleUpperCase() : "?";
}
