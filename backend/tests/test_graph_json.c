/* From the repository root:
 * cc -std=c11 -Wall -Wextra -Werror -pedantic -Ibackend/include backend/src/graph.c backend/tests/test_graph_json.c -o test_graph_json
 * ./test_graph_json
 */
#include "graph.h"

#include <assert.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *serialize(const RepositoryGraph *graph)
{
    char tiny[] = "guard";
    int length = graph_write_json(graph, NULL, 0);
    assert(length > 0);
    assert(graph_write_json(graph, tiny, sizeof tiny) == length);
    assert(strcmp(tiny, "guard") == 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    memset(json, '!', (size_t)length + 1);
    assert(graph_write_json(graph, json, (size_t)length) == length);
    assert(json[0] == '!' && json[length] == '!');
    assert(graph_write_json(graph, json, (size_t)length + 1) == length);
    assert(strlen(json) == (size_t)length);
    return json;
}

int main(void)
{
    const RevisionRef rev = {"caf\xc3\xa9", "0123456789abcdef0123456789abcdef01234567"};
    const GraphComparison comparison = {
        {"caf\xc3\xa9", "1123456789abcdef0123456789abcdef01234567"}, rev
    };
    const SourceLocation loc = {rev, "src/\"a\\b.c", {0, 3, 1, 1}};
    const SymbolChangeKind change = SYMBOL_MODIFIED;
    GraphSymbol nodes[] = {
        {.ref = {rev, "a"}, .logical_id = "[\"a\"]", .name = "caller", .qualified_name = "caller",
         .language = "c", .kind = PARSER_FUNCTION, .form = PARSER_DEFINITION, .location = loc, .change = &change},
        {.ref = {rev, "b"}, .name = "callee", .qualified_name = "caller::callee",
         .language = "c", .kind = PARSER_METHOD, .form = PARSER_DECLARATION, .location = loc}
    };
    nodes[1].parent = &nodes[0].ref;
    const SymbolVersionRef candidates[] = {nodes[0].ref, nodes[1].ref};
    GraphCall calls[] = {
        {nodes[0].ref, "callee", loc, CALL_RESOLVED, &nodes[1].ref, NULL, 0},
        {nodes[0].ref, "missing", loc, CALL_UNRESOLVED, NULL, NULL, 0},
        {nodes[0].ref, "overloaded", loc, CALL_AMBIGUOUS, NULL, candidates, 2}
    };
    const ChronosDiagnostic diagnostics[] = {
        {"test", DIAGNOSTIC_WARNING, "quote\" slash\\\n\r\t\b\f\x01", NULL}
    };
    RepositoryGraph graph = {rev, &comparison, nodes, 2, CHRONOS_COMPLETE, calls, 3,
                             CHRONOS_INCOMPLETE, diagnostics, 1};
    char *json = serialize(&graph);
    assert(strstr(json, "\"schemaVersion\":1,\"repositoryId\":\"caf\xc3\xa9\"") != NULL);
    assert(strstr(json, "\"comparison\":{\"base\":{") != NULL);
    assert(strstr(json, "\"nodes\":{\"status\":\"complete\",\"items\":[{") != NULL);
    assert(strstr(json, "\"edges\":{\"status\":\"incomplete\",\"items\":[{") != NULL);
    assert(strstr(json, "\"filePath\":\"src/\\\"a\\\\b.c\"") != NULL);
    assert(strstr(json, "\"range\":{\"startByte\":0,\"endByte\":3,\"startLine\":1,\"endLine\":1}") != NULL);
    assert(strstr(json, "\"change\":\"modified\"") != NULL);
    assert(strstr(json, "\"change\":null") != NULL);
    assert(strstr(json, "\"resolution\":\"resolved\",\"callee\":{") != NULL);
    assert(strstr(json, "\"resolution\":\"unresolved\",\"callee\":null,\"candidates\":[]") != NULL);
    assert(strstr(json, "\"resolution\":\"ambiguous\",\"callee\":null,\"candidates\":[{") != NULL);
    assert(strstr(json, "\"message\":\"quote\\\" slash\\\\\\n\\r\\t\\b\\f\\u0001\",\"location\":null") != NULL);
    free(json);
    const RepositoryGraph empty = {
        .revision = rev, .node_coverage = CHRONOS_COMPLETE, .edge_coverage = CHRONOS_UNAVAILABLE
    };
    json = serialize(&empty);
    assert(strcmp(json, "{\"schemaVersion\":1,\"repositoryId\":\"caf\xc3\xa9\","
                        "\"revision\":{\"repositoryId\":\"caf\xc3\xa9\","
                        "\"commitSha\":\"0123456789abcdef0123456789abcdef01234567\"},"
                        "\"comparison\":null,\"nodes\":{\"status\":\"complete\",\"items\":[]},"
                        "\"edges\":{\"status\":\"unavailable\",\"items\":null},\"diagnostics\":[]}") == 0);
    free(json);
    char guard[] = "guard";
    assert(graph_write_json(NULL, guard, sizeof guard) == CHRONOS_INVALID_ARGUMENT);
    assert(graph_write_json(&graph, NULL, 1) == CHRONOS_INVALID_ARGUMENT);
    graph.node_coverage = CHRONOS_UNAVAILABLE;
    assert(graph_write_json(&graph, guard, sizeof guard) == CHRONOS_INVALID_ARGUMENT);
    graph.node_coverage = (ChronosCoverage)99;
    assert(graph_write_json(&graph, guard, sizeof guard) == CHRONOS_INVALID_ARGUMENT);
    graph.node_coverage = CHRONOS_COMPLETE;
    calls[0].callee = NULL;
    assert(graph_write_json(&graph, guard, sizeof guard) == CHRONOS_INVALID_ARGUMENT);
    calls[0].callee = &nodes[1].ref;
    calls[2].candidate_count = 1;
    assert(graph_write_json(&graph, guard, sizeof guard) == CHRONOS_INVALID_ARGUMENT);
    calls[2].candidate_count = 2;
    nodes[0].location.range.start_line = 0;
    assert(graph_write_json(&graph, guard, sizeof guard) == CHRONOS_INVALID_ARGUMENT);
    nodes[0].location.range.start_line = 1;
#if SIZE_MAX > 9007199254740991ULL
    nodes[0].location.range.end_byte = (size_t)9007199254740992ULL;
    assert(graph_write_json(&graph, guard, sizeof guard) == CHRONOS_TOO_LARGE);
#endif
    assert(strcmp(guard, "guard") == 0);
    puts("graph JSON tests passed");
    return 0;
}
