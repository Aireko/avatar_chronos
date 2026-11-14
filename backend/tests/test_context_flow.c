#include "context_flow.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const RevisionRef REVISION = {
    "example/flow", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};

#define SYMBOL(id, name, start, end, line) \
    {id, 0, PARSER_FUNCTION, PARSER_DEFINITION, name, name, NULL, {start, end, line, line}}
#define CALL(symbol, name, start, end, line) \
    {symbol, name, {start, end, line, line}}

static const ParsedSymbol MAIN_SYMBOLS[] = {
    SYMBOL(1, "main", 0, 100, 1)
};
static const ParsedCall MAIN_CALLS[] = {
    CALL(1, "alpha", 10, 20, 1),
    CALL(1, "helper", 21, 30, 1),
    CALL(1, "save", 31, 40, 1)
};

static const ParsedSymbol CORE_SYMBOLS[] = {
    SYMBOL(1, "alpha", 0, 100, 1),
    SYMBOL(2, "beta", 101, 200, 2)
};
static const ParsedCall CORE_CALLS[] = {
    CALL(1, "beta", 10, 20, 1),
    CALL(1, "helper", 21, 30, 1),
    CALL(2, "gamma", 110, 120, 2),
    CALL(2, "helper", 121, 130, 2)
};

static const ParsedSymbol REMOTE_SYMBOLS[] = {
    SYMBOL(1, "gamma", 0, 100, 1)
};
static const ParsedCall REMOTE_CALLS[] = {
    CALL(1, "alpha", 10, 20, 1),
    CALL(1, "helper", 21, 30, 1)
};

static const ParsedSymbol UTIL_SYMBOLS[] = {
    SYMBOL(1, "helper", 0, 100, 1),
    SYMBOL(2, "f1", 101, 200, 2),
    SYMBOL(3, "f2", 201, 300, 3),
    SYMBOL(4, "f3", 301, 400, 4),
    SYMBOL(5, "f4", 401, 500, 5),
    SYMBOL(6, "f5", 501, 600, 6),
    SYMBOL(7, "f6", 601, 700, 7)
};
static const ParsedCall UTIL_CALLS[] = {
    CALL(2, "helper", 110, 120, 2),
    CALL(3, "helper", 210, 220, 3),
    CALL(4, "helper", 310, 320, 4),
    CALL(5, "helper", 410, 420, 5),
    CALL(6, "helper", 510, 520, 6),
    CALL(7, "helper", 610, 620, 7)
};

static const ParsedSymbol SAVE_A_SYMBOLS[] = {
    SYMBOL(1, "save", 0, 100, 1)
};
static const ParsedSymbol SAVE_B_SYMBOLS[] = {
    SYMBOL(1, "save", 0, 100, 1)
};

static RepositoryIndex *build_index(void)
{
    const ParsedFile files[] = {
        {.revision = REVISION, .file_path = "app/main.c", .language = "c",
         .source_length = 4096, .symbols = MAIN_SYMBOLS,
         .symbol_count = sizeof MAIN_SYMBOLS / sizeof MAIN_SYMBOLS[0],
         .calls = MAIN_CALLS, .call_count = sizeof MAIN_CALLS / sizeof MAIN_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "app/core.c", .language = "c",
         .source_length = 4096, .symbols = CORE_SYMBOLS,
         .symbol_count = sizeof CORE_SYMBOLS / sizeof CORE_SYMBOLS[0],
         .calls = CORE_CALLS, .call_count = sizeof CORE_CALLS / sizeof CORE_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "lib/remote.c", .language = "c",
         .source_length = 4096, .symbols = REMOTE_SYMBOLS,
         .symbol_count = sizeof REMOTE_SYMBOLS / sizeof REMOTE_SYMBOLS[0],
         .calls = REMOTE_CALLS, .call_count = sizeof REMOTE_CALLS / sizeof REMOTE_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "app/util.c", .language = "c",
         .source_length = 4096, .symbols = UTIL_SYMBOLS,
         .symbol_count = sizeof UTIL_SYMBOLS / sizeof UTIL_SYMBOLS[0],
         .calls = UTIL_CALLS, .call_count = sizeof UTIL_CALLS / sizeof UTIL_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "app/save_a.c", .language = "c",
         .source_length = 4096, .symbols = SAVE_A_SYMBOLS,
         .symbol_count = sizeof SAVE_A_SYMBOLS / sizeof SAVE_A_SYMBOLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "app/save_b.c", .language = "c",
         .source_length = 4096, .symbols = SAVE_B_SYMBOLS,
         .symbol_count = sizeof SAVE_B_SYMBOLS / sizeof SAVE_B_SYMBOLS[0],
         .coverage = CHRONOS_COMPLETE}
    };
    IndexFileInput inputs[6] = {0};
    for (size_t i = 0; i < 6; ++i) inputs[i] = (IndexFileInput){&files[i], NULL};
    RepositoryIndex *index = NULL;
    assert(index_build(&REVISION, inputs, 6, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    return index;
}

static int find_symbol(const RepositoryIndex *index, const char *name,
                       SymbolVersionRef *ref)
{
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    for (size_t i = 0; i < count; ++i) {
        if (scopes[i].kind != INDEX_SYMBOL || scopes[i].symbol == NULL) continue;
        if (strcmp(scopes[i].symbol->name, name) == 0) {
            *ref = scopes[i].symbol->ref;
            return 1;
        }
    }
    return 0;
}

static const ContextFlow *find_target(const ContextFlowSet *set, const char *name)
{
    for (size_t i = 0; i < set->count; ++i) {
        const ContextFlow *flow = &set->flows[i];
        if (flow->node_count != 0 &&
            strcmp(flow->nodes[flow->node_count - 1].symbol->name, name) == 0)
            return flow;
    }
    return NULL;
}

static int has_sequence(const ContextFlow *flow, const char *const *names, size_t count)
{
    if (flow->node_count < count) return 0;
    for (size_t start = 0; start + count <= flow->node_count; ++start) {
        size_t i = 0;
        while (i < count &&
               strcmp(flow->nodes[start + i].symbol->name, names[i]) == 0) ++i;
        if (i == count) return 1;
    }
    return 0;
}

int main(void)
{
    RepositoryIndex *index = build_index();
    ContextFlowSet flows = {0};
    const ContextFlowRequest onboarding = {
        .mode = CONTEXT_FLOW_ONBOARDING, .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    assert(context_discover_flows(index, &onboarding, &flows) == CHRONOS_OK);
    assert(flows.count >= 4);
    assert(flows.collapsed_cycles > 0);

    const char *expected[] = {"main", "alpha", "beta", "gamma"};
    const ContextFlow *gamma = find_target(&flows, "gamma");
    const ContextFlow *alpha = find_target(&flows, "alpha");
    const ContextFlow *helper = find_target(&flows, "helper");
    assert(gamma != NULL && alpha != NULL && helper != NULL);
    assert(has_sequence(gamma, expected, 4));
    assert(strcmp(gamma->seed->name, "main") == 0);
    assert(gamma->node_count == 4);
    assert(gamma->nodes[3].crossed_module);
    assert(alpha->relevance > helper->relevance);
    assert(find_target(&flows, "save") == NULL);
    assert(strcmp(flows.flows[0].nodes[flows.flows[0].node_count - 1].symbol->name,
                  "alpha") == 0);
    for (size_t i = 0; i < flows.count; ++i) {
        const ContextFlow *flow = &flows.flows[i];
        assert(flow->id != NULL && flow->node_count >= 2);
        for (size_t j = 0; j < flow->node_count; ++j) {
            for (size_t k = j + 1; k < flow->node_count; ++k)
                assert(strcmp(flow->nodes[j].symbol->name,
                              flow->nodes[k].symbol->name) != 0);
        }
        for (size_t j = 0; j < flow->edge_count; ++j) {
            assert(flow->edges[j].evidence_id != NULL);
            assert(strncmp(flow->edges[j].evidence_id, "call:v1:", 8) == 0);
        }
    }
    context_flow_set_free(&flows);
    assert(flows.flows == NULL && flows.count == 0);

    ContextFlowRequest limited = onboarding;
    limited.max_flows = 2;
    assert(context_discover_flows(index, &limited, &flows) == CHRONOS_OK);
    assert(flows.count == 2);
    assert(strcmp(flows.flows[0].nodes[flows.flows[0].node_count - 1].symbol->name,
                  "alpha") == 0);
    context_flow_set_free(&flows);

    limited = onboarding;
    limited.max_nodes = 2;
    assert(context_discover_flows(index, &limited, &flows) == CHRONOS_OK);
    assert(flows.count == 2);
    for (size_t i = 0; i < flows.count; ++i)
        assert(flows.flows[i].node_count <= 2);
    context_flow_set_free(&flows);

    SymbolVersionRef main_ref;
    assert(find_symbol(index, "main", &main_ref));
    const ContextFlowSeed main_seed = {CONTEXT_FLOW_SEED_SYMBOL, &main_ref, NULL};
    const ContextFlowRequest task_main = {
        .mode = CONTEXT_FLOW_TASK, .seeds = &main_seed, .seed_count = 1,
        .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    assert(context_discover_flows(index, &task_main, &flows) == CHRONOS_OK);
    assert(flows.count > 0);
    for (size_t i = 0; i < flows.count; ++i)
        assert(strcmp(flows.flows[i].seed->ref.id, main_ref.id) == 0);
    context_flow_set_free(&flows);

    const ContextFlowSeed path_seed = {CONTEXT_FLOW_SEED_PATH, NULL, "app/core.c"};
    const ContextFlowRequest task_path = {
        .mode = CONTEXT_FLOW_TASK, .seeds = &path_seed, .seed_count = 1,
        .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    assert(context_discover_flows(index, &task_path, &flows) == CHRONOS_OK);
    assert(flows.count > 0);
    for (size_t i = 0; i < flows.count; ++i)
        assert(strcmp(flows.flows[i].seed->location.file_path, "app/core.c") == 0);
    context_flow_set_free(&flows);

    SymbolVersionRef gamma_ref;
    assert(find_symbol(index, "gamma", &gamma_ref));
    const ContextFlowSeed changed_seed = {
        CONTEXT_FLOW_SEED_CHANGED_SYMBOL, &gamma_ref, NULL
    };
    const ContextFlowRequest task_changed = {
        .mode = CONTEXT_FLOW_TASK, .seeds = &changed_seed, .seed_count = 1,
        .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    assert(context_discover_flows(index, &task_changed, &flows) == CHRONOS_OK);
    const ContextFlow *caller = find_target(&flows, "beta");
    helper = find_target(&flows, "helper");
    assert(caller != NULL && helper != NULL);
    assert(caller->relevance > helper->relevance);
    context_flow_set_free(&flows);

    SymbolVersionRef missing = {
        REVISION, "[\"missing.c\",\"missing\",\"function\",\"definition\",0,1]"
    };
    const ContextFlowSeed missing_seed = {CONTEXT_FLOW_SEED_SYMBOL, &missing, NULL};
    const ContextFlowRequest task_missing = {
        .mode = CONTEXT_FLOW_TASK, .seeds = &missing_seed, .seed_count = 1
    };
    assert(context_discover_flows(index, &task_missing, &flows) == CHRONOS_NOT_FOUND);
    ContextFlowRequest too_far = onboarding;
    too_far.max_hops = CHRONOS_FLOW_MAX_HOPS + 1;
    assert(context_discover_flows(index, &too_far, &flows) == CHRONOS_INVALID_ARGUMENT);

    index_free(index);
    puts("deterministic flow discovery tests passed");
    return 0;
}
