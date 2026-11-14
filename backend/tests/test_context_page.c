#include "context_page.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const RevisionRef REVISION = {
    "example/page", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};

#define SYMBOL(id, name, start, end, line) \
    {id, 0, PARSER_FUNCTION, PARSER_DEFINITION, name, name, NULL, {start, end, line, line}}
#define CALL(symbol, name, start, end, line) \
    {symbol, name, {start, end, line, line}}

static const ParsedSymbol MAIN_SYMBOLS[] = {SYMBOL(1, "main", 0, 100, 1)};
static const ParsedCall MAIN_CALLS[] = {CALL(1, "alpha", 10, 20, 1)};
static const ParsedSymbol CORE_SYMBOLS[] = {
    SYMBOL(1, "alpha", 0, 100, 1),
    SYMBOL(2, "beta", 101, 200, 2)
};
static const ParsedCall CORE_CALLS[] = {CALL(1, "beta", 10, 20, 1)};
static const ParsedSymbol REMOTE_SYMBOLS[] = {SYMBOL(1, "gamma", 0, 100, 1)};

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
         .coverage = CHRONOS_COMPLETE}
    };
    GitBlob blobs[3] = {0};
    IndexFileInput inputs[3] = {0};
    for (size_t i = 0; i < 3; ++i) {
        blobs[i] = (GitBlob){REVISION, files[i].file_path, SOURCE, sizeof SOURCE};
        inputs[i] = (IndexFileInput){&files[i], &blobs[i]};
    }
    RepositoryIndex *index = NULL;
    assert(index_build(&REVISION, inputs, 3, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    return index;
}

static const GraphSymbol *find_symbol(const RepositoryIndex *index, const char *name)
{
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    for (size_t i = 0; i < count; ++i)
        if (scopes[i].kind == INDEX_SYMBOL && scopes[i].symbol != NULL &&
            strcmp(scopes[i].symbol->name, name) == 0)
            return scopes[i].symbol;
    return NULL;
}

int main(void)
{
    RepositoryIndex *index = build_index();
    const GraphSymbol *main_symbol = find_symbol(index, "main");
    assert(main_symbol != NULL);
    char *app_id = context_scope_id_alloc(CONTEXT_SCOPE_MODULE, "app", NULL);
    char *main_file_id = context_scope_id_alloc(CONTEXT_SCOPE_FILE, "app/main.c", NULL);
    char *main_scope_id = context_symbol_scope_id_alloc(main_symbol);
    assert(app_id && main_file_id && main_scope_id);

    const ContextFlowRequest flow = {
        .mode = CONTEXT_FLOW_ONBOARDING, .max_hops = 3, .max_flows = 4, .max_nodes = 4
    };
    const ContextViewsRequest request = {&flow, {8, 4096}};
    ContextSession *session = NULL;
    assert(context_session_open(index, &request, &session) == CHRONOS_OK);
    assert(session != NULL);

    int length = context_session_brief(session, NULL, 0);
    assert(length > 0);
    char *brief = malloc((size_t)length + 1);
    assert(brief != NULL);
    assert(context_session_brief(session, brief, (size_t)length + 1) == length);
    assert(strstr(brief, "\"sections\"") != NULL);
    free(brief);

    ContextPage page = {0};
    const ContextPageRequest root = {
        .kind = CONTEXT_PAGE_ROOT, .max_nodes = 1, .max_edges = 8, .max_evidence = 8
    };
    assert(context_session_page(session, &root, &page) == CHRONOS_OK);
    assert(page.node_count == 1 && page.node_total == 2);
    assert(page.nodes[0].kind == CONTEXT_SCOPE_MODULE);
    assert(page.node_next_offset == 1);
    assert(page.edge_count == 2 && page.edge_total == 2);
    context_page_free(&page);

    const ContextPageRequest root_next = {
        .kind = CONTEXT_PAGE_ROOT, .node_offset = 1, .max_nodes = 1
    };
    assert(context_session_page(session, &root_next, &page) == CHRONOS_OK);
    assert(page.node_count == 1 && page.node_total == 2);
    context_page_free(&page);

    const ContextPageRequest module = {
        .kind = CONTEXT_PAGE_MODULE, .parent_scope_id = app_id, .max_nodes = 8
    };
    assert(context_session_page(session, &module, &page) == CHRONOS_OK);
    assert(page.node_total == 2);
    for (size_t i = 0; i < page.node_count; ++i)
        assert(page.nodes[i].kind == CONTEXT_SCOPE_FILE);
    context_page_free(&page);

    const ContextPageRequest file = {
        .kind = CONTEXT_PAGE_FILE, .parent_scope_id = main_file_id, .max_nodes = 8
    };
    assert(context_session_page(session, &file, &page) == CHRONOS_OK);
    assert(page.node_count == 1);
    assert(page.nodes[0].kind == CONTEXT_SCOPE_SYMBOL);
    assert(page.nodes[0].child_count == 0);
    context_page_free(&page);

    const ContextPageRequest symbol = {
        .kind = CONTEXT_PAGE_SYMBOL, .parent_scope_id = main_scope_id,
        .max_nodes = 1, .max_edges = 8, .max_evidence = 8
    };
    assert(context_session_page(session, &symbol, &page) == CHRONOS_OK);
    assert(page.node_count == 1 && page.node_total == 1);
    assert(page.edge_count == 1 && page.edge_total == 1);
    assert(page.evidence_count == 1);
    const char *evidence_id = page.evidence[0].id;
    ContextSource source = {0};
    assert(context_session_source(session, evidence_id, &source) == CHRONOS_OK);
    assert(source.status == CONTEXT_SOURCE_PRESENT);
    assert(source.byte_count == 10);
    assert(memcmp(source.bytes, "xxxxxxxxxx", 10) == 0);

    int page_length = context_page_write_json(&page, NULL, 0);
    assert(page_length > 0);
    char *page_json = malloc((size_t)page_length + 1);
    assert(page_json != NULL);
    assert(context_page_write_json(&page, page_json, (size_t)page_length + 1) == page_length);
    assert(strstr(page_json, "\"schemaVersion\":1") != NULL);
    assert(strstr(page_json, "\"kind\":\"symbol\"") != NULL);
    assert(strstr(page_json, "\"total\":1") != NULL);
    assert(strstr(page_json, "\"source\":") == NULL);
    free(page_json);

    int source_length = context_source_write_json(&source, NULL, 0);
    assert(source_length > 0);
    char *source_json = malloc((size_t)source_length + 1);
    assert(source_json != NULL);
    assert(context_source_write_json(&source, source_json, (size_t)source_length + 1) ==
           source_length);
    assert(strstr(source_json, "\"status\":\"present\"") != NULL);
    assert(strstr(source_json, "xxxxxxxxxx") != NULL);
    free(source_json);

    context_page_free(&page);

    context_session_close(session);
    free(app_id);
    free(main_file_id);
    free(main_scope_id);
    puts("context page session tests passed");
    return 0;
}
