// Small, pure helpers for reading JSON that came back from the backend. A command
// that fails half-way can answer with null, a partial object or a field of the
// wrong type; these turn such values into safe defaults so the panels render an
// error box (or a plain fallback) instead of throwing while rendering.
//
// Shared by the tool panels: src/ai, src/bugcheck and src/blame.

export type Rec = Record<string, unknown>;

/** A plain object (not null, not an array). */
export function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A finite number, or `fallback` (NaN, Infinity, null and strings are not numbers here). */
export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Only a real `true` is true. */
export function bool(value: unknown): boolean {
  return value === true;
}

/** The items of an array that `item` accepts (it returns undefined to drop one); [] for a non-array. */
export function list<T>(value: unknown, item: (entry: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const next = item(entry);
    if (next !== undefined) out.push(next);
  }
  return out;
}

/** List items that are strings. */
export const strings = (value: unknown): string[] => list(value, optStr);

/** List items that are finite numbers. */
export const numbers = (value: unknown): number[] => list(value, optNum);

/** One of `allowed`, or `fallback`. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
