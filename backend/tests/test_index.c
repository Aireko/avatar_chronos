/* From the repository root:
 * cc -std=c11 -Wall -Wextra -Werror -pedantic -Ibackend/include backend/src/index.c backend/src/mapper.c backend/tests/test_index.c -o test_index
 * ./test_index
 */
#include "index.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static RepositoryIndex *build_fixture(ChronosCoverage coverage)
{
    const RevisionRef revision = {"example/payments", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"};
    const ParsedSymbol caller = {
        1, 0, PARSER_FUNCTION, PARSER_DEFINITION, "pay", "pay", NULL, {0, 35, 1, 1}
    };
    const ParsedSymbol callee = {
        1, 0, PARSER_FUNCTION, PARSER_DEFINITION, "validate", "validate", NULL, {0, 30, 1, 1}
    };
    const ParsedCall calls[] = {{1, "validate", {16, 26, 1, 1}}, {1, "missing", {27, 34, 1, 1}}};
    const ParsedFile files[] = {
        {.revision = revision, .file_path = "payments/payment.c", .language = "c", .source_length = 35,
         .symbols = &caller, .symbol_count = 1, .calls = calls, .call_count = 2},
        {.revision = revision, .file_path = "shared/checks/validation.c", .language = "c", .source_length = 30,
         .symbols = &callee, .symbol_count = 1}
    };
    static const unsigned char code[35] = "int pay() { return validate(); }";
    const GitBlob blob = {revision, files[0].file_path, code, sizeof code};
    const IndexFileInput inputs[] = {{&files[0], &blob}, {&files[1], NULL}};
    RepositoryIndex *index = NULL;
    assert(index_build(&revision, inputs, 2, coverage, &index) ==
           (coverage == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL));
    return index;
}

int main(void)
{
    RepositoryIndex *index = build_fixture(CHRONOS_COMPLETE);
    RepositoryGraph graph = {0};
    IndexChangeSet changes = {0};
    assert(index_compare_revisions(index, index, NULL, &changes) == CHRONOS_PARTIAL);
    assert(changes.count == 2 && *changes.items[0].kind == SYMBOL_UNCHANGED);
    assert(changes.items[1].match == INDEX_MATCHED && changes.items[1].kind == NULL);
    assert(index_export_graph(index, &changes, &graph) == CHRONOS_OK);
    index_change_set_free(&changes);
    assert(graph.comparison && *graph.nodes[0].change == SYMBOL_UNCHANGED);
    index_graph_free(&graph);

    assert(index_export_graph(index, NULL, &graph) == CHRONOS_OK);
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    size_t caller = index_find_symbol(index, &graph.nodes[0].ref);
    size_t callee = index_find_symbol(index, &graph.nodes[1].ref);
    assert(count == 8 && scopes[0].kind == INDEX_PROJECT);
    size_t from_file = scopes[caller].parent, to_file = scopes[callee].parent;
    assert(scopes[from_file].kind == INDEX_FILE && scopes[to_file].kind == INDEX_FILE);
    size_t from_module = scopes[from_file].parent, to_module = scopes[to_file].parent;
    assert(strcmp(scopes[to_module].path, "shared/checks") == 0);
    assert(strcmp(scopes[scopes[to_module].parent].path, "shared") == 0);
    const size_t from[] = {0, from_module, from_file, caller};
    const size_t to[] = {0, to_module, to_file, callee};
    for (size_t i = 0; i < 4; ++i) {
        for (size_t j = 0; j < 4; ++j) {
            IndexCallMap map = {0};
            assert(index_map_calls(index, from[i], to[j], &map) == CHRONOS_OK);
            assert(map.count == 1 && map.links[0].caller == caller && map.links[0].callee == callee);
            index_call_map_free(&map);
        }
    }
    IndexContext context = {0};
    assert(index_collect_context(index, &graph.nodes[1].ref, &context) == CHRONOS_OK);
    assert(context.candidates.count == 1 && context.candidates.items[0].direction == CONTEXT_INCOMING_CALL);
    assert(context.candidates.items[0].snippet.status == CONTEXT_SOURCE_PRESENT);
    index_context_free(&context);
    assert(index_collect_context(index, &graph.nodes[0].ref, &context) == CHRONOS_OK);
    assert(context.candidates.count == 2 && context.target_source.byte_count == 35);
    assert(context.candidates.items[1].call->resolution == CALL_UNRESOLVED);
    index_context_free(&context);
    index_free(index);

    assert(graph.node_count == 2 && graph.edge_count == 2);
    assert(graph.comparison == NULL && graph.nodes[0].change == NULL);
    assert(strcmp(graph.nodes[0].ref.id, "[\"payments/payment.c\",\"pay\",\"function\",\"definition\",0,35]") == 0);
    assert(graph.edges[0].resolution == CALL_RESOLVED);
    assert(strcmp(graph.edges[0].caller.id, graph.nodes[0].ref.id) == 0);
    assert(strcmp(graph.edges[0].callee->id, graph.nodes[1].ref.id) == 0);
    assert(graph.edges[1].resolution == CALL_UNRESOLVED && graph.edges[1].callee == NULL);

    int length = graph_write_json(&graph, NULL, 0);
    assert(length > 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(graph_write_json(&graph, json, (size_t)length + 1) == length);
    assert(strstr(json, "\"resolution\":\"resolved\"") != NULL);
    assert(strstr(json, "\"resolution\":\"unresolved\"") != NULL);
    free(json);
    index_graph_free(&graph);
    index = build_fixture(CHRONOS_INCOMPLETE);
    assert(index_export_graph(index, NULL, &graph) == CHRONOS_PARTIAL);
    assert(graph.edge_coverage == CHRONOS_INCOMPLETE && graph.edges[0].resolution == CALL_RESOLVED);
    index_graph_free(&graph);
    index_free(index);
    puts("single-revision index and graph smoke test passed");
    return 0;
}