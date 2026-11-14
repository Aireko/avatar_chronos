// Base / ours / theirs side by side, with line numbers. Base is compared against each side:
// lines base lost are marked in the base pane, lines a side added are marked in its own pane.
import { useMemo } from "react";
import { buildDiffRows } from "../graph/diffRows";

interface Line {
  n: number;
  text: string;
  changed: boolean;
}

interface Props {
  base: string;
  ours: string;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
  /** File line the ours / theirs snippet starts on (1 when unknown). */
  oursStart: number;
  theirsStart: number;
  baseNote?: string;
  oursNote?: string;
  theirsNote?: string;
}

function Pane({ title, sub, note, lines, kind }: { title: string; sub: string; note?: string; lines: Line[]; kind: "del" | "add" }) {
  return (
    <section className="merge-pane" aria-label={`${title} ${sub}`.trim()}>
      <header className="merge-pane-head">
        <b>{title}</b>
        <span className="merge-soft" title={sub}>
          {sub}
        </span>
      </header>
      {note && <div className="merge-pane-note">{note}</div>}
      <ol className="merge-code">
        {lines.length === 0 ? (
          <li className="merge-empty">(empty)</li>
        ) : (
          lines.map((line, i) => (
            <li key={i} className={line.changed ? `merge-line ${kind}` : "merge-line"}>
              <span className="merge-ln" aria-hidden>
                {line.n}
              </span>
              <code>{line.text === "" ? " " : line.text}</code>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

export function ThreePane({ base, ours, theirs, oursLabel, theirsLabel, oursStart, theirsStart, baseNote, oursNote, theirsNote }: Props) {
  const panes = useMemo(() => {
    const vsOurs = buildDiffRows(base, ours);
    const vsTheirs = buildDiffRows(base, theirs);

    const lostInTheirs = new Set<number>();
    for (const row of vsTheirs) if (row.kind === "removed") lostInTheirs.add(row.oldLine);

    // Every base line is a context or removed row of either diff.
    const baseLines: Line[] = vsOurs
      .filter((r) => r.kind !== "added")
      .map((r) => ({ n: r.oldLine as number, text: r.text, changed: r.kind === "removed" || lostInTheirs.has(r.oldLine as number) }));

    const side = (rows: typeof vsOurs, start: number): Line[] =>
      rows
        .filter((r) => r.kind !== "removed")
        .map((r) => ({ n: start + (r.newLine as number) - 1, text: r.text, changed: r.kind === "added" }));

    return { baseLines, oursLines: side(vsOurs, oursStart), theirsLines: side(vsTheirs, theirsStart) };
  }, [base, ours, theirs, oursStart, theirsStart]);

  return (
    <div className="merge-panes">
      <Pane title="Base" sub="common ancestor" note={baseNote} lines={panes.baseLines} kind="del" />
      <Pane title="Ours" sub={oursLabel} note={oursNote} lines={panes.oursLines} kind="add" />
      <Pane title="Theirs" sub={theirsLabel} note={theirsNote} lines={panes.theirsLines} kind="add" />
    </div>
  );
}