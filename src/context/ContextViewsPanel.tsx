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

type ViewTab = "brief" | "graph";
type FlowMode = "onboarding" | "task";

const MAX_EDGE_ROWS = 200;

const preStyle = {
  maxHeight: 320,
  overflow: "auto",
  textAlign: "left" as const,
  whiteSpace: "pre-wrap" as const,
};

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
        <small>
          [{node.state}] {node.id}
        </small>
      </>
    );
    return (
      <li key={node.id}>
        {children.length > 0 && (
          <button onClick={() => toggleScope(node.id)} style={{ marginRight: 6 }}>
            {open ? "−" : "+"}
          </button>
        )}
        {label}
        {open && <ul style={{ textAlign: "left" }}>{children.map(renderScope)}</ul>}
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
    <section>
      <h2>Context compiler</h2>
      <p>
        Compile the budgeted agent brief and the module-oriented graph from the same pinned revision.
        Evidence IDs resolve to the same source from either view.
      </p>

      <div className="row">
        <input value={revision} onChange={(e) => setRevision(e.currentTarget.value)} placeholder="revision" />
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as FlowMode)}>
          <option value="onboarding">onboarding</option>
          <option value="task">task / change impact</option>
        </select>
        <input
          type="number"
          value={maxItems}
          onChange={(e) => setMaxItems(Number(e.currentTarget.value))}
          min={1}
          max={128}
          style={{ width: 90 }}
          title="max brief items"
        />
        <input
          type="number"
          value={maxSourceBytes}
          onChange={(e) => setMaxSourceBytes(Number(e.currentTarget.value))}
          min={0}
          style={{ width: 120 }}
          title="max source bytes"
        />
        <button onClick={onCompile} disabled={disabled}>
          Compile views
        </button>
      </div>

      {mode === "task" && (
        <div>
          {targets.map((target, index) => (
            <div className="row" key={index}>
              <input
                value={target.path}
                onChange={(e) => updateTarget(index, { path: e.currentTarget.value })}
                placeholder="path, e.g. src-tauri/src/lib.rs"
                style={{ flex: 1 }}
              />
              <input
                value={target.qualifiedName}
                onChange={(e) =>
                  updateTarget(index, { qualifiedName: e.currentTarget.value })
                }
                placeholder="qualified name, e.g. run"
                style={{ flex: 1 }}
              />
              <button
                onClick={() => removeTarget(index)}
                disabled={targets.length === 1}
                title="remove target"
              >
                remove
              </button>
            </div>
          ))}
          <button onClick={addTarget} disabled={targets.length >= 64}>
            Add target
          </button>
          <small style={{ marginLeft: 8 }}>
            {filledTargets.length} target{filledTargets.length === 1 ? "" : "s"} will share one
            evidence catalog and budget.
          </small>
        </div>
      )}

      {busy && <p>Working...</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {views && (
        <>
          <div className="row">
            <button onClick={() => setTab("brief")} disabled={tab === "brief"}>
              Brief
            </button>
            <button onClick={() => setTab("graph")} disabled={tab === "graph"}>
              Graph
            </button>
            <small>
              {views.repositoryId} @ {views.revision.commitSha.slice(0, 7)} ·{" "}
              {brief?.sections.length ?? 0} sections · {graph?.nodes.items?.length ?? 0} nodes ·{" "}
              {graph?.edges.items?.length ?? 0} edges
            </small>
          </div>

          {tab === "brief" && brief && (
            <div>
              <h3>Agent brief</h3>
              <p>
                <small>
                  coverage {brief.coverage}, source budget used {brief.budget.usedSourceBytes} bytes
                </small>
              </p>
              {brief.sections.map((section) => (
                <div key={section.id}>
                  <h4>{section.title}</h4>
                  <ul style={{ textAlign: "left" }}>
                    {section.items.map((item, index) => (
                      <li key={`${section.id}-${index}`}>
                        <span>{item.text}</span>{" "}
                        <small>({item.state})</small>
                        {item.evidenceIds.length > 0 && (
                          <div>
                            {item.evidenceIds.map((id) => (
                              <button
                                key={id}
                                onClick={() => openEvidence(id)}
                                title={id}
                                style={{ marginRight: 4, marginTop: 4 }}
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
                  <ul style={{ textAlign: "left" }}>
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
            <div>
              <h3>UI graph</h3>
              <p>
                <small>
                  node coverage {graph.nodes.status}, edge coverage {graph.edges.status}. Source is
                  loaded by evidence ID, not embedded in this payload.
                </small>
              </p>
              <p>
                <small>
                  {graph.evidence.items?.length ?? 0} evidence entries ·{" "}
                  {brief?.omittedEvidenceIds.length ?? 0} brief evidence IDs omitted by budget
                </small>
              </p>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h4>Scopes</h4>
                  <p>
                    <small>Modules start collapsed; use +/− to expand to files and symbols.</small>
                  </p>
                  <ul style={{ textAlign: "left" }}>{rootScopes.map(renderScope)}</ul>
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
                            <button onClick={() => openEvidence(edge.evidenceId)}>
                              open callsite
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {graphEdges.length > visibleEdges.length && (
                    <p>
                      <small>
                        Showing the first {MAX_EDGE_ROWS} of {graphEdges.length} edges.
                      </small>
                    </p>
                  )}
                </div>
              </div>

              {(views?.flows?.length ?? 0) > 0 && (
                <div>
                  <h4>Flows</h4>
                  <ul style={{ textAlign: "left" }}>
                    {(views?.flows ?? []).slice(0, 50).map((flow) => (
                      <li key={flow.id}>
                        {flow.nodes.map((node) => node.name).join(" → ")}{" "}
                        <small>
                          relevance {flow.relevance.toFixed(2)}, {flow.nodes.length} nodes
                        </small>
                        <div>
                          {flow.edges.map((edge) => (
                            <button
                              key={edge.evidenceId}
                              onClick={() => openEvidence(edge.evidenceId)}
                              title={edge.evidenceId}
                              style={{ marginRight: 4, marginTop: 4 }}
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
                            <button onClick={() => openEvidence(bridge.evidenceId)}>
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
            <div>
              <h3>Evidence</h3>
              <p>
                <code>{selectedEvidence.id}</code>
                <br />
                <small>
                  {selectedEvidence.kind} / {selectedEvidence.state}
                  {selectedEvidence.location
                    ? ` · ${selectedEvidence.location.filePath}:${selectedEvidence.location.range.startLine}-${selectedEvidence.location.range.endLine}`
                    : " · no source location"}
                </small>
              </p>
              {source ? (
                <>
                  <p>
                    <small>
                      {source.filePath} [{source.startByte}, {source.endByte}) @{" "}
                      {source.commitSha.slice(0, 7)}
                    </small>
                  </p>
                  <pre style={preStyle}>{source.source}</pre>
                </>
              ) : (
                <p>No source is available for this evidence.</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default ContextViewsPanel;
