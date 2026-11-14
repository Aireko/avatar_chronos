#ifndef CHRONOS_CONTEXT_VIEWS_H
#define CHRONOS_CONTEXT_VIEWS_H

#include "context_compiler.h"
#include "context_flow.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CHRONOS_VIEWS_DEFAULT_MAX_ITEMS 12u
#define CHRONOS_VIEWS_MAX_ITEMS 128u
#define CHRONOS_VIEWS_DEFAULT_MAX_SOURCE_BYTES 4096u

/*
 * Both-view compiler output, schema version 1.
 *
 * One run discovers flows and bridges, then materializes:
 *
 *   graph  module-oriented scope graph: project -> module -> file -> symbol,
 *          contains edges, resolved/unresolved/ambiguous call edges. Nodes and
 *          edges have stable IDs and every edge has an evidence ID. The graph
 *          contains locations and calls only, never source text.
 *   brief  template-rendered agent brief: entry points, top flows, likely
 *          edit/test locations, unresolved calls, and evidence IDs for
 *          retrieving more source. The brief is budgeted independently, so a
 *          graph can reveal evidence the brief omitted.
 *
 * Both views share one evidence catalog. The same evidence ID therefore opens
 * the same pinned source location from either view.
 *
 * The flow request supplies mode, seeds, hop/flow/node limits. The view budget
 * zero values use the defaults above. Brief item order is entry points, top
 * flows, edit locations, test locations, then unresolved calls. A skipped
 * item's evidence IDs appear in brief.omittedEvidenceIds.
 */
typedef struct {
    const ContextFlowRequest *flow;
    ContextBudget budget;
} ContextViewsRequest;

typedef struct {
    ContextGraph graph;
    ContextBrief brief;
    ContextFlowSet flows;
    ContextBridgeSet bridges;
    /* Owned scope ID strings borrowed by graph nodes and edges. */
    char **scope_ids;
    size_t scope_id_count;
} ContextViews;

/* Start out zeroed. Returns CHRONOS_OK for complete coverage, CHRONOS_PARTIAL
 * when discovery was incomplete, or a negative status. The flow request and
 * index must outlive the call. */
int context_build_views(const RepositoryIndex *index, const ContextViewsRequest *request,
                        ContextViews *out);
void context_views_free(ContextViews *views);

#ifdef __cplusplus
}
#endif
#endif /* CHRONOS_CONTEXT_VIEWS_H */
