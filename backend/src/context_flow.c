#include "context_flow.h"
#include "context_compiler.h"

#include <ctype.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FLOW_MAX_SEEDS 64u
#define FLOW_FAN_IN_THRESHOLD 4u

typedef struct {
    const RepositoryIndex *index;
    const IndexScope *scopes;
    size_t scope_count;
    const IndexCallLink *links;
    size_t link_count;
    size_t *out_offsets;
    size_t *out_links;
    size_t *in_offsets;
    size_t *in_links;
    size_t *fan_in;
    size_t *module;
} FlowGraph;

typedef struct {
    size_t *items;
    size_t count;
    size_t capacity;
} SeedList;

static int same_text(const char *left, const char *right)
{
    return left != NULL && right != NULL && strcmp(left, right) == 0;
}

static const char *path_basename(const char *path)
{
    const char *slash = path ? strrchr(path, '/') : NULL;
    return slash ? slash + 1 : path;
}

static int entry_point_name(const char *name)
{
    if (name == NULL) return 0;
    return strcmp(name, "main") == 0 || strcmp(name, "Main") == 0 ||
           strcmp(name, "run") == 0 || strcmp(name, "start") == 0 ||
           strcmp(name, "serve") == 0 || strcmp(name, "init") == 0 ||
           strncmp(name, "handle_", 7) == 0 || strncmp(name, "on_", 3) == 0;
}

static int entry_point_path(const char *path)
{
    const char *base = path_basename(path);
    if (base == NULL) return 0;
    size_t length = strcspn(base, ".");
    static const char *const names[] = {
        "main", "app", "index", "server", "cli", NULL
    };
    for (size_t i = 0; names[i]; ++i)
        if (strlen(names[i]) == length && strncmp(base, names[i], length) == 0) return 1;
    return 0;
}

static int python_package_entry(const GraphSymbol *symbol)
{
    return strcmp(symbol->language, "python") == 0 &&
           symbol->kind == PARSER_FUNCTION && symbol->form == PARSER_DEFINITION &&
           symbol->parent == NULL &&
           strcmp(path_basename(symbol->location.file_path), "__main__.py") == 0;
}

static size_t module_scope(const IndexScope *scopes, size_t scope)
{
    while (scope != INDEX_NO_SCOPE) {
        if (scopes[scope].kind == INDEX_MODULE) return scope;
        scope = scopes[scope].parent;
    }
    return 0;
}

static int add_seed(SeedList *seeds, size_t scope)
{
    for (size_t i = 0; i < seeds->count; ++i)
        if (seeds->items[i] == scope) return 1;
    if (seeds->count == seeds->capacity) {
        size_t capacity = seeds->capacity ? seeds->capacity * 2 : 8;
        if (capacity > FLOW_MAX_SEEDS) capacity = FLOW_MAX_SEEDS;
        if (capacity <= seeds->capacity) return 1;
        size_t *items = realloc(seeds->items, capacity * sizeof *items);
        if (items == NULL) return 0;
        seeds->items = items;
        seeds->capacity = capacity;
    }
    seeds->items[seeds->count++] = scope;
    return 1;
}

static int resolve_seeds(const RepositoryIndex *index, const ContextFlowRequest *request,
                         SeedList *out)
{
    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(index, &scope_count);
    if (request->mode == CONTEXT_FLOW_ONBOARDING) {
        for (size_t i = 0; i < scope_count && out->count < FLOW_MAX_SEEDS; ++i) {
            if (scopes[i].kind != INDEX_SYMBOL || scopes[i].symbol == NULL) continue;
            const GraphSymbol *symbol = scopes[i].symbol;
            if (entry_point_name(symbol->name) ||
                entry_point_path(symbol->location.file_path) ||
                python_package_entry(symbol)) {
                if (!add_seed(out, i)) return CHRONOS_OUT_OF_MEMORY;
            }
        }
        return CHRONOS_OK;
    }

    for (size_t i = 0; i < request->seed_count && out->count < FLOW_MAX_SEEDS; ++i) {
        const ContextFlowSeed *seed = &request->seeds[i];
        switch (seed->kind) {
        case CONTEXT_FLOW_SEED_SYMBOL:
        case CONTEXT_FLOW_SEED_CHANGED_SYMBOL: {
            size_t scope = index_find_symbol(index, seed->symbol);
            if (scope == INDEX_NO_SCOPE) continue;
            if (!add_seed(out, scope)) return CHRONOS_OUT_OF_MEMORY;
            break;
        }
        case CONTEXT_FLOW_SEED_PATH:
            if (seed->path == NULL || *seed->path == '\0') return CHRONOS_INVALID_ARGUMENT;
            for (size_t j = 0; j < scope_count && out->count < FLOW_MAX_SEEDS; ++j) {
                if (scopes[j].kind != INDEX_SYMBOL || scopes[j].symbol == NULL) continue;
                if (!same_text(scopes[j].symbol->location.file_path, seed->path)) continue;
                if (!add_seed(out, j)) return CHRONOS_OUT_OF_MEMORY;
            }
            break;
        default:
            return CHRONOS_INVALID_ARGUMENT;
        }
    }
    return CHRONOS_OK;
}

static void flow_graph_free(FlowGraph *graph)
{
    free(graph->out_offsets);
    free(graph->out_links);
    free(graph->in_offsets);
    free(graph->in_links);
    free(graph->fan_in);
    free(graph->module);
    *graph = (FlowGraph){0};
}

static int flow_graph_build(const RepositoryIndex *index, FlowGraph *out)
{
    FlowGraph graph = {0};
    graph.index = index;
    graph.scopes = index_scopes(index, &graph.scope_count);
    graph.links = index_call_links(index, &graph.link_count);
    if (graph.scope_count == 0) {
        *out = graph;
        return CHRONOS_OK;
    }
    size_t n = graph.scope_count + 1;
    graph.out_offsets = calloc(n, sizeof *graph.out_offsets);
    graph.in_offsets = calloc(n, sizeof *graph.in_offsets);
    graph.out_links = calloc(graph.link_count, sizeof *graph.out_links);
    graph.in_links = calloc(graph.link_count, sizeof *graph.in_links);
    graph.fan_in = calloc(graph.scope_count, sizeof *graph.fan_in);
    graph.module = calloc(graph.scope_count, sizeof *graph.module);
    if (!graph.out_offsets || !graph.in_offsets || !graph.fan_in || !graph.module ||
        (graph.link_count && (!graph.out_links || !graph.in_links))) {
        flow_graph_free(&graph);
        return CHRONOS_OUT_OF_MEMORY;
    }

    for (size_t i = 0; i < graph.link_count; ++i) {
        const IndexCallLink *link = &graph.links[i];
        if (link->caller != INDEX_NO_SCOPE) ++graph.out_offsets[link->caller + 1];
        if (link->callee != INDEX_NO_SCOPE) {
            ++graph.in_offsets[link->callee + 1];
            ++graph.fan_in[link->callee];
        }
    }
    for (size_t i = 1; i < n; ++i) {
        graph.out_offsets[i] += graph.out_offsets[i - 1];
        graph.in_offsets[i] += graph.in_offsets[i - 1];
    }
    size_t *out_next = calloc(graph.scope_count, sizeof *out_next);
    size_t *in_next = calloc(graph.scope_count, sizeof *in_next);
    if (!out_next || !in_next) {
        free(out_next);
        free(in_next);
        flow_graph_free(&graph);
        return CHRONOS_OUT_OF_MEMORY;
    }
    for (size_t i = 0; i < graph.link_count; ++i) {
        const IndexCallLink *link = &graph.links[i];
        if (link->caller != INDEX_NO_SCOPE) {
            graph.out_links[graph.out_offsets[link->caller] + out_next[link->caller]++] = i;
        }
        if (link->callee != INDEX_NO_SCOPE) {
            graph.in_links[graph.in_offsets[link->callee] + in_next[link->callee]++] = i;
        }
    }
    free(out_next);
    free(in_next);
    for (size_t i = 0; i < graph.scope_count; ++i)
        graph.module[i] = module_scope(graph.scopes, i);
    *out = graph;
    return CHRONOS_OK;
}

static int is_ancestor(size_t target, size_t current, const size_t *parent)
{
    while (current != INDEX_NO_SCOPE) {
        if (current == target) return 1;
        current = parent[current];
    }
    return 0;
}

static double node_score(size_t hop, int via_incoming, int crossed_module,
                         size_t fan_in, int is_seed)
{
    if (is_seed) return 1.0;
    double proximity = 1.0 - 0.2 * (double)hop;
    if (proximity < 0.1) proximity = 0.1;
    double score = proximity * (via_incoming ? 1.0 : 0.85);
    if (crossed_module) score += 0.12;
    if (fan_in > FLOW_FAN_IN_THRESHOLD) {
        double penalty = 0.09 * (double)(fan_in - FLOW_FAN_IN_THRESHOLD);
        if (penalty > 0.45) penalty = 0.45;
        score -= penalty;
    }
    if (score < 0.0) score = 0.0;
    if (score > 1.0) score = 1.0;
    return score;
}

static char *flow_id(const char *seed_id, const char *target_id)
{
    size_t seed_length = strlen(seed_id);
    size_t target_length = strlen(target_id);
    int length = snprintf(NULL, 0, "flow:v1:%zu:%s%zu:%s", seed_length, seed_id,
                          target_length, target_id);
    if (length < 0) return NULL;
    char *id = malloc((size_t)length + 1);
    if (id == NULL) return NULL;
    (void)snprintf(id, (size_t)length + 1, "flow:v1:%zu:%s%zu:%s", seed_length, seed_id,
                   target_length, target_id);
    return id;
}

static void free_flow(ContextFlow *flow)
{
    if (flow == NULL) return;
    for (size_t i = 0; i < flow->edge_count; ++i) free((void *)flow->edges[i].evidence_id);
    free((void *)flow->edges);
    free((void *)flow->nodes);
    free((void *)flow->id);
    *flow = (ContextFlow){0};
}

void context_flow_set_free(ContextFlowSet *flows)
{
    if (flows == NULL) return;
    for (size_t i = 0; i < flows->count; ++i) free_flow(&flows->flows[i]);
    free(flows->flows);
    free((void *)flows->seeds);
    *flows = (ContextFlowSet){0};
}

static int compare_flows(const void *left, const void *right)
{
    const ContextFlow *a = left;
    const ContextFlow *b = right;
    if (a->relevance > b->relevance) return -1;
    if (a->relevance < b->relevance) return 1;
    return strcmp(a->id, b->id);
}

int context_discover_flows(const RepositoryIndex *index, const ContextFlowRequest *request,
                           ContextFlowSet *out)
{
    if (index == NULL || request == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    *out = (ContextFlowSet){0};
    if (request->mode != CONTEXT_FLOW_ONBOARDING && request->mode != CONTEXT_FLOW_TASK)
        return CHRONOS_INVALID_ARGUMENT;
    if (request->seed_count != 0 && request->seeds == NULL)
        return CHRONOS_INVALID_ARGUMENT;
    size_t max_hops = request->max_hops ? request->max_hops : CHRONOS_FLOW_DEFAULT_MAX_HOPS;
    size_t max_flows = request->max_flows ? request->max_flows : CHRONOS_FLOW_DEFAULT_MAX_FLOWS;
    size_t max_nodes = request->max_nodes ? request->max_nodes : CHRONOS_FLOW_DEFAULT_MAX_NODES;
    if (max_hops > CHRONOS_FLOW_MAX_HOPS || max_flows > CHRONOS_FLOW_MAX_FLOWS ||
        max_nodes > CHRONOS_FLOW_MAX_NODES) return CHRONOS_INVALID_ARGUMENT;

    FlowGraph graph = {0};
    int status = flow_graph_build(index, &graph);
    if (status < 0) return status;
    SeedList seeds = {0};
    const GraphSymbol **seed_symbols = NULL;
    status = resolve_seeds(index, request, &seeds);
    if (status < 0) goto done;
    if (seeds.count == 0) {
        if (request->mode == CONTEXT_FLOW_TASK) {
            status = CHRONOS_NOT_FOUND;
            goto done;
        }
        *out = (ContextFlowSet){NULL, 0, NULL, 0, 0, index_call_coverage(index)};
        status = index_call_coverage(index) == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;
        goto done;
    }
    seed_symbols = calloc(seeds.count, sizeof *seed_symbols);
    if (seed_symbols == NULL) {
        status = CHRONOS_OUT_OF_MEMORY;
        goto done;
    }
    for (size_t i = 0; i < seeds.count; ++i)
        seed_symbols[i] = graph.scopes[seeds.items[i]].symbol;

    size_t *hop = malloc(graph.scope_count * sizeof *hop);
    size_t *parent = malloc(graph.scope_count * sizeof *parent);
    size_t *parent_link = malloc(graph.scope_count * sizeof *parent_link);
    int *parent_forward = calloc(graph.scope_count, sizeof *parent_forward);
    int *via_incoming = calloc(graph.scope_count, sizeof *via_incoming);
    int *crossed_module = calloc(graph.scope_count, sizeof *crossed_module);
    int *is_seed = calloc(graph.scope_count, sizeof *is_seed);
    double *score = calloc(graph.scope_count, sizeof *score);
    size_t *queue = malloc(graph.scope_count * sizeof *queue);
    if (!hop || !parent || !parent_link || !parent_forward || !via_incoming ||
        !crossed_module || !is_seed || !score || !queue) {
        free(hop);
        free(parent);
        free(parent_link);
        free(parent_forward);
        free(via_incoming);
        free(crossed_module);
        free(is_seed);
        free(score);
        free(queue);
        status = CHRONOS_OUT_OF_MEMORY;
        goto done;
    }
    for (size_t i = 0; i < graph.scope_count; ++i) {
        hop[i] = SIZE_MAX;
        parent[i] = INDEX_NO_SCOPE;
        parent_link[i] = SIZE_MAX;
    }
    size_t head = 0, tail = 0;
    for (size_t i = 0; i < seeds.count; ++i) {
        size_t scope = seeds.items[i];
        hop[scope] = 0;
        is_seed[scope] = 1;
        score[scope] = 1.0;
        queue[tail++] = scope;
    }

    size_t collapsed_cycles = 0;
#define VISIT_EDGE(target, link_index, forward, incoming)                                      \
    do {                                                                                       \
        size_t visit_target = (target);                                                        \
        if (visit_target == INDEX_NO_SCOPE || visit_target >= graph.scope_count) break;        \
        if (hop[visit_target] != SIZE_MAX) {                                                   \
            if (is_ancestor(visit_target, current, parent)) ++collapsed_cycles;                \
            break;                                                                             \
        }                                                                                      \
        hop[visit_target] = hop[current] + 1;                                                  \
        parent[visit_target] = current;                                                        \
        parent_link[visit_target] = (link_index);                                              \
        parent_forward[visit_target] = (forward);                                              \
        via_incoming[visit_target] = (incoming);                                               \
        crossed_module[visit_target] = graph.module[visit_target] != graph.module[current];    \
        score[visit_target] = node_score(hop[visit_target], (incoming),                        \
                                         crossed_module[visit_target],                         \
                                         graph.fan_in[visit_target], 0);                       \
        queue[tail++] = visit_target;                                                          \
    } while (0)

    while (head < tail) {
        size_t current = queue[head++];
        if (hop[current] >= max_hops) continue;
        int expand_incoming = !(graph.fan_in[current] > FLOW_FAN_IN_THRESHOLD && !is_seed[current]);
        if (request->mode == CONTEXT_FLOW_TASK) {
            if (expand_incoming) {
                for (size_t i = graph.in_offsets[current]; i < graph.in_offsets[current + 1]; ++i) {
                    const IndexCallLink *link = &graph.links[graph.in_links[i]];
                    VISIT_EDGE(link->caller, graph.in_links[i], 0, 1);
                }
            }
            for (size_t i = graph.out_offsets[current]; i < graph.out_offsets[current + 1]; ++i) {
                const IndexCallLink *link = &graph.links[graph.out_links[i]];
                VISIT_EDGE(link->callee, graph.out_links[i], 1, 0);
            }
        } else {
            for (size_t i = graph.out_offsets[current]; i < graph.out_offsets[current + 1]; ++i) {
                const IndexCallLink *link = &graph.links[graph.out_links[i]];
                VISIT_EDGE(link->callee, graph.out_links[i], 1, 0);
            }
        }
    }
#undef VISIT_EDGE

    size_t flow_capacity = 0;
    for (size_t i = 0; i < graph.scope_count; ++i)
        if (hop[i] != SIZE_MAX && !is_seed[i]) ++flow_capacity;
    ContextFlow *flows = flow_capacity ? calloc(flow_capacity, sizeof *flows) : NULL;
    if (flow_capacity && flows == NULL) {
        status = CHRONOS_OUT_OF_MEMORY;
        goto cleanup;
    }
    size_t flow_count = 0;
    size_t *path = malloc(max_nodes * sizeof *path);
    if (path == NULL) {
        free(flows);
        status = CHRONOS_OUT_OF_MEMORY;
        goto cleanup;
    }
    for (size_t i = 0; i < graph.scope_count; ++i) {
        if (hop[i] == SIZE_MAX || is_seed[i]) continue;
        size_t length = 0;
        for (size_t scope = i; scope != INDEX_NO_SCOPE; scope = parent[scope]) {
            if (++length > max_nodes) break;
        }
        if (length == 0 || length > max_nodes) continue;
        size_t cursor = length;
        for (size_t scope = i; scope != INDEX_NO_SCOPE; scope = parent[scope])
            path[--cursor] = scope;
        const GraphSymbol *seed_symbol = graph.scopes[path[0]].symbol;
        const GraphSymbol *target_symbol = graph.scopes[i].symbol;
        if (seed_symbol == NULL || target_symbol == NULL) continue;
        ContextFlow *flow = &flows[flow_count];
        flow->id = flow_id(seed_symbol->ref.id, target_symbol->ref.id);
        flow->seed = seed_symbol;
        flow->relevance = score[i];
        flow->node_count = length;
        flow->edge_count = length - 1;
        ContextFlowNode *node_items = calloc(length, sizeof *node_items);
        ContextFlowEdge *edge_items = calloc(length - 1, sizeof *edge_items);
        flow->nodes = node_items;
        flow->edges = edge_items;
        if (flow->id == NULL || node_items == NULL || edge_items == NULL) {
            free_flow(flow);
            free(path);
            for (size_t j = 0; j < flow_count; ++j) free_flow(&flows[j]);
            free(flows);
            status = CHRONOS_OUT_OF_MEMORY;
            goto cleanup;
        }
        for (size_t j = 0; j < length; ++j) {
            size_t scope = path[j];
            node_items[j] = (ContextFlowNode){
                graph.scopes[scope].symbol, scope, hop[scope], score[scope],
                graph.fan_in[scope], is_seed[scope], via_incoming[scope],
                crossed_module[scope]
            };
        }
        for (size_t j = 1; j < length; ++j) {
            size_t link_index = parent_link[path[j]];
            const GraphCall *call = graph.links[link_index].call;
            char *evidence = context_call_evidence_id_alloc(call);
            if (evidence == NULL) {
                free_flow(flow);
                free(path);
                for (size_t k = 0; k < flow_count; ++k) free_flow(&flows[k]);
                free(flows);
                status = CHRONOS_OUT_OF_MEMORY;
                goto cleanup;
            }
            edge_items[j - 1] = (ContextFlowEdge){
                call, evidence, j - 1, j, parent_forward[path[j]]
            };
        }
        ++flow_count;
    }
    free(path);
    if (flow_count > 1) qsort(flows, flow_count, sizeof *flows, compare_flows);
    if (flow_count > max_flows) {
        for (size_t i = max_flows; i < flow_count; ++i) free_flow(&flows[i]);
        flow_count = max_flows;
    }
    *out = (ContextFlowSet){flows, flow_count, seed_symbols, seeds.count,
                            collapsed_cycles, index_call_coverage(index)};
    seed_symbols = NULL;
    status = index_call_coverage(index) == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;
    goto cleanup;

cleanup:
    free(hop);
    free(parent);
    free(parent_link);
    free(parent_forward);
    free(via_incoming);
    free(crossed_module);
    free(is_seed);
    free(score);
    free(queue);
done:
    free(seed_symbols);
    free(seeds.items);
    flow_graph_free(&graph);
    return status;
}
