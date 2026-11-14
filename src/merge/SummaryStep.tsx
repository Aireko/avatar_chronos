import type { ResolutionStatus } from "../backend";
import { MergePreviewSvg } from "./MergeSvg";
import { conflictLabel, countStatuses, groupByFile } from "./resolution";
import type { Preview } from "./types";

interface Props {
  preview: Preview;
  onBack: () => void;
  /** Opens the resolver, optionally on one conflict. */
  onResolve: (itemId?: string) => void;
  /** No collisions: go straight to the commit step. */
  onMergeNow: () => void;
}

const STATUS_TEXT: Record<ResolutionStatus, string> = {
  CLEAN: "Clean",
  AUTO_RESOLVABLE: "Auto-resolvable",
  TRUE_COLLISION: "True collision",
};
const STATUS_TONE: Record<ResolutionStatus, "ok" | "warn" | "bad"> = {
  CLEAN: "ok",
  AUTO_RESOLVABLE: "warn",
  TRUE_COLLISION: "bad",
};

export function SummaryStep({ preview, onBack, onResolve, onMergeNow }: Props) {
  const { analysis, source, target, items } = preview;

  if (!analysis.active) {
    return (
      <div className="merge-body">
        <div className="merge-note warn">
          The backend returned no merge analysis for {source} into {target}, so there is nothing to preview.
        </div>
        <div className="merge-actions">
          <button type="button" className="btn" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const counts = countStatuses(analysis.conflicts);
  const groups = groupByFile(analysis.conflicts);
  const nothing = analysis.conflicts.length === 0;
  const tone = counts.collision > 0 ? "bad" : counts.auto > 0 ? "warn" : "ok";

  return (
    <div className="merge-body">
      <div className="merge-summary-top">
        <MergePreviewSvg
          source={source}
          target={target}
          mergeBase={analysis.mergeBase}
          sourceTip={preview.sourceTip}
          targetTip={preview.targetTip}
          tone={tone}
        />
        <dl className="merge-facts">
          <div>
            <dt>Merging</dt>
            <dd>
              <code>{source}</code> into <code>{target}</code>
            </dd>
          </div>
          <div>
            <dt>Merge base</dt>
            <dd title={analysis.mergeBase ?? undefined}>
              <code>{analysis.mergeBase ? analysis.mergeBase.slice(0, 10) : "none"}</code>
            </dd>
          </div>
          <div>
            <dt>Can auto-merge</dt>
            <dd>
              <span className={`merge-badge ${analysis.canAutoMerge ? "ok" : "bad"}`}>
                {analysis.canAutoMerge ? "Yes" : "No"}
              </span>
            </dd>
          </div>
        </dl>
      </div>

      <ul className="merge-counts" aria-label="Results by status">
        <li className="merge-count ok">
          <b>{counts.clean}</b> clean
        </li>
        <li className="merge-count warn">
          <b>{counts.auto}</b> auto-resolvable
        </li>
        <li className="merge-count bad">
          <b>{counts.collision}</b> true {counts.collision === 1 ? "collision" : "collisions"}
        </li>
      </ul>

      {nothing && (
        <div className="merge-note">
          Nothing to merge: no function or file differs between {source} and {target}.
        </div>
      )}
      {!nothing && counts.collision === 0 && (
        <div className="merge-note ok">
          No conflicts. Git can merge {source} into {target} on its own.
          {!analysis.canAutoMerge && " (The backend still reports that it can't auto-merge; git will say if something is wrong.)"}
        </div>
      )}

      <div className="merge-files">
        {groups.map((group) => (
          <section key={group.filePath} className="merge-file">
            <h3 className="merge-file-name">{group.filePath}</h3>
            <ul>
              {group.conflicts.map((c, i) => {
                const item = items.find((it) => it.conflict === c);
                return (
                  <li key={`${c.symbolName ?? ""}:${i}`} className="merge-fn">
                    <span className="merge-fn-name">{conflictLabel(c)}</span>
                    <span className={`merge-badge ${STATUS_TONE[c.resolutionStatus]}`}>{STATUS_TEXT[c.resolutionStatus]}</span>
                    {item && (
                      <button type="button" className="btn merge-small" onClick={() => onResolve(item.id)}>
                        Resolve
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <div className="merge-actions">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        {counts.collision > 0 && (
          <button type="button" className="btn primary" onClick={() => onResolve()}>
            Resolve {counts.collision} {counts.collision === 1 ? "conflict" : "conflicts"}
          </button>
        )}
        {!nothing && counts.collision === 0 && (
          <button type="button" className="btn primary" onClick={onMergeNow}>
            Merge now
          </button>
        )}
      </div>
    </div>
  );
}