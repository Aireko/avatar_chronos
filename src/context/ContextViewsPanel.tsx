import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  closeViews,
  errorMessage,
  loadViewsPage,
  openViews,
  readSessionSource,
  type ContextBriefDocument,
  type ContextCoverage,
  type ContextEvidence,
  type ContextPageDocument,
  type ContextPageEdge,
  type ContextPageKind,
  type ContextPageNode,
  type ContextSourceDocument,
  type ContextTarget,
} from "../backend";

type ViewTab = "brief" | "graph";
type FlowMode = "onboarding" | "task";
type CollectionMode = "replace" | "append" | "keep";

const ROOT_KEY = "root";

const preStyle = {
  maxHeight: 320,
  overflow: "auto",
  textAlign: "left" as const,
  whiteSpace: "pre-wrap" as const,
};

interface PageState {
  key: string;
  kind: ContextPageKind;
  parentScope: string | null;
  nodes: ContextPageNode[];
  edges: ContextPageEdge[];
  nodeTotal: number;
  edgeTotal: number;
  nodeNextOffset: number;
  edgeNextOffset: number;
  evidenceNextOffset: number;
  nodeCoverage: ContextCoverage;
  edgeCoverage: ContextCoverage;
}

interface PageRequest {
  nodes?: CollectionMode;
  edges?: CollectionMode;
  nodeOffset?: number;
  edgeOffset?: number;
  evidenceOffset?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxEvidence?: number;
}

interface OpenSession {
  id: number;
  brief: ContextBriefDocument;
}

function pageKindForNode(node: ContextPageNode): ContextPageKind {
  switch (node.kind) {
    case "module":
      return "module";
    case "file":
      return "file";
    case "symbol":
      return "symbol";
    default:
      return "root";
  }
}

function shortenId(id: string, max = 48): string {
  return id.length <= max ? id : `${id.slice(0, max - 1)}…`;
}

function ContextViewsPanel({ repoPath }: { repoPath: string }) {
  const [revision, setRevision] = useState("HEAD");
  const [mode, setMode] = useState<FlowMode>("onboarding");
  const [targets, setTargets] = useState<ContextTarget[]>([{ path: "", qualifiedName: "" }]);
  const [maxItems, setMaxItems] = useState(12);
  const [maxSourceBytes, setMaxSourceBytes] = useState(4096);
  const [session, setSession] = useState<OpenSession>();
  const [pages, setPages] = useState<Record<string, PageState>>({});
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(new Set());
  const [loadingScopes, setLoadingScopes] = useState<Set<string>>(new Set());
  const [focusScope, setFocusScope] = useState<string>(ROOT_KEY);
  const [evidenceById, setEvidenceById] = useState<Map<string, ContextEvidence>>(new Map());
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();
  const [source, setSource] = useState<ContextSourceDocument>();
  const [tab, setTab] = useState<ViewTab>("brief");
  const [busy, setBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [error, setError] = useState("");
  const sessionIdRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  useEffect(
    () => () => {
      generationRef.current += 1;
      const id = sessionIdRef.current;
      if (id !== null) {
        sessionIdRef.current = null;
        void closeViews(id).catch(() => undefined);
      }
    },
    [],
  );

  const brief = session?.brief;
  const rootPage = pages[ROOT_KEY];
  const focusedPage = pages[focusScope];

  const nodeById = useMemo(() => {
    const map = new Map<string, ContextPageNode>();
    for (const page of Object.values(pages)) {
      for (const node of page.nodes) map.set(node.id, node);
    }
    return map;
  }, [pages]);

  const projectId = useMemo(() => {
    const page = pages[ROOT_KEY];
    if (!page) return undefined;
    for (const edge of page.edges) {
      if (!nodeById.has(edge.from)) return edge.from;
    }
    return undefined;
  }, [pages, nodeById]);

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

  function markLoading(key: string, loading: boolean) {
    setLoadingScopes((previous) => {
      const next = new Set(previous);
      if (loading) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function mergeEvidence(document: ContextPageDocument) {
    const items = document.evidence.items ?? [];
    if (items.length === 0) return;
    setEvidenceById((previous) => {
      const next = new Map(previous);
      for (const item of items) next.set(item.id, item);
      return next;
    });
  }

  function applyPage(key: string, document: ContextPageDocument, request: PageRequest) {
    mergeEvidence(document);
    setPages((previous) => {
      const existing = previous[key];
      const incomingNodes = document.nodes.items ?? [];
      const incomingEdges = document.edges.items ?? [];
      const nodesMode = request.nodes ?? "replace";
      const edgesMode = request.edges ?? "replace";
      const nodes =
        nodesMode === "keep"
          ? (existing?.nodes ?? [])
          : nodesMode === "append"
            ? [...(existing?.nodes ?? []), ...incomingNodes]
            : incomingNodes;
      const edges =
        edgesMode === "keep"
          ? (existing?.edges ?? [])
          : edgesMode === "append"
            ? [...(existing?.edges ?? []), ...incomingEdges]
            : incomingEdges;
      return {
        ...previous,
        [key]: {
          key,
          kind: document.page.kind,
          parentScope: document.page.parentScope,
          nodes,
          edges,
          nodeTotal: document.nodes.total,
          edgeTotal: document.edges.total,
          nodeNextOffset:
            nodesMode === "keep" ? (existing?.nodeNextOffset ?? 0) : document.nodes.nextOffset,
          edgeNextOffset:
            edgesMode === "keep" ? (existing?.edgeNextOffset ?? 0) : document.edges.nextOffset,
          evidenceNextOffset:
            edgesMode === "keep"
              ? (existing?.evidenceNextOffset ?? 0)
              : document.evidence.nextOffset,
          nodeCoverage: document.nodes.status,
          edgeCoverage: document.edges.status,
        },
      };
    });
  }

  async function loadPage(
    sessionId: number,
    key: string,
    kind: ContextPageKind,
    parentScope: string | null,
    request: PageRequest = {},
  ) {
    const generation = generationRef.current;
    markLoading(key, true);
    try {
      setError("");
      const document = await loadViewsPage(sessionId, {
        kind,
        parentScope,
        nodeOffset: request.nodeOffset,
        edgeOffset: request.edgeOffset,
        evidenceOffset: request.evidenceOffset,
        maxNodes: request.maxNodes,
        maxEdges: request.maxEdges,
        maxEvidence: request.maxEvidence,
      });
      if (generation === generationRef.current) applyPage(key, document, request);
    } catch (e) {
      if (generation === generationRef.current) setError(errorMessage(e));
    } finally {
      if (generation === generationRef.current) markLoading(key, false);
    }
  }

  async function releaseSession() {
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    if (id === null) return;
    try {
      await closeViews(id);
    } catch {
      /* The session may already be gone; nothing useful to report. */
    }
  }

  async function onCompile() {
    if (busy) return;
    generationRef.current += 1;
    setBusy(true);
    setError("");
    await releaseSession();
    setSession(undefined);
    setPages({});
    setExpandedScopes(new Set());
    setLoadingScopes(new Set());
    setFocusScope(ROOT_KEY);
    setEvidenceById(new Map());
    setSelectedEvidenceId(undefined);
    setSource(undefined);
    try {
      const opened = await openViews(repoPath, {
        revision,
        mode,
        targets: mode === "task" ? filledTargets : undefined,
        maxItems,
        maxSourceBytes,
      });
      sessionIdRef.current = opened.sessionId;
      setSession({ id: opened.sessionId, brief: opened.brief });
      const evidence = new Map<string, ContextEvidence>();
      for (const item of opened.brief.evidence.items ?? []) evidence.set(item.id, item);
      setEvidenceById(evidence);
      setTab("brief");
      await loadPage(opened.sessionId, ROOT_KEY, "root", null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(id: string) {
    if (!session) return;
    setSelectedEvidenceId(id);
    setSourceBusy(true);
    try {
      setError("");
      const document = await readSessionSource(session.id, id);
      setSource(document);
    } catch (e) {
      setSource(undefined);
      setError(errorMessage(e));
    } finally {
      setSourceBusy(false);
    }
  }

  async function toggleScope(node: ContextPageNode) {
    if (!session) return;
    const key = node.id;
    if (expandedScopes.has(key)) {
      setExpandedScopes((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpandedScopes((previous) => new Set(previous).add(key));
    if (!pages[key]) {
      await loadPage(session.id, key, pageKindForNode(node), node.id, {
        nodes: "replace",
        edges: "replace",
      });
    }
  }

  async function focusNode(node: ContextPageNode) {
    if (!session) return;
    setFocusScope(node.id);
    if (!pages[node.id]) {
      await loadPage(session.id, node.id, pageKindForNode(node), node.id);
    }
  }

  async function loadMoreNodes(page: PageState) {
    if (!session) return;
    await loadPage(session.id, page.key, page.kind, page.parentScope, {
      nodes: "append",
      edges: "keep",
      nodeOffset: page.nodeNextOffset,
      maxEdges: 1,
      maxEvidence: 1,
    });
  }

  async function loadMoreEdges(page: PageState) {
    if (!session) return;
    await loadPage(session.id, page.key, page.kind, page.parentScope, {
      nodes: "keep",
      edges: "append",
      nodeOffset: page.nodeNextOffset,
      edgeOffset: page.edgeNextOffset,
      evidenceOffset: page.evidenceNextOffset,
      maxNodes: 1,
    });
  }

  function nodeLabel(id: string | null): string {
    if (!id) return "(unresolved)";
    if (projectId && id === projectId) return brief?.repositoryId ?? "project";
    return nodeById.get(id)?.label ?? shortenId(id);
  }

  function edgeTarget(edge: ContextPageEdge, side: "from" | "to"): string {
    const id = side === "from" ? edge.from : edge.to;
    if (id) return nodeLabel(id);
    if (edge.call) return `${edge.call.calleeText} (${edge.call.resolution})`;
    return "(unresolved)";
  }

  function evidenceLabel(id: string): string {
    const evidence = evidenceById.get(id);
    if (!evidence?.location) return shortenId(id, 28);
    return `${evidence.location.filePath}:${evidence.location.range.startLine}`;
  }

  function renderRelationships(page: PageState): ReactNode {
    const loading = loadingScopes.has(page.key);
    return (
      <div>
        <p>
          <small>
            {page.edges.length} of {page.edgeTotal} edges · {page.edgeCoverage} edge coverage
            {page.nodeCoverage !== "complete" ? ` · ${page.nodeCoverage} nodes` : ""}
          </small>
        </p>
        <table>
          <thead>
            <tr>
              <th>from</th>
              <th>kind</th>
              <th>to</th>
              <th>state</th>
              <th>evidence</th>
            </tr>
          </thead>
          <tbody>
            {page.edges.map((edge) => (
              <tr key={edge.id}>
                <td>{edgeTarget(edge, "from")}</td>
                <td>{edge.kind}</td>
                <td>{edgeTarget(edge, "to")}</td>
                <td>{edge.state}</td>
                <td>
                  <button onClick={() => void openEvidence(edge.evidenceId)}>
                    {evidenceLabel(edge.evidenceId)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {page.edgeNextOffset < page.edgeTotal && (
          <button onClick={() => void loadMoreEdges(page)} disabled={loading}>
            Load more edges ({page.edgeTotal - page.edgeNextOffset} remaining)
          </button>
        )}
      </div>
    );
  }

  function renderScope(node: ContextPageNode): ReactNode {
    const page = pages[node.id];
    const open = expandedScopes.has(node.id);
    const loading = loadingScopes.has(node.id);
    const isSymbol = node.kind === "symbol";
    const canExpand = isSymbol ? node.edgeCount > 0 : node.childCount > 0;
    return (
      <li key={node.id}>
        <div className="row" style={{ gap: 6, alignItems: "center" }}>
          {canExpand ? (
            <button
              onClick={() => void toggleScope(node)}
              disabled={loading}
              title={open ? "collapse" : "expand"}
            >
              {loading ? "…" : open ? "−" : "+"}
            </button>
          ) : (
            <span style={{ display: "inline-block", width: 32 }} />
          )}
          <button onClick={() => void focusNode(node)} title="show relationships">
            <strong>{node.kind}</strong> {node.label}
          </button>
          <small>
            [{node.state}] {node.childCount} children
            {node.edgeCount > 0 ? ` · ${node.edgeCount} calls` : ""}
            {node.coverage !== "complete" ? ` · ${node.coverage}` : ""}
          </small>
        </div>
        {open &&
          (isSymbol ? (
            page ? (
              renderRelationships(page)
            ) : (
              <p>
                <small>{loading ? "Loading calls…" : "No call data loaded."}</small>
              </p>
            )
          ) : page ? (
            <ul style={{ textAlign: "left" }}>
              {page.nodes.map(renderScope)}
              {page.nodeNextOffset < page.nodeTotal && (
                <li>
                  <button onClick={() => void loadMoreNodes(page)} disabled={loading}>
                    Load more ({page.nodeTotal - page.nodeNextOffset} remaining)
                  </button>
                </li>
              )}
            </ul>
          ) : (
            <p>
              <small>{loading ? "Loading…" : "Not loaded."}</small>
            </p>
          ))}
      </li>
    );
  }

  const selectedEvidence = selectedEvidenceId
    ? evidenceById.get(selectedEvidenceId)
    : undefined;
  const focusLabel =
    focusScope === ROOT_KEY ? "project root" : (nodeById.get(focusScope)?.label ?? shortenId(focusScope));

  return (
    <section>
      <h2>Context compiler</h2>
      <p>
        Compile the budgeted agent brief, then load graph pages one scope at a time. Evidence IDs
        resolve to pinned source; source text is never embedded in a page.
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

      {session && brief && (
        <>
          <div className="row">
            <button onClick={() => setTab("brief")} disabled={tab === "brief"}>
              Brief
            </button>
            <button onClick={() => setTab("graph")} disabled={tab === "graph"}>
              Graph
            </button>
            <small>
              {brief.repositoryId} @ {brief.revision.commitSha.slice(0, 7)} ·{" "}
              {brief.sections.length} sections · {rootPage?.nodeTotal ?? 0} modules ·{" "}
              {focusScope === ROOT_KEY ? (rootPage?.edgeTotal ?? 0) : (focusedPage?.edgeTotal ?? 0)}{" "}
              focused edges
            </small>
          </div>

          {tab === "brief" && (
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
                                onClick={() => void openEvidence(id)}
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

          {tab === "graph" && (
            <div>
              <h3>UI graph</h3>
              <p>
                <small>
                  Pages load on demand as modules and files expand. Source is loaded by evidence ID,
                  not embedded in this payload.
                </small>
              </p>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h4>Scopes</h4>
                  <p>
                    <small>
                      Root lists modules. Expand a module for files, a file for symbols, and a
                      symbol for its calls.
                    </small>
                  </p>
                  {rootPage ? (
                    <ul style={{ textAlign: "left" }}>
                      {rootPage.nodes.map(renderScope)}
                      {rootPage.nodeNextOffset < rootPage.nodeTotal && (
                        <li>
                          <button
                            onClick={() => void loadMoreNodes(rootPage)}
                            disabled={loadingScopes.has(ROOT_KEY)}
                          >
                            Load more modules ({rootPage.nodeTotal - rootPage.nodeNextOffset}{" "}
                            remaining)
                          </button>
                        </li>
                      )}
                    </ul>
                  ) : (
                    <p>
                      <small>{loadingScopes.has(ROOT_KEY) ? "Loading root…" : "Root not loaded."}</small>
                    </p>
                  )}
                </div>
                <div style={{ flex: 2, minWidth: 360 }}>
                  <div className="row" style={{ alignItems: "center", gap: 6 }}>
                    <h4>Relationships</h4>
                    <small>{focusLabel}</small>
                    {focusScope !== ROOT_KEY && (
                      <button onClick={() => setFocusScope(ROOT_KEY)}>root</button>
                    )}
                  </div>
                  {focusedPage ? (
                    renderRelationships(focusedPage)
                  ) : (
                    <p>
                      <small>
                        {loadingScopes.has(focusScope)
                          ? "Loading relationships…"
                          : "Select a scope to load its relationships."}
                      </small>
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {selectedEvidenceId && (
            <div>
              <h3>Evidence</h3>
              <p>
                <code>{selectedEvidenceId}</code>
                <br />
                <small>
                  {selectedEvidence
                    ? `${selectedEvidence.kind} / ${selectedEvidence.state}`
                    : "not loaded in the current page"}
                  {source?.location
                    ? ` · ${source.location.filePath}:${source.location.range.startLine}-${source.location.range.endLine}`
                    : ""}
                </small>
              </p>
              {sourceBusy ? (
                <p>Loading source…</p>
              ) : source?.status === "present" && source.source !== null ? (
                <>
                  <p>
                    <small>
                      {source.location?.filePath} [{source.location?.range.startByte},{" "}
                      {source.location?.range.endByte}) @{" "}
                      {source.location?.revision.commitSha.slice(0, 7)}
                    </small>
                  </p>
                  <pre style={preStyle}>{source.source}</pre>
                </>
              ) : (
                <p>
                  No source is available for this evidence
                  {source ? ` (${source.status})` : ""}.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default ContextViewsPanel;
