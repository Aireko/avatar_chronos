#include "context_views.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const RevisionRef REVISION = {
    "example/views", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
    CALL(1, "missing", 31, 40, 1)
};

static const ParsedSymbol CORE_SYMBOLS[] = {
    SYMBOL(1, "alpha", 0, 100, 1),
    SYMBOL(2, "beta", 101, 200, 2)
};
static const ParsedCall CORE_CALLS[] = {
    CALL(1, "beta", 10, 20, 1),
    CALL(2, "helper", 110, 120, 2),
    CALL(2, "gamma", 130, 140, 2)
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
    SYMBOL(4, "f3", 301, 400, 4)
};
static const ParsedCall UTIL_CALLS[] = {
    CALL(2, "helper", 110, 120, 2),
    CALL(3, "helper", 210, 220, 3),
    CALL(4, "helper", 310, 320, 4)
};

static const ParsedSymbol TEST_SYMBOLS[] = {
    SYMBOL(1, "test_main", 0, 100, 1)
};
static const ParsedCall TEST_CALLS[] = {
    CALL(1, "main", 10, 20, 1)
};

static unsigned char SOURCE[4096];

static RepositoryIndex *build_index(void)
{
    memset(SOURCE, 'x', sizeof SOURCE);
    const ParsedFile files[] = {
        {.revision = REVISION, .file_path = "app/main.c", .language = "c",
         .source_length = sizeof SOURCE, .symbols = MAIN_SYMBOLS,
         .symbol_count = sizeof MAIN_SYMBOLS / sizeof MAIN_SYMBOLS[0],
         .calls = MAIN_CALLS, .call_count = sizeof MAIN_CALLS / sizeof MAIN_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "app/core.c", .language = "c",
         .source_length = sizeof SOURCE, .symbols = CORE_SYMBOLS,
         .symbol_count = sizeof CORE_SYMBOLS / sizeof CORE_SYMBOLS[0],
         .calls = CORE_CALLS, .call_count = sizeof CORE_CALLS / sizeof CORE_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "lib/remote.c", .language = "c",
         .source_length = sizeof SOURCE, .symbols = REMOTE_SYMBOLS,
         .symbol_count = sizeof REMOTE_SYMBOLS / sizeof REMOTE_SYMBOLS[0],
         .calls = REMOTE_CALLS, .call_count = sizeof REMOTE_CALLS / sizeof REMOTE_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "app/util.c", .language = "c",
         .source_length = sizeof SOURCE, .symbols = UTIL_SYMBOLS,
         .symbol_count = sizeof UTIL_SYMBOLS / sizeof UTIL_SYMBOLS[0],
         .calls = UTIL_CALLS, .call_count = sizeof UTIL_CALLS / sizeof UTIL_CALLS[0],
         .coverage = CHRONOS_COMPLETE},
        {.revision = REVISION, .file_path = "tests/test_main.c", .language = "c",
         .source_length = sizeof SOURCE, .symbols = TEST_SYMBOLS,
         .symbol_count = sizeof TEST_SYMBOLS / sizeof TEST_SYMBOLS[0],
         .calls = TEST_CALLS, .call_count = sizeof TEST_CALLS / sizeof TEST_CALLS[0],
         .coverage = CHRONOS_COMPLETE}
    };
    GitBlob blobs[5] = {0};
    IndexFileInput inputs[5] = {0};
    for (size_t i = 0; i < 5; ++i) {
        blobs[i] = (GitBlob){REVISION, files[i].file_path, SOURCE, sizeof SOURCE};
        inputs[i] = (IndexFileInput){&files[i], &blobs[i]};
    }
    RepositoryIndex *index = NULL;
    assert(index_build(&REVISION, inputs, 5, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    return index;
}

static int find_symbol(const RepositoryIndex *index, const char *name,
                       SymbolVersionRef *ref)
{
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    for (size_t i = 0; i < count; ++i) {
        if (scopes[i].kind == INDEX_SYMBOL && scopes[i].symbol != NULL &&
            strcmp(scopes[i].symbol->name, name) == 0) {
            *ref = scopes[i].symbol->ref;
            return 1;
        }
    }
    return 0;
}

static const ContextBriefSection *find_section(const ContextBrief *brief, const char *id)
{
    for (size_t i = 0; i < brief->section_count; ++i)
        if (strcmp(brief->sections[i].id, id) == 0) return &brief->sections[i];
    return NULL;
}

static const ContextEvidence *find_evidence(const ContextGraph *graph, const char *id)
{
    for (size_t i = 0; i < graph->evidence_count; ++i)
        if (strcmp(graph->evidence[i].id, id) == 0) return &graph->evidence[i];
    return NULL;
}

static const ContextGraphEdge *find_edge(const ContextGraph *graph, const char *id)
{
    for (size_t i = 0; i < graph->edge_count; ++i)
        if (strcmp(graph->edges[i].evidence_id, id) == 0) return &graph->edges[i];
    return NULL;
}

static void assert_brief_evidence_resolves(const ContextGraph *graph,
                                             const ContextBrief *brief)
{
    for (size_t i = 0; i < brief->section_count; ++i)
        for (size_t j = 0; j < brief->sections[i].item_count; ++j)
            for (size_t k = 0; k < brief->sections[i].items[j].evidence_count; ++k)
                assert(find_evidence(graph, brief->sections[i].items[j].evidence_ids[k]) != NULL);
    for (size_t i = 0; i < brief->omitted_count; ++i)
        assert(find_evidence(graph, brief->omitted_ids[i]) != NULL);
}

static int has_edge_state(const ContextGraph *graph, ContextRelationState state)
{
    for (size_t i = 0; i < graph->edge_count; ++i)
        if (graph->edges[i].state == state) return 1;
    return 0;
}

static int has_node_kind(const ContextGraph *graph, ContextScopeKind kind)
{
    for (size_t i = 0; i < graph->node_count; ++i)
        if (graph->nodes[i].kind == kind) return 1;
    return 0;
}

static size_t item_count(const ContextBrief *brief)
{
    size_t count = 0;
    for (size_t i = 0; i < brief->section_count; ++i)
        count += brief->sections[i].item_count;
    return count;
}

static void assert_graph_json(const ContextGraph *graph)
{
    int length = context_graph_write_json(graph, NULL, 0);
    assert(length > 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_graph_write_json(graph, json, (size_t)length + 1) == length);
    assert(strstr(json, "\"source\":") == NULL);
    assert(strstr(json, "\"state\":\"selected\"") != NULL);
    assert(strstr(json, "\"state\":\"omitted\"") != NULL);
    assert(strstr(json, "\"state\":\"unresolved\"") != NULL);
    assert(strstr(json, "\"kind\":\"source\"") != NULL);
    free(json);
}

static void assert_brief_json(const ContextBrief *brief, int expect_omitted)
{
    int length = context_brief_write_json(brief, NULL, 0);
    assert(length > 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_brief_write_json(brief, json, (size_t)length + 1) == length);
    assert(strstr(json, "\"id\":\"entry-points\"") != NULL ||
           strstr(json, "\"id\":\"top-flows\"") != NULL);
    assert(strstr(json, "\"evidence\":{\"status\":") != NULL);
    if (expect_omitted)
        assert(strstr(json, "\"omittedEvidenceIds\":[\"") != NULL);
    free(json);
}

int main(void)
{
    RepositoryIndex *index = build_index();
    const ContextFlowRequest onboarding = {
        .mode = CONTEXT_FLOW_ONBOARDING, .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    ContextViewsRequest request = {
        .flow = &onboarding, .budget = {12, 4096}
    };
    ContextViews views = {0};
    assert(context_build_views(index, &request, &views) == CHRONOS_OK);
    assert_brief_evidence_resolves(&views.graph, &views.brief);

    const ContextBriefSection *entry = find_section(&views.brief, "entry-points");
    const ContextBriefSection *flows = find_section(&views.brief, "top-flows");
    const ContextBriefSection *edit = find_section(&views.brief, "edit-locations");
    const ContextBriefSection *test = find_section(&views.brief, "test-locations");
    const ContextBriefSection *unresolved = find_section(&views.brief, "unresolved");
    assert(entry != NULL && flows != NULL && edit != NULL && test != NULL &&
           unresolved != NULL);
    assert(strcmp(entry->items[0].text, "Entry point: main in app/main.c.") == 0);
    assert(strstr(flows->items[0].text, "Flow: main -> alpha") != NULL);
    assert(strcmp(test->items[0].text,
                  "Likely test location: test_main in tests/test_main.c.") == 0);
    assert(strcmp(unresolved->items[0].text,
                  "Unresolved call: missing from main.") == 0);
    assert(views.brief.used_source_bytes <= request.budget.max_source_bytes);
    assert(item_count(&views.brief) <= request.budget.max_items);
    assert(has_node_kind(&views.graph, CONTEXT_SCOPE_MODULE));
    assert(has_node_kind(&views.graph, CONTEXT_SCOPE_FILE));
    assert(has_node_kind(&views.graph, CONTEXT_SCOPE_SYMBOL));
    assert(has_edge_state(&views.graph, CONTEXT_RELATION_OMITTED));
    assert(has_edge_state(&views.graph, CONTEXT_RELATION_UNRESOLVED));
    assert_graph_json(&views.graph);
    assert_brief_json(&views.brief, 0);

    assert(entry->items[0].evidence_count == 1);
    const char *source_id = entry->items[0].evidence_ids[0];
    const ContextEvidence *source = find_evidence(&views.graph, source_id);
    assert(source != NULL && source->kind == CONTEXT_EVIDENCE_SOURCE);
    assert(source->location != NULL);
    assert(strcmp(source->location->file_path, "app/main.c") == 0);
    assert(source->location->range.start_byte == 0 &&
           source->location->range.end_byte == 100);

    assert(flows->items[0].evidence_count != 0);
    const char *call_id = flows->items[0].evidence_ids[0];
    const ContextEvidence *call_evidence = find_evidence(&views.graph, call_id);
    const ContextGraphEdge *call_edge = find_edge(&views.graph, call_id);
    assert(call_evidence != NULL && call_evidence->kind == CONTEXT_EVIDENCE_CALL);
    assert(call_edge != NULL && call_edge->call != NULL);
    assert(call_evidence->location->range.start_byte ==
           call_edge->call->call_site.range.start_byte);
    assert(strcmp(call_evidence->location->file_path,
                  call_edge->call->call_site.file_path) == 0);

    context_views_free(&views);
    assert(views.graph.nodes == NULL && views.brief.sections == NULL);
    assert(views.flows.flows == NULL && views.bridges.edges == NULL);

    ContextViews tight = {0};
    request.budget = (ContextBudget){2, 50};
    assert(context_build_views(index, &request, &tight) == CHRONOS_OK);
    assert(tight.brief.used_source_bytes == 0);
    assert(item_count(&tight.brief) <= 2);
    assert(tight.brief.omitted_count != 0);
    const ContextEvidence *omitted =
        find_evidence(&tight.graph, tight.brief.omitted_ids[0]);
    assert(omitted != NULL && omitted->state == CONTEXT_RELATION_OMITTED);
    assert(has_edge_state(&tight.graph, CONTEXT_RELATION_OMITTED));
    assert_brief_json(&tight.brief, 1);
    context_views_free(&tight);

    SymbolVersionRef gamma_ref;
    assert(find_symbol(index, "gamma", &gamma_ref));
    const ContextFlowSeed changed = {
        CONTEXT_FLOW_SEED_CHANGED_SYMBOL, &gamma_ref, NULL
    };
    const ContextFlowRequest task = {
        .mode = CONTEXT_FLOW_TASK, .seeds = &changed, .seed_count = 1,
        .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    request.flow = &task;
    request.budget = (ContextBudget){12, 4096};
    ContextViews task_views = {0};
    assert(context_build_views(index, &request, &task_views) == CHRONOS_OK);
    const ContextBriefSection *task_entry = find_section(&task_views.brief, "entry-points");
    assert(task_entry != NULL && strcmp(task_entry->title, "Task anchors") == 0);
    assert(strcmp(task_entry->items[0].text,
                  "Task anchor: gamma in lib/remote.c.") == 0);
    const ContextBriefSection *task_edit = find_section(&task_views.brief, "edit-locations");
    assert(task_edit != NULL);
    int found_beta = 0;
    for (size_t i = 0; i < task_edit->item_count; ++i)
        if (strcmp(task_edit->items[i].text,
                   "Likely edit location: beta in app/core.c.") == 0) found_beta = 1;
    assert(found_beta);
    assert_brief_json(&task_views.brief, 0);
    context_views_free(&task_views);

    SymbolVersionRef main_ref;
    assert(find_symbol(index, "main", &main_ref));
    const ContextFlowSeed multiple[] = {
        {CONTEXT_FLOW_SEED_SYMBOL, &main_ref, NULL},
        {CONTEXT_FLOW_SEED_SYMBOL, &gamma_ref, NULL}
    };
    const ContextFlowRequest multi = {
        .mode = CONTEXT_FLOW_TASK, .seeds = multiple, .seed_count = 2,
        .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    request.flow = &multi;
    request.budget = (ContextBudget){12, 4096};
    ContextViews multi_views = {0};
    assert(context_build_views(index, &request, &multi_views) == CHRONOS_OK);
    const ContextBriefSection *targets = find_section(&multi_views.brief, "targets");
    assert(targets != NULL && targets->item_count == 2);
    assert(strcmp(targets->items[0].text, "Target: main in app/main.c.") == 0);
    assert(strcmp(targets->items[1].text, "Target: gamma in lib/remote.c.") == 0);
    assert_brief_evidence_resolves(&multi_views.graph, &multi_views.brief);
    assert(item_count(&multi_views.brief) <= request.budget.max_items);
    assert_brief_json(&multi_views.brief, 0);
    context_views_free(&multi_views);

    index_free(index);
    puts("agent brief and UI graph view tests passed");
    return 0;
}
