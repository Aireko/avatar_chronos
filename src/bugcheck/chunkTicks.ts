// The Bug Check progress track: one tick per diff chunk, so the reader sees how
// far the check got and which parts failed, not just a percentage.

/** How a finished chunk ended. */
export type ChunkOutcome = "done" | "failed";

/** What one tick of the track shows. */
export type TickState = ChunkOutcome | "active" | "waiting";

/** Past this many chunks the ticks get too thin to read; a plain bar is shown instead. */
export const MAX_TICKS = 48;

/**
 * The ticks for a run of `total` chunks, given the chunks that finished
 * (`settled`, by 0-based index) and the one being reviewed (`active`).
 * Returns undefined when the track should not be drawn: the chunk count is
 * not known yet, there is nothing to review, or there are too many chunks.
 */
export function chunkTicks(
  total: number | undefined,
  settled: Readonly<Record<number, ChunkOutcome>>,
  active?: number,
): TickState[] | undefined {
  if (total === undefined || !Number.isInteger(total) || total <= 0 || total > MAX_TICKS) return undefined;
  return Array.from({ length: total }, (_, index) => settled[index] ?? (index === active ? "active" : "waiting"));
}

/** Words for the track, for screen readers: "3 of 8 parts checked, 1 failed". */
export function ticksLabel(total: number, done: number, failed: number): string {
  const checked = `${done} of ${total} ${total === 1 ? "part" : "parts"} checked`;
  return failed > 0 ? `${checked}, ${failed} failed` : checked;
}
