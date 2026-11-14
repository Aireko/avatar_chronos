#ifndef CHRONOS_CONTEXT_PAGE_H
#define CHRONOS_CONTEXT_PAGE_H

#include "context_views.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CHRONOS_PAGE_SCHEMA_VERSION 1u
#define CHRONOS_PAGE_DEFAULT_NODES 64u
#define CHRONOS_PAGE_DEFAULT_EDGES 128u
#define CHRONOS_PAGE_DEFAULT_EVIDENCE 256u
#define CHRONOS_PAGE_MAX_NODES 500u
#define CHRONOS_PAGE_MAX_EDGES 500u
#define CHRONOS_PAGE_MAX_EVIDENCE 1000u
#define CHRONOS_PAGE_INITIAL_TARGET_BYTES 1048576u
#define CHRONOS_PAGE_TARGET_BYTES 262144u

/* Page hierarchy: project -> modules -> files -> symbols.
 * ROOT returns modules; MODULE returns files; FILE returns symbols;
 * SYMBOL returns direct call edges touching that symbol. */
typedef enum {
    CONTEXT_PAGE_ROOT,
    CONTEXT_PAGE_MODULE,
    CONTEXT_PAGE_FILE,
    CONTEXT_PAGE_SYMBOL
} ContextPageKind;

typedef struct {
    ContextPageKind kind;
    const char *parent_scope_id; /* NULL only for ROOT. */
    size_t node_offset;
    size_t edge_offset;
    size_t evidence_offset;
    size_t max_nodes;    /* Zero uses the kind default. */
    size_t max_edges;
    size_t max_evidence;
} ContextPageRequest;

typedef struct {
    size_t max_nodes;
    size_t max_edges;
    size_t max_evidence;
} ContextPageLimits;

typedef struct {
    const char *id;
    ContextScopeKind kind;
    const char *parent_id;
    const char *label;
    const SymbolVersionRef *symbol;
    ChronosCoverage coverage;
    ContextRelationState state;
    size_t child_count;
    size_t edge_count;
} ContextPageNode;

typedef struct {
    unsigned schema_version;
    ContextPageRequest request;
    RevisionRef revision;
    const ContextPageNode *nodes;
    size_t node_count;
    size_t node_total;
    size_t node_next_offset;
    const ContextGraphEdge *edges;
    size_t edge_count;
    size_t edge_total;
    size_t edge_next_offset;
    const ContextEvidence *evidence;
    size_t evidence_count;
    size_t evidence_total;
    size_t evidence_next_offset;
    ChronosCoverage node_coverage;
    ChronosCoverage edge_coverage;
    ChronosCoverage evidence_coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} ContextPage;

/* Resolves zero limits to defaults and enforces hard caps. */
int context_page_request_limits(const ContextPageRequest *request, ContextPageLimits *out);

/* JSON page shape:
 * {schemaVersion, page:{kind,parentScope,offsets,limits}, repositoryId,
 *  revision, nodes:{status,items,total,nextOffset},
 *  edges:{status,items,total,nextOffset},
 *  evidence:{status,items,total,nextOffset}, counts:{children,edges}}
 */

typedef struct ContextSession ContextSession;

/* Builds the index-backed views once. Takes ownership of index on success;
 * on failure the caller still owns it. */
int context_session_open(RepositoryIndex *index, const ContextViewsRequest *request,
                         ContextSession **out);
int context_session_brief(const ContextSession *session, char *out, size_t out_size);
int context_session_page(const ContextSession *session, const ContextPageRequest *request,
                         ContextPage *out);
int context_session_source(const ContextSession *session, const char *evidence_id,
                           ContextSource *out);
void context_page_free(ContextPage *page);
void context_session_close(ContextSession *session);

/* JSON writers use the caller-buffer convention. Query with NULL, 0. */
int context_page_write_json(const ContextPage *page, char *out, size_t out_size);
int context_source_write_json(const ContextSource *source, char *out, size_t out_size);

#ifdef __cplusplus
}
#endif
#endif
