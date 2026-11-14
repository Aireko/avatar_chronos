import { useMemo, useState, type ReactNode } from "react";
import {
  compileMultiViews,
  compileViews,
  errorMessage,
  readSource,
  type ContextEvidence,
  type ContextGraphEdge,
  type ContextGraphNode,
  type ContextTarget,
  type ContextViews,
  type SourceResponse,
} from "../backend";
import "../graph/details.css";

type ViewTab = "brief" | "graph";
type FlowMode = "onboarding" | "task";

const MAX_EDGE_ROWS = 200;

function ContextViewsPanel({ repoPath }: { repoPath: string }) {
  const [revision, setRevision] = useState("HEAD");
  const [mode, setMode] = useState<FlowMode>("onboarding");
  const [targets, setTargets] = useState<ContextTarget[]>([{ path: "", qualifiedName: "" }]);
  const [maxItems, setMaxItems] = useState(12);
  const [maxSourceBytes, setMaxSourceBytes] = useState(4096);
  const [views, setViews] = useState<ContextViews>();
  const [tab, setTab] = useState<ViewTab>("brief");
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<SourceResponse>();
  const [selectedEvidence, setSelectedEvidence] = useState<ContextEvidence>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const evidenceById = useMemo(() => {
    const map = new Map<string, ContextEvidence>();
    for (const item of views?.graph.evidence.items ?? []) map.set(item.id, item);
    return map;
  }, [views]);

  const nodeById = useMemo(() => {
    const map = new Map<string, ContextGraphNode>();
    for (const node of views?.graph.nodes.items ?? []) map.set(node.id, node);
    return map;
  }, [views]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, ContextGraphNode[]>();
    for (const node of views?.graph.nodes.items ?? []) {
      const siblings = map.get(node.parentId) ?? [];
      siblings.push(node);
      map.set(node.parentId, siblings);
    }
    return map;
  }, [views]);

  const project = (views?.graph.nodes.items ?? []).find((node) => node.kind === "project");
  const rootScopes = childrenByParent.get(project?.id ?? null) ?? [];

  function renderScope(node: ContextGraphNode): ReactNode {
    const children = childrenByParent.get(node.id) ?? [];
    const open = expandedScopes.has(node.id);
    const label = (
      <>
        <strong>{node.kind}</strong> {node.label}{" "}
        <small className="quiet">
          [{node.state}] {node.id}
        </small>
      </>
    );
    return (
      <li key={node.id}>
        {children.length > 0 && (
          <button
            type="button"
            className="ctx-toggle"
            onClick={() => toggleScope(node.id)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
          >
            {open ? "−" : "+"}
          </button>
        )}
        {label}
        {open && <ul className="ctx-panel">{children.map(renderScope)}</ul>}
      </li>
    );
  }

  const filledTargets = targets.filter(
    (target) => target.path.trim() !== "" && target.qualifiedName.trim() !== "",
  );
  const disabled =
    busy || repoPath.trim() === "" || (mode === "task" && filledTargets.length === 0);

  function updateTarget(index: number, patch: Partial<ContextTarget>) {
    setTargets((previous) =>
      previous.map((target, i) => (i === index ? { ...target, ...patch } : target)),
    );
  }

  function addTarget() {
    setTargets((previous) => [...previous, { path: "", qualifiedName: "" }]);
  }

  function removeTarget(index: number) {
    setTargets((previous) =>
      previous.length > 1 ? previous.filter((_, i) => i !== index) : previous,
    );
  }

  async function onCompile() {
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "task"
          ? await compileMultiViews(repoPath, {
              revision,
              mode: "task",
              targets: filledTargets,
              maxItems,
              maxSourceBytes,
            })
          : await compileViews(repoPath, { revision, mode, maxItems, maxSourceBytes });
      setViews(result);
      setTab("brief");
      setExpandedScopes(new Set());
      setSource(undefined);
      setSelectedEvidence(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(id: string) {
    const evidence = evidenceById.get(id);
    if (!evidence?.location) {
      setSelectedEvidence(evidence);
      setSource(undefined);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const pinned = await readSource(
        repoPath,
        evidence.location.filePath,
        evidence.location.range.startByte,
        evidence.location.range.endByte,
        evidence.location.revision.commitSha,
      );
      setSelectedEvidence(evidence);
      setSource(pinned);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function nodeLabel(id: string | null): string {
    if (!id) return "(unresolved)";
    return nodeById.get(id)?.label ?? id;
  }

  function toggleScope(id: string) {
    setExpandedScopes((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function evidenceLabel(id: string): string {
    const evidence = evidenceById.get(id);
    if (!evidence?.location) return "open evidence";
    const location = evidence.location;
    return `${location.filePath}:${location.range.startLine}`;
  }

  const brief = views?.brief;
  const graph = views?.graph;
  const graphEdges = graph?.edges.items ?? [];
  const visibleEdges = graphEdges.slice(0, MAX_EDGE_ROWS);

  return (
    <section className="ctx" aria-label="Context compiler">
      <h3 className="section-title">Context compiler</h3>
      <p className="ctx-intro">
        Compile the budgeted agent brief and the module-oriented graph from the same pinned revision.
        Evidence IDs resolve to the same source from either view.
      </p>

      <div className="ctx-row">
        <input
          className="field"
          value={revision}
          onChange={(e) => setRevision(e.currentTarget.value)}
          placeholder="revision"
          aria-label="Revision"
          spellCheck={false}
        />
        <select
          className="field"
          value={mode}
          onChange={(e) => setMode(e.currentTarget.value as FlowMode)}
          aria-label="Mode"
        >
          <option value="onboarding">onboarding</option>
          <option value="task">task / change impact</option>
        </select>
      </div>
      <div className="ctx-row">
        <label className="ctx-label">
          Brief items
          <input
            className="field ctx-num"
            type="number"
            value={maxItems}
            onChange={(e) => setMaxItems(Number(e.currentTarget.value))}
            min={1}
            max={128}
          />
        </label>
        <label className="ctx-label">
          Source bytes
          <input
            className="field ctx-num"
            type="number"
            value={maxSourceBytes}
            onChange={(e) => setMaxSourceBytes(Number(e.currentTarget.value))}
            min={0}
          />
        </label>
        <button type="button" className="btn primary" onClick={onCompile} disabled={disabled}>
          Compile views
        </button>
      </div>

      {mode === "task" && (
        <div>
          {targets.map((target, index) => (
            <div className="ctx-row ctx-panel" key={index}>
              <input
                className="field"
                value={target.path}
                onChange={(e) => updateTarget(index, { path: e.currentTarget.value })}
                placeholder="path, e.g. src-tauri/src/lib.rs"
                aria-label={`Target ${index + 1} path`}
                spellCheck={false}
              />
              <input
                className="field"
                value={target.qualifiedName}
                onChange={(e) =>
                  updateTarget(index, { qualifiedName: e.currentTarget.value })
                }
                placeholder="qualified name, e.g. run"
                aria-label={`Target ${index + 1} qualified name`}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn"
                onClick={() => removeTarget(index)}
                disabled={targets.length === 1}
                aria-label={`Remove target ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="ctx-row">
            <button type="button" className="btn" onClick={addTarget} disabled={targets.length >= 64}>
              Add target
            </button>
            <small className="quiet">
              {filledTargets.length} target{filledTargets.length === 1 ? "" : "s"} will share one
              evidence catalog and budget.
            </small>
          </div>
        </div>
      )}

      {busy && (
        <p className="working" role="status">
          <span className="working-dot" />
          Working…
        </p>
      )}
      {error && (
        <p className="notice bad" role="alert">
          {error}
        </p>
      )}

      {views && (
        <>
          <div className="ctx-row">
            <div className="ctx-tabs" role="group" aria-label="View">
              <button type="button" className="btn" aria-pressed={tab === "brief"} onClick={() => setTab("brief")}>
                Brief
              </button>
              <button type="button" className="btn" aria-pressed={tab === "graph"} onClick={() => setTab("graph")}>
                Graph
              </button>
            </div>
            <small className="quiet">
              {views.repositoryId} @ {views.revision.commitSha.slice(0, 7)} ·{" "}
              {brief?.sections.length ?? 0} sections · {graph?.nodes.items?.length ?? 0} nodes ·{" "}
              {graph?.edges.items?.length ?? 0} edges
            </small>
          </div>

          {tab === "brief" && brief && (
            <div key="brief" className="ctx-panel">
              <h3 className="section-title">Agent brief</h3>
              <p>
                <small className="quiet">
                  coverage {brief.coverage}, source budget used {brief.budget.usedSourceBytes} bytes
                </small>
              </p>
              {brief.sections.map((section) => (
                <div key={section.id}>
                  <h4>{section.title}</h4>
                  <ul>
                    {section.items.map((item, index) => (
                      <li key={`${section.id}-${index}`}>
                        <span>{item.text}</span>{" "}
                        <small className="quiet">({item.state})</small>
                        {item.evidenceIds.length > 0 && (
                          <div>
                            {item.evidenceIds.map((id) => (
                              <button
                                type="button"
                                className="ctx-chip"
                                key={id}
                                onClick={() => openEvidence(id)}
                                title={id}
                              >
                                {evidenceLabel(id)}
                              </button>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {brief.omittedEvidenceIds.length > 0 && (
                <details>
                  <summary>{brief.omittedEvidenceIds.length} evidence IDs omitted by budget</summary>
                  <ul>
                    {brief.omittedEvidenceIds.map((id) => (
                      <li key={id}>
                        <code>{id}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {tab === "graph" && graph && (
            <div key="graph" className="ctx-panel">
              <h3 className="section-title">UI graph</h3>
              <p>
                <small className="quiet">
                  node coverage {graph.nodes.status}, edge coverage {graph.edges.status}. Source is
                  loaded by evidence ID, not embedded in this payload.
                </small>
              </p>
              <p>
                <small className="quiet">
                  {graph.evidence.items?.length ?? 0} evidence entries ·{" "}
                  {brief?.omittedEvidenceIds.length ?? 0} brief evidence IDs omitted by budget
                </small>
              </p>
              <div className="ctx-row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h4>Scopes</h4>
                  <p>
                    <small className="quiet">Modules start collapsed; use +/− to expand to files and symbols.</small>
                  </p>
                  <ul>{rootScopes.map(renderScope)}</ul>
                </div>
                <div style={{ flex: 2, minWidth: 360 }}>
                  <h4>Relationships</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>from</th>
                        <th>to</th>
                        <th>state</th>
                        <th>evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEdges.map((edge: ContextGraphEdge) => (
                        <tr key={edge.id}>
                          <td>{nodeLabel(edge.from)}</td>
                          <td>{nodeLabel(edge.to)}</td>
                          <td>{edge.state}</td>
                          <td>
                            <button type="button" className="ctx-chip" onClick={() => openEvidence(edge.evidenceId)}>
                              open callsite
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {graphEdges.length > visibleEdges.length && (
                    <p>
                      <small className="quiet">
                        Showing the first {MAX_EDGE_ROWS} of {graphEdges.length} edges.
                      </small>
                    </p>
                  )}
                </div>
              </div>

              {(views?.flows?.length ?? 0) > 0 && (
                <div>
                  <h4>Flows</h4>
                  <ul>
                    {(views?.flows ?? []).slice(0, 50).map((flow) => (
                      <li key={flow.id}>
                        {flow.nodes.map((node) => node.name).join(" → ")}{" "}
                        <small className="quiet">
                          relevance {flow.relevance.toFixed(2)}, {flow.nodes.length} nodes
                        </small>
                        <div>
                          {flow.edges.map((edge) => (
                            <button
                              type="button"
                              className="ctx-chip"
                              key={edge.evidenceId}
                              onClick={() => openEvidence(edge.evidenceId)}
                              title={edge.evidenceId}
                            >
                              {evidenceLabel(edge.evidenceId)}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(views?.bridges?.length ?? 0) > 0 && (
                <div>
                  <h4>Bridges</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>kind</th>
                        <th>label</th>
                        <th>evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(views?.bridges ?? []).map((bridge) => (
                        <tr key={bridge.evidenceId}>
                          <td>{bridge.kind}</td>
                          <td>{bridge.label}</td>
                          <td>
                            <button type="button" className="ctx-chip" onClick={() => openEvidence(bridge.evidenceId)}>
                              open callsite
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {selectedEvidence && (
            <div key={selectedEvidence.id} className="ctx-panel">
              <h3 className="section-title">Evidence</h3>
              <p>
                <code>{selectedEvidence.id}</code>
                <br />
                <small className="quiet">
                  {selectedEvidence.kind} / {selectedEvidence.state}
                  {selectedEvidence.location
                    ? ` · ${selectedEvidence.location.filePath}:${selectedEvidence.location.range.startLine}-${selectedEvidence.location.range.endLine}`
                    : " · no source location"}
                </small>
              </p>
              {source ? (
                <>
                  <p>
                    <small className="quiet">
                      {source.filePath} [{source.startByte}, {source.endByte}) @{" "}
                      {source.commitSha.slice(0, 7)}
                    </small>
                  </p>
                  <pre>{source.source}</pre>
                </>
              ) : (
                <p className="quiet">No source is available for this evidence.</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default ContextViewsPanel;
