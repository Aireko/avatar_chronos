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

/* Builds a source-free scope/call graph and a budgeted template brief from one
 * flow request. Both share one evidence catalog. */
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

/* Starts zeroed. Index and flow request must outlive the result. */
int context_build_views(const RepositoryIndex *index, const ContextViewsRequest *request,
                        ContextViews *out);
void context_views_free(ContextViews *views);

#ifdef __cplusplus
}
#endif
#endif /* CHRONOS_CONTEXT_VIEWS_H */
