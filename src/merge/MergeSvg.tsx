// The preview of a merge: two branches running out of their merge base and converging
// on a dashed "ghost" merge commit. Drawn inline here instead of in the commit graph:
// layout.ts assigns lanes from real commits only, and a made-up commit would have to be
// threaded through its lane, id and animation bookkeeping.
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface Props {
  source: string;
  target: string;
  mergeBase: string | null;
  sourceTip: string | null;
  targetTip: string | null;
  /** Colours the ghost commit: ok = no collisions, warn = collisions to resolve. */
  tone: "ok" | "warn" | "bad";
}

export function MergePreviewSvg({ source, target, mergeBase, sourceTip, targetTip, tone }: Props) {
  const hash = (h: string | null) => (h ? h.slice(0, 7) : "");
  return (
    <svg
      className="merge-svg"
      viewBox="0 0 480 160"
      role="img"
      aria-label={`${source} and ${target} converge on a new merge commit`}
    >
      <path className="merge-svg-line" d="M44 80 C84 80 92 40 132 40 L300 40" />
      <path className="merge-svg-line" d="M44 80 C84 80 92 120 132 120 L300 120" />
      <path className={`merge-svg-ghost ${tone}`} d="M300 40 C352 40 364 80 404 80" />
      <path className={`merge-svg-ghost ${tone}`} d="M300 120 C352 120 364 80 404 80" />

      <circle className="merge-svg-node" cx="44" cy="80" r="8" />
      <circle className="merge-svg-node" cx="300" cy="40" r="8" />
      <circle className="merge-svg-node" cx="300" cy="120" r="8" />
      <circle className={`merge-svg-ghost-node ${tone}`} cx="412" cy="80" r="10" />

      <text className="merge-svg-text" x="44" y="108" textAnchor="middle">
        base {hash(mergeBase)}
      </text>
      <text className="merge-svg-text" x="216" y="28" textAnchor="middle">
        {short(source, 24)} (theirs) {hash(sourceTip)}
      </text>
      <text className="merge-svg-text" x="216" y="146" textAnchor="middle">
        {short(target, 24)} (ours) {hash(targetTip)}
      </text>
      <text className="merge-svg-soft" x="412" y="56" textAnchor="middle">
        merge
      </text>
      <text className="merge-svg-soft" x="412" y="112" textAnchor="middle">
        (preview)
      </text>
    </svg>
  );
}