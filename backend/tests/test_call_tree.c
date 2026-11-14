/* Run with: sh tests/run_call_tree_test.sh .build/test_call_tree */
#include "avatar.h"
#include "index.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static size_t count_of(const char *text, const char *needle)
{
    size_t count = 0, length = strlen(needle);
    for (const char *at = strstr(text, needle); at; at = strstr(at + length, needle)) ++count;
    return count;
}

static char *tree(const char *repo, const char *path, const char *name, size_t depth, size_t nodes)
{
    char *json = NULL;
    int status = chronos_call_tree(repo, "HEAD", path, name, depth, nodes, &json);
    assert(status >= 0);
    assert(json != NULL);
    return json;
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    const char *repo = argv[1];
    char *json;

    /* mid() is called by top() and calls leaf() twice: one folded edge. */
    json = tree(repo, "graph.c", "mid", 0, 0);
    assert(strstr(json, "\"status\":\"ok\"") != NULL);
    assert(strstr(json, "\"root\":\"n0\"") != NULL);
    assert(strstr(json, "\"truncated\":false") != NULL);
    assert(count_of(json, "\"side\":\"caller\"") >= 1);
    assert(strstr(json, "\"name\":\"top\"") != NULL);
    assert(strstr(json, "\"name\":\"leaf\"") != NULL);
    assert(strstr(json, "\"callCount\":2") != NULL);
    assert(strstr(json, "\"startByte\":") != NULL);
    chronos_free_string(json);

    /* Unresolved calls stay in the tree as edges without a target. */
    json = tree(repo, "graph.c", "top", 0, 0);
    assert(strstr(json, "\"state\":\"unresolved\"") != NULL);
    assert(strstr(json, "\"calleeText\":\"missing\"") != NULL);
    assert(strstr(json, "\"to\":null") != NULL);
    chronos_free_string(json);

    /* A depth of one leaves leaf() out and says that mid() has more. */
    json = tree(repo, "graph.c", "top", 1, 0);
    assert(strstr(json, "\"name\":\"mid\"") != NULL);
    assert(strstr(json, "\"name\":\"leaf\"") == NULL);
    assert(strstr(json, "\"hasMore\":true") != NULL);
    assert(strstr(json, "\"truncated\":true") != NULL);
    chronos_free_string(json);

    /* Mutual recursion: loop_b is both a caller and a callee of loop_a. */
    json = tree(repo, "graph.c", "loop_a", 0, 0);
    assert(count_of(json, "\"name\":\"loop_b\"") == 2);
    assert(count_of(json, "\"name\":\"loop_a\"") == 1);
    chronos_free_string(json);

    /* A self-call is one edge from the root to itself. */
    json = tree(repo, "graph.c", "fact", 0, 0);
    assert(strstr(json, "\"from\":\"n0\",\"to\":\"n0\"") != NULL);
    assert(count_of(json, "\"to\":\"n0\"") == 1);
    chronos_free_string(json);

    /* A short name shared by two methods is ambiguous; a qualified name or a line is not. */
    json = tree(repo, "multi.ts", "run", 0, 0);
    assert(strstr(json, "\"status\":\"ambiguous\"") != NULL);
    assert(strstr(json, "\"qualifiedName\":\"A::run\"") != NULL);
    assert(strstr(json, "\"qualifiedName\":\"B::run\"") != NULL);
    chronos_free_string(json);
    json = tree(repo, "multi.ts", "A::run", 0, 0);
    assert(strstr(json, "\"status\":\"ok\"") != NULL);
    chronos_free_string(json);
    json = tree(repo, "multi.ts", "run#2", 0, 0);
    assert(strstr(json, "\"status\":\"ok\"") != NULL);
    assert(strstr(json, "\"qualifiedName\":\"B::run\"") != NULL);
    chronos_free_string(json);

    /* Unknown names and unsupported files are successful, empty answers. */
    json = tree(repo, "graph.c", "nope", 0, 0);
    assert(strstr(json, "\"status\":\"not_found\"") != NULL);
    chronos_free_string(json);
    json = tree(repo, "notes.txt", "mid", 0, 0);
    assert(strstr(json, "\"status\":\"not_found\"") != NULL);
    chronos_free_string(json);

    /* The index is built once per commit, however many trees are asked for. */
    size_t builds = index_build_count();
    json = tree(repo, "graph.c", "leaf", 0, 0);
    chronos_free_string(json);
    json = tree(repo, "graph.c", "mid", 0, 0);
    chronos_free_string(json);
    assert(index_build_count() == builds);

    /* Bad input is an error and leaves no output. */
    json = NULL;
    assert(chronos_call_tree(repo, "HEAD", "graph.c", "", 0, 0, &json) < 0);
    assert(json == NULL);
    assert(chronos_call_tree(repo, "HEAD", "../outside.c", "mid", 0, 0, &json) < 0);
    assert(json == NULL);
    assert(chronos_call_tree(repo, "-evil", "graph.c", "mid", 0, 0, &json) < 0);
    assert(json == NULL);
    assert(chronos_call_tree("/no/such/repository", "HEAD", "graph.c", "mid", 0, 0, &json) < 0);
    assert(json == NULL);

    printf("call tree tests passed\n");
    return 0;
}
