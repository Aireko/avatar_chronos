#include "context_page.h"

#include <string.h>

static int page_defaults(ContextPageKind kind, ContextPageLimits *limits)
{
    switch (kind) {
    case CONTEXT_PAGE_ROOT:
        *limits = (ContextPageLimits){64, 128, 0};
        return 1;
    case CONTEXT_PAGE_MODULE:
        *limits = (ContextPageLimits){200, 300, 100};
        return 1;
    case CONTEXT_PAGE_FILE:
        *limits = (ContextPageLimits){200, 300, 200};
        return 1;
    case CONTEXT_PAGE_SYMBOL:
        *limits = (ContextPageLimits){1, 200, 400};
        return 1;
    default:
        return 0;
    }
}

int context_page_request_limits(const ContextPageRequest *request, ContextPageLimits *out)
{
    if (request == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    ContextPageLimits limits = {0};
    if (!page_defaults(request->kind, &limits)) return CHRONOS_INVALID_ARGUMENT;
    if (request->kind == CONTEXT_PAGE_ROOT) {
        if (request->parent_scope_id != NULL) return CHRONOS_INVALID_ARGUMENT;
    } else if (request->parent_scope_id == NULL || *request->parent_scope_id == '\0') {
        return CHRONOS_INVALID_ARGUMENT;
    }
    if (request->max_nodes != 0) limits.max_nodes = request->max_nodes;
    if (request->max_edges != 0) limits.max_edges = request->max_edges;
    if (request->max_evidence != 0) limits.max_evidence = request->max_evidence;
    if (limits.max_nodes > CHRONOS_PAGE_MAX_NODES ||
        limits.max_edges > CHRONOS_PAGE_MAX_EDGES ||
        limits.max_evidence > CHRONOS_PAGE_MAX_EVIDENCE)
        return CHRONOS_INVALID_ARGUMENT;
    *out = limits;
    return CHRONOS_OK;
}
