/*
 * Standalone C tests for backend/src (no git needed). From the repo root:
 *
 *   cl /nologo /std:c11 /W4 /Ibackend\include backend\src\*.c backend\tests\test_avatar.c /Fe:build\test_avatar.exe /Fo:build\
 *   gcc -std=c11 -Wall -Wextra -Ibackend/include backend/src/avatar.c backend/src/mapper.c backend/tests/test_avatar.c -o build/test_avatar
 *
 * Git-backed behaviour is covered by `npm test` (src-tauri/src/ffi.rs).
 */
#include "avatar.h"
#include "mapper.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

#define CHECK(cond)                                                                  \
    do {                                                                             \
        if (!(cond)) {                                                               \
            fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                              \
        }                                                                            \
    } while (0)

static void test_chronos_version(void)
{
    CHECK(chronos_version() != NULL);
    CHECK(strncmp(chronos_version(), "chronos-backend", 15) == 0);
}

static void test_chronos_argument_validation(void)
{
    char* result;

    CHECK(chronos_export_graph("some/repo", NULL, 0) == AVATAR_ERR_ARGS);
    CHECK(chronos_export_graph("some/repo", "", 0) == AVATAR_ERR_ARGS);
    CHECK(chronos_export_graph("", "out.json", 0) == AVATAR_ERR_ARGS);
    CHECK(strlen(chronos_last_error()) > 0);

    CHECK(chronos_analyze_merge(".", "-evil", "main", "out.json") == AVATAR_ERR_ARGS);
    CHECK(chronos_analyze_merge(".", "feature", "a..b", "out.json") == AVATAR_ERR_ARGS);
    CHECK(chronos_analyze_merge(".", "feature", "main", NULL) == AVATAR_ERR_ARGS);

    result = chronos_run_git_cmd("", "status", NULL);
    CHECK(result != NULL);
    if (result != NULL) {
        CHECK(strstr(result, "\"ok\":false") != NULL);
        CHECK(strstr(result, "\"error\":\"repo_path is empty\"") != NULL);
        chronos_free_string(result);
    }
}

static void test_graph_write_json(void)
{
    RevisionRef rev;
    GraphSymbol node;
    RepositoryGraph graph;
    char* buf;
    int needed;

    rev.repository_id = "repo-1";
    rev.commit_sha = "0123456789abcdef0123456789abcdef01234567";

    memset(&node, 0, sizeof node);
    node.ref.revision = rev;
    node.ref.id = "[\"math.c\",\"alpha\",\"function\",\"definition\",0,40]";
    node.logical_id = "[\"math.c\",\"alpha\"]";
    node.name = "alpha";
    node.qualified_name = "alpha";
    node.language = "c";
    node.kind = PARSER_FUNCTION;
    node.form = PARSER_DEFINITION;
    node.location.revision = rev;
    node.location.file_path = "math.c";
    node.location.range.start_byte = 0;
    node.location.range.end_byte = 40;
    node.location.range.start_line = 1;
    node.location.range.end_line = 5;

    memset(&graph, 0, sizeof graph);
    graph.revision = rev;
    graph.nodes = &node;
    graph.node_count = 1;
    graph.node_coverage = CHRONOS_COMPLETE;
    graph.edge_coverage = CHRONOS_UNAVAILABLE;

    needed = graph_write_json(&graph, NULL, 0);
    CHECK(needed > 0);
    if (needed <= 0) return;

    buf = (char*)malloc((size_t)needed + 1);
    if (buf == NULL) { failures++; return; }
    CHECK(graph_write_json(&graph, buf, (size_t)needed + 1) == needed);
    CHECK(strlen(buf) == (size_t)needed);
    CHECK(strstr(buf, "\"schemaVersion\":1") != NULL);
    CHECK(strstr(buf, "\"repositoryId\":\"repo-1\"") != NULL);
    CHECK(strstr(buf, "\"kind\":\"function\"") != NULL);
    CHECK(strstr(buf, "\"form\":\"definition\"") != NULL);
    CHECK(strstr(buf, "\"change\":null") != NULL);
    CHECK(strstr(buf, "\"edges\":{\"status\":\"unavailable\",\"items\":null}") != NULL);
    CHECK(strstr(buf, "\\\"math.c\\\"") != NULL); /* quotes inside ids are escaped */
    free(buf);

    graph.nodes = NULL; /* count 1 with no array is invalid */
    CHECK(graph_write_json(&graph, NULL, 0) == CHRONOS_INVALID_ARGUMENT);
}

int main(void)
{
    test_chronos_version();
    test_chronos_argument_validation();
    test_graph_write_json();

    if (failures != 0) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("all C backend tests passed\n");
    return 0;
}