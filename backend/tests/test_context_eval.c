/*
 * Hand-labeled context compiler evaluation.
 *
 * Run: .build/test_context_eval [--write-golden]
 *
 * Covers onboarding, change impact, symbol review and the Chronos bridge
 * fixture. Golden JSON is byte-compared; semantic assertions check required
 * evidence, unresolved relationships, budgets and source-free graph payloads.
 */
#include "context_views.h"
#include "parser.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const RevisionRef REVISION = {
    "example/eval", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};

#define SYMBOL(id, name, start, end, line) \
    {id, 0, PARSER_FUNCTION, PARSER_DEFINITION, name, name, NULL, {start, end, line, line}}
#define CALL(symbol, name, start, end, line) \
    {symbol, name, {start, end, line, line}}

static const ParsedSymbol MAIN_SYMBOLS[] = {SYMBOL(1, "main", 0, 100, 1)};
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
static const ParsedSymbol REMOTE_SYMBOLS[] = {SYMBOL(1, "gamma", 0, 100, 1)};
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
static const ParsedSymbol TEST_SYMBOLS[] = {SYMBOL(1, "test_main", 0, 100, 1)};
static const ParsedCall TEST_CALLS[] = {CALL(1, "main", 10, 20, 1)};

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

static char *read_text(const char *path)
{
    FILE *file = fopen(path, "rb");
    assert(file != NULL);
    assert(fseek(file, 0, SEEK_END) == 0);
    long length = ftell(file);
    assert(length >= 0);
    assert(fseek(file, 0, SEEK_SET) == 0);
    char *text = malloc((size_t)length + 1);
    assert(text != NULL);
    assert(fread(text, 1, (size_t)length, file) == (size_t)length);
    text[length] = '\0';
    fclose(file);
    return text;
}

static void write_text(const char *path, const char *text)
{
    FILE *file = fopen(path, "wb");
    assert(file != NULL);
    size_t length = strlen(text);
    assert(fwrite(text, 1, length, file) == length);
    fclose(file);
}

static void golden_compare(const char *name, const char *text, int write_golden)
{
    char path[512];
    (void)snprintf(path, sizeof path, "tests/fixtures/context_eval/golden/%s", name);
    if (write_golden) {
        write_text(path, text);
        return;
    }
    char *expected = read_text(path);
    if (strcmp(expected, text) != 0) {
        fprintf(stderr, "golden mismatch: %s\n", name);
        assert(0);
    }
    free(expected);
}

static size_t estimate_tokens(size_t bytes)
{
    return (bytes + 3) / 4;
}

#define TASK_PROMPT_BYTES 256u

static size_t brief_prompt_bytes(const ContextBrief *brief)
{
    size_t total = 0;
    for (size_t i = 0; i < brief->section_count; ++i) {
        const ContextBriefSection *section = &brief->sections[i];
        total += strlen(section->id) + strlen(section->title) + 2;
        for (size_t j = 0; j < section->item_count; ++j) {
            total += strlen(section->items[j].text) + 2;
            for (size_t k = 0; k < section->items[j].evidence_count; ++k)
                total += strlen(section->items[j].evidence_ids[k]) + 1;
        }
    }
    for (size_t i = 0; i < brief->omitted_count; ++i)
        total += strlen(brief->omitted_ids[i]) + 1;
    return total;
}

static size_t baseline_bytes(const RepositoryIndex *index, const char *const *paths,
                             size_t count)
{
    size_t total = 0;
    for (size_t i = 0; i < count; ++i) {
        size_t length = 0;
        assert(index_file_bytes(index, paths[i], &length) != NULL);
        total += length;
    }
    return total;
}

static char *call_evidence_id(const RepositoryIndex *index, const char *caller_name,
                              const char *callee_text)
{
    size_t link_count = 0;
    const IndexCallLink *links = index_call_links(index, &link_count);
    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(index, &scope_count);
    for (size_t i = 0; i < link_count; ++i) {
        if (links[i].caller == INDEX_NO_SCOPE) continue;
        const GraphSymbol *caller = scopes[links[i].caller].symbol;
        if (caller == NULL || strcmp(caller->name, caller_name) != 0) continue;
        if (strcmp(links[i].call->callee_text, callee_text) != 0) continue;
        return context_call_evidence_id_alloc(links[i].call);
    }
    return NULL;
}

static int graph_has_evidence(const ContextGraph *graph, const char *id)
{
    for (size_t i = 0; i < graph->evidence_count; ++i)
        if (strcmp(graph->evidence[i].id, id) == 0) return 1;
    return 0;
}

static int brief_has_evidence(const ContextBrief *brief, const char *id)
{
    for (size_t i = 0; i < brief->section_count; ++i)
        for (size_t j = 0; j < brief->sections[i].item_count; ++j)
            for (size_t k = 0; k < brief->sections[i].items[j].evidence_count; ++k)
                if (strcmp(brief->sections[i].items[j].evidence_ids[k], id) == 0) return 1;
    return 0;
}

static int review_has_evidence(const ContextSelection *selection, const char *id)
{
    for (size_t i = 0; i < selection->selected_count; ++i)
        if (strcmp(selection->selected[i].candidate->id, id) == 0) return 1;
    return 0;
}

static size_t unresolved_edges(const ContextGraph *graph)
{
    size_t count = 0;
    for (size_t i = 0; i < graph->edge_count; ++i)
        if (graph->edges[i].state == CONTEXT_RELATION_UNRESOLVED ||
            graph->edges[i].state == CONTEXT_RELATION_AMBIGUOUS) ++count;
    return count;
}

typedef struct {
    const char *caller;
    const char *callee;
    int in_brief;
} RequiredCall;

static size_t retained_calls(const RepositoryIndex *index, const ContextGraph *graph,
                             const ContextBrief *brief, const RequiredCall *required,
                             size_t count)
{
    size_t retained = 0;
    for (size_t i = 0; i < count; ++i) {
        char *id = call_evidence_id(index, required[i].caller, required[i].callee);
        assert(id != NULL);
        if (graph_has_evidence(graph, id) &&
            (!required[i].in_brief || brief_has_evidence(brief, id)))
            ++retained;
        free(id);
    }
    return retained;
}

static char *serialize_brief(const ContextBrief *brief)
{
    int length = context_brief_write_json(brief, NULL, 0);
    assert(length > 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_brief_write_json(brief, json, (size_t)length + 1) == length);
    return json;
}

static char *serialize_graph(const ContextGraph *graph)
{
    int length = context_graph_write_json(graph, NULL, 0);
    assert(length > 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_graph_write_json(graph, json, (size_t)length + 1) == length);
    assert(strstr(json, "\"source\":") == NULL);
    return json;
}

static size_t count_items(const ContextBrief *brief)
{
    size_t count = 0;
    for (size_t i = 0; i < brief->section_count; ++i)
        count += brief->sections[i].item_count;
    return count;
}

static int brief_text_contains(const ContextBrief *brief, const char *needle)
{
    for (size_t i = 0; i < brief->section_count; ++i)
        for (size_t j = 0; j < brief->sections[i].item_count; ++j)
            if (strstr(brief->sections[i].items[j].text, needle) != NULL) return 1;
    return 0;
}

static int bridge_has(const ContextBridgeSet *set, ContextBridgeKind kind, const char *label)
{
    for (size_t i = 0; i < set->count; ++i)
        if (set->edges[i].kind == kind && strcmp(set->edges[i].label, label) == 0) return 1;
    return 0;
}

static char *read_fixture_file(const char *relative, size_t *length)
{
    char path[512];
    (void)snprintf(path, sizeof path, "tests/fixtures/context_flow/chronos_bridge/%s", relative);
    FILE *file = fopen(path, "rb");
    assert(file != NULL);
    assert(fseek(file, 0, SEEK_END) == 0);
    long size = ftell(file);
    assert(size >= 0);
    assert(fseek(file, 0, SEEK_SET) == 0);
    char *bytes = malloc((size_t)size + 1);
    assert(bytes != NULL);
    assert(fread(bytes, 1, (size_t)size, file) == (size_t)size);
    bytes[size] = '\0';
    fclose(file);
    *length = (size_t)size;
    return bytes;
}

static size_t evaluate_chronos_bridge(void)
{
    const char *paths[] = {
        "src/backend.ts", "src-tauri/src/lib.rs", "src-tauri/src/ffi.rs",
        "backend/src/avatar.c"
    };
    typedef struct {
        char *bytes;
        size_t length;
        ParsedFile parsed;
        GitBlob blob;
    } File;
    File files[4] = {0};
    IndexFileInput inputs[4] = {0};
    size_t baseline = 0;
    for (size_t i = 0; i < 4; ++i) {
        files[i].bytes = read_fixture_file(paths[i], &files[i].length);
        baseline += files[i].length;
        assert(parser_parse(paths[i], &REVISION, files[i].bytes, files[i].length,
                            &files[i].parsed) >= 0);
        files[i].blob = (GitBlob){
            REVISION, paths[i], (const unsigned char *)files[i].bytes, files[i].length
        };
        inputs[i] = (IndexFileInput){&files[i].parsed, &files[i].blob};
    }
    RepositoryIndex *index = NULL;
    assert(index_build(&REVISION, inputs, 4, CHRONOS_COMPLETE, &index) >= 0);
    ContextBridgeSet bridges = {0};
    assert(context_discover_bridges(index, &bridges) >= 0);
    const struct {
        ContextBridgeKind kind;
        const char *label;
    } required[] = {
        {CONTEXT_BRIDGE_INVOKE, "backend_version"},
        {CONTEXT_BRIDGE_REGISTRATION, "backend_version"},
        {CONTEXT_BRIDGE_DISPATCH, "version"},
        {CONTEXT_BRIDGE_FFI, "chronos_version"},
        {CONTEXT_BRIDGE_INVOKE, "export_graph"},
        {CONTEXT_BRIDGE_REGISTRATION, "export_graph"},
        {CONTEXT_BRIDGE_DISPATCH, "export_graph"},
        {CONTEXT_BRIDGE_FFI, "chronos_export_graph"}
    };
    size_t retained = 0;
    for (size_t i = 0; i < sizeof required / sizeof required[0]; ++i)
        if (bridge_has(&bridges, required[i].kind, required[i].label)) ++retained;
    for (size_t i = 0; i < bridges.count; ++i) {
        assert(bridges.edges[i].evidence_id != NULL);
        assert(bridges.edges[i].evidence_id[0] != '\0');
    }
    printf("eval chronos-bridge: retained=%zu/%zu unresolved=0 evidence=%zu baseline=%zu tokens\n",
           retained, sizeof required / sizeof required[0], bridges.count,
           estimate_tokens(baseline));
    context_bridge_set_free(&bridges);
    index_free(index);
    for (size_t i = 0; i < 4; ++i) {
        parser_free(&files[i].parsed);
        free(files[i].bytes);
    }
    return retained;
}

int main(int argc, char **argv)
{
    int write_golden = argc == 2 && strcmp(argv[1], "--write-golden") == 0;
    RepositoryIndex *index = build_index();

    const ContextFlowRequest onboarding = {
        .mode = CONTEXT_FLOW_ONBOARDING, .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    ContextViewsRequest request = {.flow = &onboarding, .budget = {12, 4096}};
    ContextViews views = {0};
    assert(context_build_views(index, &request, &views) == CHRONOS_OK);
    assert(views.graph.evidence == views.brief.evidence);
    assert(count_items(&views.brief) <= 12);
    assert(views.brief.used_source_bytes <= 4096);

    char *onboarding_brief = serialize_brief(&views.brief);
    char *onboarding_graph = serialize_graph(&views.graph);
    golden_compare("onboarding-brief.json", onboarding_brief, write_golden);
    golden_compare("onboarding-graph.json", onboarding_graph, write_golden);

    const RequiredCall onboarding_required[] = {
        {"main", "alpha", 1},
        {"main", "missing", 0},
        {"beta", "gamma", 1}
    };
    size_t onboarding_retained = retained_calls(index, &views.graph, &views.brief,
                                                onboarding_required,
                                                sizeof onboarding_required /
                                                    sizeof onboarding_required[0]);
    assert(onboarding_retained == 3);
    assert(unresolved_edges(&views.graph) == 1);
    const char *all_files[] = {
        "app/main.c", "app/core.c", "lib/remote.c", "app/util.c", "tests/test_main.c"
    };
    size_t onboarding_baseline = baseline_bytes(index, all_files, 5);
    assert(estimate_tokens(brief_prompt_bytes(&views.brief)) <
           estimate_tokens(onboarding_baseline + TASK_PROMPT_BYTES));
    printf("eval onboarding: compiler=%zu tokens baseline=%zu tokens retained=%zu/3 unresolved=%zu\n",
           estimate_tokens(brief_prompt_bytes(&views.brief)),
           estimate_tokens(onboarding_baseline + TASK_PROMPT_BYTES),
           onboarding_retained, unresolved_edges(&views.graph));
    free(onboarding_brief);
    free(onboarding_graph);
    context_views_free(&views);

    SymbolVersionRef gamma_ref;
    assert(find_symbol(index, "gamma", &gamma_ref));
    const ContextFlowSeed gamma_seed = {CONTEXT_FLOW_SEED_CHANGED_SYMBOL, &gamma_ref, NULL};
    const ContextFlowRequest change = {
        .mode = CONTEXT_FLOW_TASK, .seeds = &gamma_seed, .seed_count = 1,
        .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    request = (ContextViewsRequest){&change, {12, 4096}};
    ContextViews change_views = {0};
    assert(context_build_views(index, &request, &change_views) == CHRONOS_OK);
    char *change_brief = serialize_brief(&change_views.brief);
    char *change_graph = serialize_graph(&change_views.graph);
    golden_compare("change-brief.json", change_brief, write_golden);
    golden_compare("change-graph.json", change_graph, write_golden);

    char *gamma_source = context_symbol_evidence_id_alloc(&gamma_ref);
    assert(gamma_source != NULL);
    size_t change_retained = brief_has_evidence(&change_views.brief, gamma_source) ? 1 : 0;
    free(gamma_source);
    const RequiredCall change_required[] = {
        {"beta", "gamma", 1},
        {"gamma", "alpha", 0},
        {"gamma", "helper", 0}
    };
    change_retained += retained_calls(index, &change_views.graph, &change_views.brief,
                                      change_required,
                                      sizeof change_required / sizeof change_required[0]);
    assert(change_retained == 4);
    assert(unresolved_edges(&change_views.graph) == 1);
    const char *change_files[] = {"lib/remote.c", "app/core.c", "app/util.c"};
    size_t change_baseline = baseline_bytes(index, change_files, 3);
    assert(estimate_tokens(brief_prompt_bytes(&change_views.brief)) <
           estimate_tokens(change_baseline + TASK_PROMPT_BYTES));
    printf("eval change-impact: compiler=%zu tokens baseline=%zu tokens retained=%zu/4 unresolved=%zu\n",
           estimate_tokens(brief_prompt_bytes(&change_views.brief)),
           estimate_tokens(change_baseline + TASK_PROMPT_BYTES),
           change_retained, unresolved_edges(&change_views.graph));
    free(change_brief);
    free(change_graph);
    context_views_free(&change_views);

    SymbolVersionRef main_ref;
    assert(find_symbol(index, "main", &main_ref));
    const ContextFlowSeed multi_seeds[] = {
        {CONTEXT_FLOW_SEED_SYMBOL, &main_ref, NULL},
        {CONTEXT_FLOW_SEED_SYMBOL, &gamma_ref, NULL}
    };
    const ContextFlowRequest multi_flow = {
        .mode = CONTEXT_FLOW_TASK, .seeds = multi_seeds, .seed_count = 2,
        .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    ContextViewsRequest multi_request = {&multi_flow, {12, 4096}};
    ContextViews multi_views = {0};
    assert(context_build_views(index, &multi_request, &multi_views) == CHRONOS_OK);
    assert(multi_views.graph.evidence == multi_views.brief.evidence);
    assert(count_items(&multi_views.brief) <= 12);
    assert(multi_views.brief.used_source_bytes <= 4096);
    assert(brief_text_contains(&multi_views.brief, "Target: main in app/main.c."));
    assert(brief_text_contains(&multi_views.brief, "Target: gamma in lib/remote.c."));
    char *multi_brief = serialize_brief(&multi_views.brief);
    char *multi_graph = serialize_graph(&multi_views.graph);
    golden_compare("multi-brief.json", multi_brief, write_golden);
    golden_compare("multi-graph.json", multi_graph, write_golden);
    const RequiredCall multi_required[] = {
        {"main", "alpha", 1},
        {"beta", "gamma", 1},
        {"main", "missing", 0}
    };
    size_t multi_retained = retained_calls(index, &multi_views.graph, &multi_views.brief,
                                           multi_required,
                                           sizeof multi_required / sizeof multi_required[0]);
    assert(multi_retained == 3);
    assert(unresolved_edges(&multi_views.graph) == 1);
    assert(estimate_tokens(brief_prompt_bytes(&multi_views.brief)) <
           estimate_tokens(onboarding_baseline + TASK_PROMPT_BYTES));
    printf("eval multi-symbol: compiler=%zu tokens baseline=%zu tokens retained=%zu/3 unresolved=%zu targets=2\n",
           estimate_tokens(brief_prompt_bytes(&multi_views.brief)),
           estimate_tokens(onboarding_baseline + TASK_PROMPT_BYTES),
           multi_retained, unresolved_edges(&multi_views.graph));
    free(multi_brief);
    free(multi_graph);
    context_views_free(&multi_views);

    IndexContext context = {0};
    assert(index_collect_context(index, &gamma_ref, &context) == CHRONOS_OK);
    ContextRanking ranking = {0};
    assert(context_rank_candidates(&context.candidates, &ranking) >= 0);
    const ContextBudget review_budget = {8, 4096};
    ContextSelection selection = {0};
    assert(context_select(&ranking, &review_budget, &selection) >= 0);
    const ReviewContext review = {
        .target = gamma_ref,
        .comparison = NULL,
        .previous = {CONTEXT_SOURCE_UNAVAILABLE, NULL, NULL, 0},
        .current = context.target_source,
        .budget = review_budget,
        .evidence = selection,
        .diagnostics = NULL,
        .diagnostic_count = 0
    };
    int review_length = context_write_json(&review, NULL, 0);
    assert(review_length > 0);
    char *review_json = malloc((size_t)review_length + 1);
    assert(review_json != NULL);
    assert(context_write_json(&review, review_json, (size_t)review_length + 1) == review_length);
    golden_compare("review-context.json", review_json, write_golden);

    const RequiredCall review_required[] = {
        {"beta", "gamma", 0},
        {"gamma", "alpha", 0},
        {"gamma", "helper", 0}
    };
    size_t review_retained = 0;
    for (size_t i = 0; i < sizeof review_required / sizeof review_required[0]; ++i) {
        char *id = call_evidence_id(index, review_required[i].caller,
                                    review_required[i].callee);
        assert(id != NULL);
        if (review_has_evidence(&selection, id)) ++review_retained;
        free(id);
    }
    assert(review_retained == 3);
    assert(estimate_tokens(strlen(review_json)) <
           estimate_tokens(change_baseline + TASK_PROMPT_BYTES));
    printf("eval symbol-review: compiler=%zu tokens baseline=%zu tokens retained=%zu/3 unresolved=0\n",
           estimate_tokens(strlen(review_json)),
           estimate_tokens(change_baseline + TASK_PROMPT_BYTES),
           review_retained);

    free(review_json);
    context_selection_free(&selection);
    context_ranking_free(&ranking);
    index_context_free(&context);
    index_free(index);

    size_t bridge_retained = evaluate_chronos_bridge();
    assert(bridge_retained == 8);

    if (write_golden) puts("context evaluation golden files written");
    else puts("context evaluation golden and semantic checks passed");
    return 0;
}
