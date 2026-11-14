#include "context_views.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const RevisionRef revision = {"example/java", "cccccccccccccccccccccccccccccccccccccccc"};

static const char app_source[] =
    "package com.example;\n"
    "public class App {\n"
    "    public static void main(String[] args) {\n"
    "        new Service().run();\n"
    "    }\n"
    "}\n";
static const char service_source[] =
    "package com.example;\n"
    "public class Service {\n"
    "    public int run() {\n"
    "        return new Repo().save();\n"
    "    }\n"
    "}\n";
static const char repo_source[] =
    "package com.example;\n"
    "public class Repo {\n"
    "    public int save() { return 1; }\n"
    "}\n";
static const char test_source[] =
    "package com.example;\n"
    "public class ServiceTest {\n"
    "    public void testRun() {\n"
    "        new Service().run();\n"
    "    }\n"
    "    public void helper() {\n"
    "        new Service().run();\n"
    "    }\n"
    "}\n";
static const char utility_source[] =
    "package com.example;\n"
    "public class Utility {\n"
    "    public void inspect() {\n"
    "        new Service().run();\n"
    "    }\n"
    "}\n";

static RepositoryIndex *build_fixture(void)
{
    enum { file_count = 5 };
    const char *paths[file_count] = {
        "src/main/java/com/example/App.java",
        "src/main/java/com/example/Service.java",
        "src/main/java/com/example/Repo.java",
        "src/test/java/com/example/ServiceTest.java",
        "src/main/java/com/example/Utility.java"
    };
    const char *sources[file_count] = {
        app_source, service_source, repo_source, test_source, utility_source
    };
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
    return index;
}

static const ContextBriefItem *find_item(const ContextBrief *brief, const char *section,
                                          const char *text)
{
    for (size_t i = 0; i < brief->section_count; ++i) {
        const ContextBriefSection *part = &brief->sections[i];
        if (strcmp(part->id, section) != 0) continue;
        for (size_t j = 0; j < part->item_count; ++j)
            if (strstr(part->items[j].text, text)) return &part->items[j];
    }
    return NULL;
}

int main(void)
{
    RepositoryIndex *index = build_fixture();
    ContextFlowRequest flow = {
        .mode = CONTEXT_FLOW_ONBOARDING, .max_hops = 4, .max_flows = 8, .max_nodes = 8
    };
    ContextViewsRequest request = {.flow = &flow, .budget = {12, 4096}};
    ContextViews views = {0};
    assert(context_build_views(index, &request, &views) == CHRONOS_OK);

    assert(find_item(&views.brief, "entry-points",
                     "Entry point: main in src/main/java/com/example/App.java."));
    assert(find_item(&views.brief, "top-flows", "Flow: run -> save"));
    assert(find_item(&views.brief, "test-locations",
                     "Likely test location: testRun in src/test/java/com/example/ServiceTest.java."));
    assert(!find_item(&views.brief, "test-locations", "helper"));
    assert(!find_item(&views.brief, "test-locations", "inspect"));

    int resolved = 0;
    for (size_t i = 0; i < views.graph.edge_count; ++i)
        if (views.graph.edges[i].call && views.graph.edges[i].call->resolution == CALL_RESOLVED)
            ++resolved;
    assert(resolved > 0);
    context_views_free(&views);
    index_free(index);
    puts("Java onboarding and test-location views passed");
    return 0;
}
