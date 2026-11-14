import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  closeViews,
  errorMessage,
  loadViewsPage,
  openViews,
  readSessionSource,
  type ContextBriefDocument,
  type ContextCoverage,
  type ContextPageDocument,
  type ContextPageEdge,
  type ContextPageEvidence,
  type ContextPageKind,
  type ContextPageNode,
  type ContextSourceDocument,
  type ContextTarget,
} from "../backend";
import { Presence } from "../tools/Presence";
import "../graph/details.css";
import "./context.css";

type ViewTab = "brief" | "graph";
type FlowMode = "onboarding" | "task";
type CollectionMode = "replace" | "append" | "keep";

const ROOT_KEY = "root";

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
  /** Index of the first edge from the latest "Load more edges", where the row stagger restarts. */
  edgeStaggerFrom: number;
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

/** Gap between neighbours in a staggered entrance, and how many steps it may take. */
export const STAGGER_STEP_MS = 24;
export const STAGGER_MAX_STEPS = 8;

/**
 * The entrance delay for the `index`-th item of a staggered list: one small step per
 * item, capped so a long list never keeps its last rows waiting (the 9th item onwards
 * all arrive together, at most STAGGER_STEP_MS * STAGGER_MAX_STEPS in).
 */
export function staggerDelayMs(
  index: number,
  stepMs = STAGGER_STEP_MS,
  maxSteps = STAGGER_MAX_STEPS,
): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), Math.max(0, maxSteps)) * Math.max(0, stepMs);
}

/**
 * Where each brief section's items start in one running order, so the stagger flows
 * through the whole brief instead of restarting under every heading.
 */
export function sectionStarts(itemCounts: readonly number[]): number[] {
  const starts: number[] = [];
  let next = 0;
  for (const count of itemCounts) {
    starts.push(next);
    next += Math.max(0, count);
  }
  return starts;
}

/** Inline style handing a stagger delay to the CSS (`animation-delay: var(--d)`). */
function stagger(index: number): CSSProperties {
  return { "--d": `${staggerDelayMs(index)}ms` } as CSSProperties;
}

/** How long a tree level or the task targets take to roll back up (context.css). */
const ROLL_EXIT_MS = 160;

/**
 * A calm pencil scribble that draws itself along and lifts off again while something
 * is really being worked on, with the words beside it.
 */
function Scribble({ children }: { children: ReactNode }) {
  return (
    <p className="ctx-working" role="status">
      <svg className="ctx-scribble" viewBox="0 0 64 14" width="48" height="12" aria-hidden="true">
        <path
          pathLength={1}
          d="M2 9 C 6 3, 10 2, 13 7 S 19 13, 23 8 S 30 2, 34 7 S 41 13, 45 8 S 52 2, 56 7 S 60 10, 62 6"
        />
      </svg>
      <span>{children}</span>
    </p>
  );
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
  const [evidenceById, setEvidenceById] = useState<Map<string, ContextPageEvidence>>(new Map());
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
          // Appended rows stagger from their own first row, not from the cap.
          edgeStaggerFrom:
            edgesMode === "append"
              ? (existing?.edges.length ?? 0)
              : edgesMode === "keep"
                ? (existing?.edgeStaggerFrom ?? 0)
                : 0,
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
      const evidence = new Map<string, ContextPageEvidence>();
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
    if (edge.calleeText) return `${edge.calleeText} (${edge.state})`;
    return "(unresolved)";
  }

  function evidenceLabel(id: string): string {
    const evidence = evidenceById.get(id);
    if (!evidence?.location) return shortenId(id, 28);
    return `${evidence.location.filePath}:${evidence.location.range.startLine}`;
  }

  function chipClass(id: string): string {
    return id === selectedEvidenceId ? "ctx-chip is-on" : "ctx-chip";
  }

  function renderRelationships(page: PageState): ReactNode {
    const loading = loadingScopes.has(page.key);
    return (
      <div>
        <p>
          <small className="quiet">
            {page.edges.length} of {page.edgeTotal} edges · {page.edgeCoverage} edge coverage
            {page.nodeCoverage !== "complete" ? ` · ${page.nodeCoverage} nodes` : ""}
          </small>
        </p>
        <table className="ctx-table">
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
            {page.edges.map((edge, index) => (
              <tr
                key={edge.id}
                className="ctx-edge"
                style={stagger(index - page.edgeStaggerFrom)}
              >
                <td>{edgeTarget(edge, "from")}</td>
                <td>{edge.kind}</td>
                <td>{edgeTarget(edge, "to")}</td>
                <td>{edge.state}</td>
                <td>
                  <button
                    type="button"
                    className={chipClass(edge.evidenceId)}
                    onClick={() => void openEvidence(edge.evidenceId)}
                  >
                    {evidenceLabel(edge.evidenceId)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {page.edgeNextOffset < page.edgeTotal && (
          <button
            type="button"
            className="btn"
            onClick={() => void loadMoreEdges(page)}
            disabled={loading}
          >
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
        {canExpand ? (
          <button
            type="button"
            className={loading ? "ctx-toggle is-loading" : "ctx-toggle"}
            onClick={() => void toggleScope(node)}
            disabled={loading}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
          >
            {/* A pen-drawn plus whose upright turns down into a minus when open
                (it breathes while the level is loading). */}
            <span className="ctx-pm" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="ctx-node"
          onClick={() => void focusNode(node)}
          title="Show relationships"
        >
          <strong>{node.kind}</strong> {node.label}
        </button>{" "}
        <small className="quiet">
          [{node.state}] {node.childCount} children
          {node.edgeCount > 0 ? ` · ${node.edgeCount} calls` : ""}
          {node.coverage !== "complete" ? ` · ${node.coverage}` : ""}
        </small>
        {/* The level rolls open once its page has loaded, and back up on collapse. */}
        <Presence show={open && page !== undefined} className="ctx-roll" exitMs={ROLL_EXIT_MS}>
          <div className="ctx-roll-clip">
            {page &&
              (isSymbol ? (
                renderRelationships(page)
              ) : (
                <ul className="ctx-tree">
                  {page.nodes.map(renderScope)}
                  {page.nodeNextOffset < page.nodeTotal && (
                    <li>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void loadMoreNodes(page)}
                        disabled={loading}
                      >
                        Load more ({page.nodeTotal - page.nodeNextOffset} remaining)
                      </button>
                    </li>
                  )}
                </ul>
              ))}
          </div>
        </Presence>
        {open && !page && (
          <p className="ctx-pending">
            <small className="quiet">
              {isSymbol
                ? loading
                  ? "Loading calls…"
                  : "No call data loaded."
                : loading
                  ? "Loading…"
                  : "Not loaded."}
            </small>
          </p>
        )}
      </li>
    );
  }

  const selectedEvidence = selectedEvidenceId
    ? evidenceById.get(selectedEvidenceId)
    : undefined;
  const briefStarts = sectionStarts(brief?.sections.map((section) => section.items.length) ?? []);
  const focusLabel =
    focusScope === ROOT_KEY
      ? "project root"
      : (nodeById.get(focusScope)?.label ?? shortenId(focusScope));

  return (
    <section className="ctx" aria-label="Context compiler">
      <h3 className="section-title">Context compiler</h3>
      <p className="ctx-intro">
        Compile the budgeted agent brief, then load graph pages one scope at a time. Evidence IDs
        resolve to pinned source; source text is never embedded in a page.
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
        <button type="button" className="btn primary" onClick={onCompile} disabled={disabled}>
          Compile views
        </button>
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
      </div>

      <Presence show={mode === "task"} className="ctx-roll" exitMs={ROLL_EXIT_MS}>
        <div className="ctx-roll-clip">
          {targets.map((target, index) => (
            <div className="ctx-row ctx-target" key={index}>
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
            <button
              type="button"
              className="btn"
              onClick={addTarget}
              disabled={targets.length >= 64}
            >
              Add target
            </button>
            <small className="quiet">
              {filledTargets.length} target{filledTargets.length === 1 ? "" : "s"} will share one
              evidence catalog and budget.
            </small>
          </div>
        </div>
      </Presence>

      {busy && <Scribble>Compiling views…</Scribble>}
      {error && (
        <p key={error} className="notice bad ctx-notice" role="alert">
          {error}
        </p>
      )}

      {session && brief && (
        <>
          <div className="ctx-row">
            <div className="ctx-tabs" role="group" aria-label="View" data-tab={tab}>
              {/* One block of ink glides under the chosen tab, like the scope tabs. */}
              <span className="ctx-tabs-ink" aria-hidden="true" />
              <button
                type="button"
                className="ctx-tab"
                aria-pressed={tab === "brief"}
                onClick={() => setTab("brief")}
              >
                Brief
              </button>
              <button
                type="button"
                className="ctx-tab"
                aria-pressed={tab === "graph"}
                onClick={() => setTab("graph")}
              >
                Graph
              </button>
            </div>
            <small className="quiet">
              {brief.repositoryId} @ {brief.revision.commitSha.slice(0, 7)} ·{" "}
              {brief.sections.length} sections · {rootPage?.nodeTotal ?? 0} modules ·{" "}
              {focusScope === ROOT_KEY
                ? (rootPage?.edgeTotal ?? 0)
                : (focusedPage?.edgeTotal ?? 0)}{" "}
              focused edges
            </small>
          </div>

          {tab === "brief" && (
            <div key="brief" className="ctx-view">
              <h3 className="section-title">Agent brief</h3>
              <p>
                <small className="quiet">
                  coverage {brief.coverage}, source budget used {brief.budget.usedSourceBytes} bytes
                </small>
              </p>
              {brief.sections.map((section, sectionIndex) => (
                <div key={section.id}>
                  <h4>{section.title}</h4>
                  <ul>
                    {section.items.map((item, index) => (
                      <li
                        key={`${section.id}-${index}`}
                        className="ctx-brief-item"
                        style={stagger(briefStarts[sectionIndex] + index)}
                      >
                        <span>{item.text}</span>{" "}
                        <small className="quiet">({item.state})</small>
                        {item.evidenceIds.length > 0 && (
                          <div>
                            {item.evidenceIds.map((id) => (
                              <button
                                type="button"
                                className={chipClass(id)}
                                key={id}
                                onClick={() => void openEvidence(id)}
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
                <details className="ctx-omitted">
                  <summary>
                    {brief.omittedEvidenceIds.length} evidence IDs omitted by budget
                  </summary>
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

          {tab === "graph" && (
            <div key="graph" className="ctx-view">
              <h3 className="section-title">UI graph</h3>
              <p>
                <small className="quiet">
                  Pages load on demand as modules and files expand. Source is loaded by evidence ID,
                  not embedded in this payload.
                </small>
              </p>
              <div className="ctx-row ctx-graph-cols">
                <div className="ctx-scopes">
                  <h4>Scopes</h4>
                  <p>
                    <small className="quiet">
                      Root lists modules. Expand a module for files, a file for symbols, and a
                      symbol for its calls.
                    </small>
                  </p>
                  {rootPage ? (
                    <ul className="ctx-tree">
                      {rootPage.nodes.map(renderScope)}
                      {rootPage.nodeNextOffset < rootPage.nodeTotal && (
                        <li>
                          <button
                            type="button"
                            className="btn"
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
                      <small className="quiet">
                        {loadingScopes.has(ROOT_KEY) ? "Loading root…" : "Root not loaded."}
                      </small>
                    </p>
                  )}
                </div>
                <div className="ctx-rels">
                  <div className="ctx-row ctx-rels-head">
                    <h4>Relationships</h4>
                    <small className="quiet">{focusLabel}</small>
                    {focusScope !== ROOT_KEY && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setFocusScope(ROOT_KEY)}
                      >
                        Root
                      </button>
                    )}
                  </div>
                  {focusedPage ? (
                    // A newly focused scope swaps its table in, like a tool pane.
                    <div key={focusScope} className="ctx-view">
                      {renderRelationships(focusedPage)}
                    </div>
                  ) : (
                    <p>
                      <small className="quiet">
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
            <div key={selectedEvidenceId} className="ctx-evidence">
              <h3 className="section-title">Evidence</h3>
              <p>
                <code>{selectedEvidenceId}</code>
                <br />
                <small className="quiet">
                  {selectedEvidence
                    ? `${selectedEvidence.kind} / ${selectedEvidence.state}`
                    : "not loaded in the current page"}
                  {source?.location
                    ? ` · ${source.location.filePath}:${source.location.range.startLine}-${source.location.range.endLine}`
                    : ""}
                </small>
              </p>
              {sourceBusy ? (
                <Scribble>Loading source…</Scribble>
              ) : source?.status === "present" && source.source !== null ? (
                <div className="ctx-source">
                  <p>
                    <small className="quiet">
                      {source.location?.filePath} [{source.location?.range.startByte},{" "}
                      {source.location?.range.endByte}) @{" "}
                      {source.location?.revision.commitSha.slice(0, 7)}
                    </small>
                  </p>
                  <pre>{source.source}</pre>
                </div>
              ) : (
                <p className="quiet ctx-source">
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
