#include "context_page.h"

#include <stdlib.h>
#include <string.h>

struct ContextSession {
    RepositoryIndex *index;
    ContextViews views;
};

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

static int same_text(const char *left, const char *right)
{
    return left != NULL && right != NULL && strcmp(left, right) == 0;
}

static ContextScopeKind scope_kind(IndexScopeKind kind)
{
    switch (kind) {
    case INDEX_PROJECT: return CONTEXT_SCOPE_PROJECT;
    case INDEX_MODULE: return CONTEXT_SCOPE_MODULE;
    case INDEX_FILE: return CONTEXT_SCOPE_FILE;
    default: return CONTEXT_SCOPE_SYMBOL;
    }
}

static const char *scope_label(const RepositoryIndex *index, const IndexScope *scope)
{
    if (scope->kind == INDEX_PROJECT) return index_revision(index)->repository_id;
    if (scope->kind == INDEX_SYMBOL && scope->symbol != NULL) return scope->symbol->name;
    return scope->path;
}

static size_t find_scope_id(const ContextSession *session, const char *id)
{
    for (size_t i = 0; i < session->views.scope_id_count; ++i)
        if (same_text(session->views.scope_ids[i], id)) return i;
    return INDEX_NO_SCOPE;
}

static size_t direct_child_count(const IndexScope *scopes, size_t scope_count, size_t parent)
{
    size_t count = 0;
    for (size_t i = 0; i < scope_count; ++i)
        if (scopes[i].parent == parent) ++count;
    return count;
}

static int list_add(size_t **items, size_t *count, size_t *capacity, size_t value)
{
    if (*count == *capacity) {
        size_t next = *capacity ? *capacity * 2 : 16;
        size_t *grown = realloc(*items, next * sizeof *grown);
        if (grown == NULL) return 0;
        *items = grown;
        *capacity = next;
    }
    (*items)[(*count)++] = value;
    return 1;
}

static int id_add(const char ***items, size_t *count, size_t *capacity, const char *id)
{
    for (size_t i = 0; i < *count; ++i)
        if (same_text((*items)[i], id)) return 1;
    if (*count == *capacity) {
        size_t next = *capacity ? *capacity * 2 : 16;
        const char **grown = realloc((void *)*items, next * sizeof *grown);
        if (grown == NULL) return 0;
        *items = grown;
        *capacity = next;
    }
    (*items)[(*count)++] = id;
    return 1;
}

static int edge_matches(const ContextGraphEdge *edge, ContextPageKind kind,
                        const char *parent_id)
{
    if (kind == CONTEXT_PAGE_SYMBOL)
        return edge->kind == CONTEXT_EVIDENCE_CALL &&
               (same_text(edge->from, parent_id) || same_text(edge->to, parent_id));
    return edge->kind == CONTEXT_EVIDENCE_CONTAINS && same_text(edge->from, parent_id);
}

static const ContextEvidence *find_evidence(const ContextGraph *graph, const char *id)
{
    for (size_t i = 0; i < graph->evidence_count; ++i)
        if (same_text(graph->evidence[i].id, id)) return &graph->evidence[i];
    return NULL;
}

void context_page_free(ContextPage *page)
{
    if (page == NULL) return;
    free((void *)page->nodes);
    free((void *)page->edges);
    free((void *)page->evidence);
    *page = (ContextPage){0};
}

int context_session_open(RepositoryIndex *index, const ContextViewsRequest *request,
                         ContextSession **out)
{
    if (index == NULL || request == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    *out = NULL;
    ContextSession *session = calloc(1, sizeof *session);
    if (session == NULL) return CHRONOS_OUT_OF_MEMORY;
    session->index = index;
    int status = context_build_views(index, request, &session->views);
    if (status < 0) {
        free(session);
        return status;
    }
    *out = session;
    return status;
}

void context_session_close(ContextSession *session)
{
    if (session == NULL) return;
    context_views_free(&session->views);
    index_free(session->index);
    free(session);
}

int context_session_brief(const ContextSession *session, char *out, size_t out_size)
{
    if (session == NULL) return CHRONOS_INVALID_ARGUMENT;
    return context_brief_write_json(&session->views.brief, out, out_size);
}

int context_session_source(const ContextSession *session, const char *evidence_id,
                           ContextSource *out)
{
    if (session == NULL || evidence_id == NULL || out == NULL)
        return CHRONOS_INVALID_ARGUMENT;
    const ContextEvidence *evidence = find_evidence(&session->views.graph, evidence_id);
    if (evidence == NULL) return CHRONOS_NOT_FOUND;
    if (evidence->location == NULL) {
        *out = (ContextSource){.status = CONTEXT_SOURCE_UNAVAILABLE};
        return CHRONOS_PARTIAL;
    }
    size_t length = 0;
    const char *bytes = index_file_bytes(session->index, evidence->location->file_path, &length);
    const SourceRange *range = &evidence->location->range;
    if (bytes == NULL || range->end_byte > length) {
        *out = (ContextSource){.status = CONTEXT_SOURCE_UNAVAILABLE};
        return CHRONOS_PARTIAL;
    }
    *out = (ContextSource){
        .status = CONTEXT_SOURCE_PRESENT,
        .location = evidence->location,
        .bytes = bytes + range->start_byte,
        .byte_count = range->end_byte - range->start_byte
    };
    return CHRONOS_OK;
}

int context_session_page(const ContextSession *session, const ContextPageRequest *request,
                         ContextPage *out)
{
    if (session == NULL || request == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    ContextPageLimits limits = {0};
    if (context_page_request_limits(request, &limits) < 0) return CHRONOS_INVALID_ARGUMENT;

    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(session->index, &scope_count);
    if (scope_count == 0 || session->views.scope_id_count != scope_count)
        return CHRONOS_INVALID_ARGUMENT;

    size_t parent = INDEX_NO_SCOPE;
    size_t project = 0;
    const char *edge_parent_id = NULL;
    if (request->kind == CONTEXT_PAGE_ROOT) {
        edge_parent_id = session->views.scope_ids[project];
    } else {
        parent = find_scope_id(session, request->parent_scope_id);
        if (parent == INDEX_NO_SCOPE) return CHRONOS_NOT_FOUND;
        IndexScopeKind expected = request->kind == CONTEXT_PAGE_MODULE ? INDEX_MODULE
            : request->kind == CONTEXT_PAGE_FILE ? INDEX_FILE : INDEX_SYMBOL;
        if (scopes[parent].kind != expected) return CHRONOS_INVALID_ARGUMENT;
        edge_parent_id = session->views.scope_ids[parent];
    }

    size_t *eligible = NULL;
    size_t eligible_count = 0, eligible_capacity = 0;
    size_t *edge_indices = NULL;
    size_t edge_count = 0, edge_capacity = 0;
    const char **evidence_ids = NULL;
    size_t evidence_id_count = 0, evidence_id_capacity = 0;
    ContextPage page = {0};
    if (request->kind == CONTEXT_PAGE_SYMBOL) {
        if (!list_add(&eligible, &eligible_count, &eligible_capacity, parent)) goto oom;
    } else {
        for (size_t i = 0; i < scope_count; ++i) {
            if (request->kind == CONTEXT_PAGE_ROOT) {
                if (scopes[i].kind != INDEX_MODULE || scopes[i].parent != project) continue;
            } else if (request->kind == CONTEXT_PAGE_MODULE) {
                if (scopes[i].parent != parent ||
                    (scopes[i].kind != INDEX_MODULE && scopes[i].kind != INDEX_FILE)) continue;
            } else if (scopes[i].kind != INDEX_SYMBOL || scopes[i].parent != parent) {
                continue;
            }
            if (!list_add(&eligible, &eligible_count, &eligible_capacity, i)) goto oom;
        }
    }

    page.schema_version = CHRONOS_PAGE_SCHEMA_VERSION;
    page.request = *request;
    page.revision = *index_revision(session->index);
    page.node_total = eligible_count;
    page.edge_coverage = session->views.graph.edge_coverage;
    page.node_coverage = session->views.graph.node_coverage;
    page.evidence_coverage = session->views.graph.evidence_coverage;
    page.diagnostics = index_diagnostics(session->index, &page.diagnostic_count);

    size_t node_count = 0;
    if (request->node_offset < eligible_count) {
        size_t remaining = eligible_count - request->node_offset;
        node_count = remaining < limits.max_nodes ? remaining : limits.max_nodes;
    }
    if (node_count != 0) {
        ContextPageNode *nodes = calloc(node_count, sizeof *nodes);
        if (nodes == NULL) goto oom;
        page.nodes = nodes;
        page.node_count = node_count;
        for (size_t i = 0; i < node_count; ++i) {
            size_t scope = eligible[request->node_offset + i];
            const IndexScope *item = &scopes[scope];
            nodes[i] = (ContextPageNode){
                session->views.scope_ids[scope],
                scope_kind(item->kind),
                item->parent == INDEX_NO_SCOPE ? NULL : session->views.scope_ids[item->parent],
                scope_label(session->index, item),
                item->symbol ? &item->symbol->ref : NULL,
                item->coverage,
                CONTEXT_RELATION_SELECTED,
                item->kind == INDEX_SYMBOL ? 0
                    : direct_child_count(scopes, scope_count, scope),
                0
            };
            if (item->kind == INDEX_SYMBOL) {
                for (size_t e = 0; e < session->views.graph.edge_count; ++e)
                    if (edge_matches(&session->views.graph.edges[e], CONTEXT_PAGE_SYMBOL,
                                     session->views.scope_ids[scope]))
                        ++nodes[i].edge_count;
            }
        }
    }
    page.node_next_offset = request->node_offset + page.node_count;

    for (size_t i = 0; i < session->views.graph.edge_count; ++i) {
        if (!edge_matches(&session->views.graph.edges[i], request->kind, edge_parent_id))
            continue;
        if (!list_add(&edge_indices, &edge_count, &edge_capacity, i)) goto oom;
    }
    page.edge_total = edge_count;
    size_t selected_edges = 0;
    if (request->edge_offset < edge_count) {
        size_t remaining = edge_count - request->edge_offset;
        selected_edges = remaining < limits.max_edges ? remaining : limits.max_edges;
    }
    if (selected_edges != 0) {
        ContextGraphEdge *edges = calloc(selected_edges, sizeof *edges);
        if (edges == NULL) goto oom;
        page.edges = edges;
        page.edge_count = selected_edges;
        for (size_t i = 0; i < selected_edges; ++i)
            edges[i] = session->views.graph.edges[edge_indices[request->edge_offset + i]];
    }
    page.edge_next_offset = request->edge_offset + page.edge_count;

    for (size_t i = 0; i < edge_count; ++i) {
        const ContextGraphEdge *edge = &session->views.graph.edges[edge_indices[i]];
        if (!id_add(&evidence_ids, &evidence_id_count, &evidence_id_capacity, edge->evidence_id))
            goto oom;
    }
    page.evidence_total = evidence_id_count;
    size_t selected_evidence = 0;
    if (request->evidence_offset < evidence_id_count) {
        size_t remaining = evidence_id_count - request->evidence_offset;
        selected_evidence = remaining < limits.max_evidence ? remaining : limits.max_evidence;
    }
    if (selected_evidence != 0) {
        ContextEvidence *evidence = calloc(selected_evidence, sizeof *evidence);
        if (evidence == NULL) goto oom;
        page.evidence = evidence;
        page.evidence_count = selected_evidence;
        for (size_t i = 0; i < selected_evidence; ++i) {
            const ContextEvidence *source = find_evidence(
                &session->views.graph, evidence_ids[request->evidence_offset + i]);
            if (source != NULL) evidence[i] = *source;
        }
    }
    page.evidence_next_offset = request->evidence_offset + page.evidence_count;

    free(eligible);
    free(edge_indices);
    free((void *)evidence_ids);
    *out = page;
    return CHRONOS_OK;

oom:
    free(eligible);
    free(edge_indices);
    free((void *)evidence_ids);
    context_page_free(&page);
    return CHRONOS_OUT_OF_MEMORY;
}
