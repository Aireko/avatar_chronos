/* From the repository root:
 * cc -std=c11 -Wall -Wextra -Werror -pedantic -Ibackend/include backend/src/index.c backend/src/graph.c backend/tests/test_index.c -o test_index
 * ./test_index
 */
#include "index.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static RepositoryIndex *build_fixture(void)
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
        {.revision = revision, .file_path = "payment.c", .language = "c", .source_length = 35,
         .symbols = &caller, .symbol_count = 1, .calls = calls, .call_count = 2},
        {.revision = revision, .file_path = "validation.c", .language = "c", .source_length = 30,
         .symbols = &callee, .symbol_count = 1}
    };
    const IndexFileInput inputs[] = {{&files[0], NULL}, {&files[1], NULL}};
    RepositoryIndex *index = NULL;
    assert(index_build(&revision, inputs, 2, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    return index;
}

int main(void)
{
    RepositoryIndex *index = build_fixture();
    RepositoryGraph graph = {0};
    IndexChangeSet changes = {0};
    assert(index_compare_revisions(index, index, NULL, &changes) == CHRONOS_NOT_IMPLEMENTED);
    assert(changes.items == NULL);
    assert(index_export_graph(index, &changes, &graph) == CHRONOS_NOT_IMPLEMENTED);
    assert(graph.nodes == NULL);
    index_change_set_free(&changes);

    assert(index_export_graph(index, NULL, &graph) == CHRONOS_OK);
    index_free(index);

    assert(graph.node_count == 2 && graph.edge_count == 2);
    assert(graph.comparison == NULL && graph.nodes[0].change == NULL);
    assert(strcmp(graph.nodes[0].ref.id, "[\"payment.c\",\"pay\",\"function\",\"definition\",0,35]") == 0);
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
    puts("single-revision index and graph smoke test passed");
    return 0;
}
