#include "context_views.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const RevisionRef revision = {"example/python", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"};
static const char main_source[] = "from workers.core import work as execute\n\n"
                                  "def bootstrap():\n    return execute()\n";
static const char worker_source[] = "def work():\n    return 42\n";
static const char decoy_source[] = "def work():\n    return 0\n";

static RepositoryIndex *build_fixture(void)
{
    const char *paths[] = {"app/__main__.py", "workers/core.py", "other/core.py"};
    const char *sources[] = {main_source, worker_source, decoy_source};
    ParsedFile parsed[3] = {0};
    GitBlob blobs[3];
    IndexFileInput inputs[3];
    for (size_t i = 0; i < 3; ++i) {
        const size_t length = strlen(sources[i]);
        assert(parser_parse(paths[i], &revision, sources[i], length, &parsed[i]) == CHRONOS_OK);
        blobs[i] = (GitBlob){revision, paths[i], (const unsigned char *)sources[i], length};
        inputs[i] = (IndexFileInput){&parsed[i], &blobs[i]};
    }
    RepositoryIndex *index = NULL;
    assert(index_build(&revision, inputs, 3, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    for (size_t i = 0; i < 3; ++i) parser_free(&parsed[i]);
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
    assert(find_item(&views.brief, "entry-points", "Entry point: bootstrap in app/__main__.py."));
    const ContextBriefItem *top = find_item(&views.brief, "top-flows", "Flow: bootstrap -> work");
    assert(top && top->evidence_count == 1);

    const ContextGraphEdge *edge = NULL;
    for (size_t i = 0; i < views.graph.edge_count; ++i)
        if (strcmp(views.graph.edges[i].evidence_id, top->evidence_ids[0]) == 0)
            edge = &views.graph.edges[i];
    assert(edge && edge->call && edge->call->resolution == CALL_RESOLVED);
    const GraphCall *call = edge->call;
    assert(strcmp(call->callee_text, "execute") == 0);
    size_t scope_count;
    const IndexScope *scopes = index_scopes(index, &scope_count);
    size_t target = index_find_symbol(index, call->callee);
    assert(target < scope_count && strcmp(scopes[target].path, "workers/core.py") == 0);
    const SourceLocation *site = &call->call_site;
    assert(strcmp(site->file_path, "app/__main__.py") == 0);
    assert(strcmp(site->revision.commit_sha, revision.commit_sha) == 0);
    assert(site->range.start_byte == (size_t)(strstr(main_source, "execute()") - main_source));
    assert(site->range.end_byte == site->range.start_byte + strlen("execute()"));

    SymbolVersionRef changed_ref = *call->callee;
    context_views_free(&views);

    const ContextFlowSeed changed = {CONTEXT_FLOW_SEED_CHANGED_SYMBOL, &changed_ref, NULL};
    flow.mode = CONTEXT_FLOW_TASK;
    flow.seeds = &changed;
    flow.seed_count = 1;
    assert(context_build_views(index, &request, &views) == CHRONOS_OK);
    assert(find_item(&views.brief, "entry-points", "Task anchor: work in workers/core.py."));
    assert(find_item(&views.brief, "edit-locations",
                     "Likely edit location: bootstrap in app/__main__.py."));
    assert(!find_item(&views.brief, "edit-locations", "other/core.py"));
    assert(views.brief.used_source_bytes <= request.budget.max_source_bytes);
    context_views_free(&views);
    index_free(index);
    puts("Python onboarding and task-impact views passed");
    return 0;
}
