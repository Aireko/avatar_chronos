#include "index.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const RevisionRef revision = {"example/java", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"};

static const char service_source[] =
    "package com.example;\n"
    "import com.example.util.Helper;\n"
    "import static com.example.util.Util.help;\n"
    "public class Service {\n"
    "    public int run() {\n"
    "        int a = local();\n"
    "        int b = Helper.work();\n"
    "        int c = help();\n"
    "        int d = com.example.util.Util.help();\n"
    "        int e = duplicate();\n"
    "        int f = other.missing();\n"
    "        return a + b + c + d + e + f;\n"
    "    }\n"
    "    private int local() { return 1; }\n"
    "}\n";
static const char helper_source[] =
    "package com.example.util;\n"
    "public class Helper {\n"
    "    public static int work() { return 2; }\n"
    "}\n";
static const char util_source[] =
    "package com.example.util;\n"
    "public class Util {\n"
    "    public static int help() { return 3; }\n"
    "}\n";
static const char other_source[] =
    "package com.example;\n"
    "public class Other {\n"
    "    public int local() { return 4; }\n"
    "    public int work() { return 5; }\n"
    "    public int duplicate() { return 6; }\n"
    "}\n";
static const char second_source[] =
    "package com.example;\n"
    "public class Second {\n"
    "    public int duplicate() { return 7; }\n"
    "}\n";

static const GraphCall *find_call(const RepositoryGraph *graph, const char *text)
{
    for (size_t i = 0; i < graph->edge_count; ++i)
        if (strcmp(graph->edges[i].callee_text, text) == 0) return &graph->edges[i];
    return NULL;
}

static const char *symbol_name(const RepositoryIndex *index, const SymbolVersionRef *ref)
{
    size_t scope = index_find_symbol(index, ref);
    if (scope == INDEX_NO_SCOPE) return NULL;
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    assert(scope < count && scopes[scope].symbol != NULL);
    return scopes[scope].symbol->qualified_name;
}

int main(void)
{
    const char *paths[] = {
        "src/com/example/Service.java",
        "src/com/example/util/Helper.java",
        "src/com/example/util/Util.java",
        "src/com/example/Other.java",
        "src/com/example/Second.java"
    };
    const char *sources[] = {
        service_source, helper_source, util_source, other_source, second_source
    };
    enum { file_count = sizeof paths / sizeof paths[0] };
    ParsedFile parsed[file_count] = {0};
    IndexFileInput inputs[file_count];
    for (size_t i = 0; i < file_count; ++i) {
        assert(parser_parse(paths[i], &revision, sources[i], strlen(sources[i]), &parsed[i]) ==
               CHRONOS_OK);
        inputs[i] = (IndexFileInput){&parsed[i], NULL};
    }
    RepositoryIndex *index = NULL;
    assert(index_build(&revision, inputs, file_count, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    for (size_t i = 0; i < file_count; ++i) parser_free(&parsed[i]);

    RepositoryGraph graph = {0};
    assert(index_export_graph(index, NULL, &graph) == CHRONOS_OK);

    const GraphCall *local = find_call(&graph, "local");
    assert(local && local->resolution == CALL_RESOLVED);
    assert(strcmp(symbol_name(index, local->callee), "Service::local") == 0);

    const GraphCall *work = find_call(&graph, "Helper.work");
    assert(work && work->resolution == CALL_RESOLVED);
    assert(strcmp(symbol_name(index, work->callee), "Helper::work") == 0);

    const GraphCall *help = find_call(&graph, "help");
    assert(help && help->resolution == CALL_RESOLVED);
    assert(strcmp(symbol_name(index, help->callee), "Util::help") == 0);

    const GraphCall *qualified = find_call(&graph, "com.example.util.Util.help");
    assert(qualified && qualified->resolution == CALL_RESOLVED);
    assert(strcmp(symbol_name(index, qualified->callee), "Util::help") == 0);

    const GraphCall *duplicate = find_call(&graph, "duplicate");
    assert(duplicate && duplicate->resolution == CALL_AMBIGUOUS && duplicate->candidate_count == 2);

    const GraphCall *missing = find_call(&graph, "other.missing");
    assert(missing && missing->resolution == CALL_UNRESOLVED);

    index_graph_free(&graph);
    index_free(index);
    puts("Java static call resolution tests passed");
    return 0;
}
