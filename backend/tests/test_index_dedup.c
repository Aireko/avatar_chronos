#include "index.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const char CODE[] =
    "int helper(void) { return 1; }\n"
    "int work(void) { return helper() + helper(); }\n";

static const ParsedSymbol SYMBOLS[] = {
    {1, 0, PARSER_FUNCTION, PARSER_DEFINITION, "helper", "helper", NULL, {0, 30, 1, 1}},
    {2, 0, PARSER_FUNCTION, PARSER_DEFINITION, "work", "work", NULL, {31, 77, 2, 2}}
};

static const ParsedCall CALLS[] = {
    {2, "helper", {55, 63, 2, 2}},
    {2, "helper", {66, 74, 2, 2}}
};

static RepositoryIndex *build(int with_blob)
{
    const RevisionRef revision = {
        "example/dedup", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    };
    const ParsedFile file = {
        .revision = revision,
        .file_path = "a.c",
        .language = "c",
        .source_length = sizeof CODE - 1,
        .symbols = SYMBOLS,
        .symbol_count = sizeof SYMBOLS / sizeof SYMBOLS[0],
        .calls = CALLS,
        .call_count = sizeof CALLS / sizeof CALLS[0],
        .coverage = CHRONOS_COMPLETE
    };
    const GitBlob blob = {
        revision, "a.c", (const unsigned char *)CODE, sizeof CODE - 1
    };
    const IndexFileInput input = {&file, with_blob ? &blob : NULL};
    RepositoryIndex *index = NULL;
    assert(index_build(&revision, &input, 1, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    return index;
}

static const GraphSymbol *find_work(const RepositoryGraph *graph)
{
    for (size_t i = 0; i < graph->node_count; ++i)
        if (strcmp(graph->nodes[i].qualified_name, "work") == 0) return &graph->nodes[i];
    return NULL;
}

int main(void)
{
    RepositoryIndex *index = build(1);
    RepositoryGraph graph = {0};
    assert(index_export_graph(index, NULL, &graph) == CHRONOS_OK);
    const GraphSymbol *work = find_work(&graph);
    assert(work != NULL);

    IndexContext context = {0};
    assert(index_collect_context(index, &work->ref, &context) == CHRONOS_OK);
    assert(context.target_source.status == CONTEXT_SOURCE_PRESENT);
    assert(context.candidates.count == 1);
    const ContextCandidate *candidate = &context.candidates.items[0];
    assert(candidate->direction == CONTEXT_OUTGOING_CALL);
    assert(candidate->call->resolution == CALL_RESOLVED);
    assert(candidate->snippet.status == CONTEXT_SOURCE_PRESENT);
    assert(candidate->snippet.byte_count == 30);
    assert(memcmp(candidate->snippet.bytes, CODE, 30) == 0);
    index_context_free(&context);
    index_graph_free(&graph);
    index_free(index);

    index = build(0);
    assert(index_export_graph(index, NULL, &graph) == CHRONOS_OK);
    work = find_work(&graph);
    assert(work != NULL);
    assert(index_collect_context(index, &work->ref, &context) == CHRONOS_OK);
    assert(context.target_source.status == CONTEXT_SOURCE_UNAVAILABLE);
    assert(context.candidates.count == 2);
    for (size_t i = 0; i < context.candidates.count; ++i)
        assert(context.candidates.items[i].snippet.status == CONTEXT_SOURCE_UNAVAILABLE);
    index_context_free(&context);
    index_graph_free(&graph);
    index_free(index);

    puts("index snippet deduplication and missing-source tests passed");
    return 0;
}
