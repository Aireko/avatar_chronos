#ifndef CHRONOS_CONTEXT_COMPILER_H
#define CHRONOS_CONTEXT_COMPILER_H

#include "context_package.h"
#include "git_history.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Context compiler contract, schema version 1.
 *
 * Phase one builds a RepositoryIndex for a pinned Git revision. The compiler
 * starts from that index and produces two complementary views for the same
 * evidence:
 *
 *   - context-graph.json: the module -> file -> symbol graph used by the UI.
 *     It contains no source text. A client opens source by evidence ID.
 *   - context-brief.json: the budgeted, template-rendered agent brief. Every
 *     displayed relationship and every source suggestion carries an evidence
 *     ID from the same evidence catalog as the graph.
 *
 * Review mode additionally reuses ReviewContext and review-context.json v1
 * from context_package.h for the single-symbol before/after package.
 *
 * The mock UI owns a separate schema (the `minikv-ui` contract). The compiler
 * graph is an explicit adapter input rather than a silent re-interpretation of
 * the indexer graph shape. CHRONOS_MOCK_UI_ADAPTER* pins that adapter.
 */

#define CHRONOS_COMPILER_REQUEST_SCHEMA_VERSION 1u
#define CHRONOS_COMPILER_GRAPH_SCHEMA_VERSION 1u
#define CHRONOS_COMPILER_BRIEF_SCHEMA_VERSION 1u
#define CHRONOS_MOCK_UI_ADAPTER "minikv-ui"
#define CHRONOS_MOCK_UI_ADAPTER_VERSION 1u
#define CHRONOS_COMPILER_DEFAULT_MAX_HOPS 3u
#define CHRONOS_COMPILER_MAX_HOPS 32u
#define CHRONOS_COMPILER_NO_ID ((const char *)0)

/* A request always pins the head commit. Review and change-impact requests can
 * also pin a base commit. A selector is resolved before the request is built;
 * the compiler never silently re-resolves a moving branch name. */
typedef enum {
    CONTEXT_MODE_ONBOARDING, /* Recognized entry points; anchors are optional. */
    CONTEXT_MODE_TASK,       /* Explicit symbols, paths, or changed symbols. */
    CONTEXT_MODE_REVIEW      /* One explicitly selected symbol, optional base. */
} ContextCompilerMode;

typedef enum {
    CONTEXT_ANCHOR_SYMBOL,         /* symbol and path == NULL. */
    CONTEXT_ANCHOR_PATH,           /* path set and symbol == NULL. */
    CONTEXT_ANCHOR_CHANGED_SYMBOL  /* symbol set; a base revision is required. */
} ContextAnchorKind;

typedef struct {
    ContextAnchorKind kind;
    const char *path;               /* Exact repository-relative Git path. */
    const SymbolVersionRef *symbol; /* Pinned to head or base. */
} ContextAnchor;

typedef struct {
    unsigned schema_version; /* CHRONOS_COMPILER_REQUEST_SCHEMA_VERSION. */
    const GitRepository *repository;
    RevisionRef head;         /* Required, fully resolved. */
    const RevisionRef *base;  /* Optional, fully resolved. */
    ContextCompilerMode mode;
    const ContextAnchor *anchors;
    size_t anchor_count;
    size_t max_hops;          /* Zero means CHRONOS_COMPILER_DEFAULT_MAX_HOPS. */
    ContextBudget budget;
} ContextRequest;

typedef enum {
    CONTEXT_SCOPE_PROJECT,
    CONTEXT_SCOPE_MODULE,
    CONTEXT_SCOPE_FILE,
    CONTEXT_SCOPE_SYMBOL
} ContextScopeKind;

typedef enum {
    CONTEXT_EVIDENCE_CALL,      /* A call site; GraphCall is present. */
    CONTEXT_EVIDENCE_CONTAINS,  /* A parent/child scope relationship. */
    CONTEXT_EVIDENCE_CHANGE,    /* A base/head symbol pairing. */
    CONTEXT_EVIDENCE_SOURCE     /* Pinned source bytes for one symbol. */
} ContextEvidenceKind;

/*
 * Relation states are deliberately independent of ChronosCoverage.
 *
 *   selected     Discovered and inside the active budget.
 *   omitted      Discovered and resolved, then excluded by the budget.
 *   unresolved   A call site exists, but no unique target was indexed.
 *   ambiguous    A call site exists and has two or more indexed candidates.
 *   unavailable  Discovery evidence is missing; this is not a budget result.
 *
 * Omitted-by-budget therefore never masquerades as unresolved or unavailable.
 * A relation with an unresolved or ambiguous target still has a callsite
 * evidence ID. A relation with unavailable discovery still has an ID for the
 * attempted edge, but its evidence entry carries no usable source location.
 */
typedef enum {
    CONTEXT_RELATION_SELECTED,
    CONTEXT_RELATION_OMITTED,
    CONTEXT_RELATION_UNRESOLVED,
    CONTEXT_RELATION_AMBIGUOUS,
    CONTEXT_RELATION_UNAVAILABLE
} ContextRelationState;

/* Evidence IDs are stable strings derived from scope/symbol/callsite data,
 * never from array positions. Use the allocators below; they are the single
 * source of truth for IDs shared by the graph, the brief, and index context
 * collection. IDs are unique within one document's pinned revision; the
 * document's repositoryId and revision complete the identity across commits.
 * The caller frees the returned string. */
char *context_scope_id_alloc(ContextScopeKind kind, const char *path,
                             const SymbolVersionRef *symbol);
char *context_symbol_scope_id_alloc(const GraphSymbol *symbol);
char *context_symbol_evidence_id_alloc(const SymbolVersionRef *symbol);
char *context_call_evidence_id_alloc(const GraphCall *call);
char *context_contains_evidence_id_alloc(const char *parent_id, const char *child_id);
char *context_change_evidence_id_alloc(const SymbolVersionRef *before,
                                       const SymbolVersionRef *after);

/* Static wire names. Invalid enum values return NULL. */
const char *context_mode_name(ContextCompilerMode mode);
const char *context_relation_state_name(ContextRelationState state);
const char *context_scope_kind_name(ContextScopeKind kind);
const char *context_evidence_kind_name(ContextEvidenceKind kind);

/* Validates request shape, pinned revisions, mode-specific anchors, and hop
 * bounds. Budget zero values are valid. Does not touch the repository. */
int context_request_validate(const ContextRequest *request);

/* One retrievable piece of evidence. location is the pinned source location a
 * client opens; it is NULL for a known relationship without source bytes. */
typedef struct {
    const char *id;
    ContextEvidenceKind kind;
    ContextRelationState state;
    const SourceLocation *location;
    const GraphCall *call; /* Present for CONTEXT_EVIDENCE_CALL. */
} ContextEvidence;

typedef struct {
    const char *id;         /* Stable scope ID, not an array index. */
    ContextScopeKind kind;
    const char *parent_id;  /* NULL only for the project root. */
    const char *label;      /* Path or qualified name for display. */
    const SymbolVersionRef *symbol; /* Present only for symbol scopes. */
    ChronosCoverage coverage;
    ContextRelationState state; /* selected or omitted for display nodes. */
} ContextGraphNode;

typedef struct {
    const char *id;          /* Stable edge ID. */
    const char *from;        /* Scope ID. */
    const char *to;          /* Scope ID, or NULL for an unresolved target. */
    ContextEvidenceKind kind;
    ContextRelationState state;
    const char *evidence_id; /* Required for every displayed edge. */
    const GraphCall *call;   /* Present for call edges. */
} ContextGraphEdge;

/* The initial graph payload intentionally contains no source text. Clients
 * resolve evidence_id against the evidence catalog, then read the pinned
 * location. status uses the graph JSON coverage strings. */
typedef struct {
    unsigned schema_version;
    RevisionRef revision;
    const GraphComparison *comparison;
    const ContextGraphNode *nodes;
    size_t node_count;
    ChronosCoverage node_coverage;
    const ContextGraphEdge *edges;
    size_t edge_count;
    ChronosCoverage edge_coverage;
    const ContextEvidence *evidence;
    size_t evidence_count;
    ChronosCoverage evidence_coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} ContextGraph;

typedef struct {
    const char *text;                 /* Rendered from a brief template. */
    const char *const *evidence_ids;  /* IDs for retrieving more source. */
    size_t evidence_count;
    ContextRelationState state;
} ContextBriefItem;

typedef struct {
    const char *id;    /* Stable section ID, e.g. "entry-points". */
    const char *title;
    const ContextBriefItem *items;
    size_t item_count;
} ContextBriefSection;

typedef struct {
    unsigned schema_version;
    RevisionRef revision;
    const GraphComparison *comparison;
    const ContextBriefSection *sections;
    size_t section_count;
    size_t used_source_bytes;
    const char *const *omitted_ids; /* Budget omissions, never resolution. */
    size_t omitted_count;
    ChronosCoverage coverage;
    const ContextEvidence *evidence;
    size_t evidence_count;
    ChronosCoverage evidence_coverage;
} ContextBrief;

/*
 * JSON writers use the caller-buffer convention from mapper.h and
 * context_package.h: query with out == NULL and out_size == 0; a short buffer
 * returns the required length and is untouched; a sufficient buffer is
 * NUL-terminated. The returned value excludes the NUL. Invalid contract input
 * returns CHRONOS_INVALID_ARGUMENT and leaves out untouched.
 *
 * context-graph.json v1:
 *   schemaVersion, repositoryId, revision, comparison, nodes, edges,
 *   evidence, diagnostics, adapter
 *
 * context-brief.json v1:
 *   schemaVersion, repositoryId, revision, comparison, sections, budget,
 *   omittedEvidenceIds, coverage, evidence
 *
 * Collections use {status, items}; status is "complete", "incomplete", or
 * "unavailable". Evidence items are {id, kind, state, location, call}. Every
 * graph edge and every brief evidenceIds entry must resolve to an evidence ID
 * in its document. The adapter block is:
 *   {"name":"minikv-ui","schemaVersion":1,"graphSchemaVersion":1,
 *    "briefSchemaVersion":1,"reviewContextSchemaVersion":1}
 */
int context_request_write_json(const ContextRequest *request, char *out, size_t out_size);
int context_graph_write_json(const ContextGraph *graph, char *out, size_t out_size);
int context_brief_write_json(const ContextBrief *brief, char *out, size_t out_size);

#ifdef __cplusplus
}
#endif
#endif /* CHRONOS_CONTEXT_COMPILER_H */
