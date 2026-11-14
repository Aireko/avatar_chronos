#include "context_page.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* A synthetic repository with one oversized module, one oversized file and one
 * hub symbol. It is large enough to hit every page budget while staying fast:
 *
 *   modules        70  -> root page truncates at 64
 *   bulk module   210 files -> module page truncates at 200
 *   dense file    210 symbols -> file page truncates at 200
 *   hub symbol    418 calls -> symbol page paginates edges and evidence
 */

#define MODULE_COUNT 70
#define BULK_FILES 210
#define DENSE_SYMBOLS 210
#define SMALL_MODULE_COUNT (MODULE_COUNT - 2)
#define SMALL_SYMBOLS 3
#define TOTAL_FILES (BULK_FILES + 1 + SMALL_MODULE_COUNT)
#define TOTAL_SYMBOLS (BULK_FILES + DENSE_SYMBOLS + SMALL_MODULE_COUNT * SMALL_SYMBOLS)
#define DENSE_CALLS (2 * (DENSE_SYMBOLS - 1))
#define SMALL_CALLS (SMALL_MODULE_COUNT * SMALL_SYMBOLS)
#define TOTAL_CALLS (DENSE_CALLS + SMALL_CALLS)
#define SOURCE_SIZE 4096

static const RevisionRef REVISION = {
    "example/scale", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
};

typedef struct {
    char path[64];
    size_t first_symbol;
    size_t symbol_count;
    ParsedSymbol *symbols;
    ParsedCall *calls;
    size_t call_count;
} FileFixture;

static unsigned char SOURCE[SOURCE_SIZE];
static FileFixture FIXTURES[TOTAL_FILES];
static char SYMBOL_NAMES[TOTAL_SYMBOLS][32];
static ParsedFile PARSED[TOTAL_FILES];
static GitBlob BLOBS[TOTAL_FILES];
static IndexFileInput INPUTS[TOTAL_FILES];

typedef struct {
    ContextPage page;
    char *json;
    int length;
} FetchedPage;

static void fill_source(void)
{
    static const char marker[] = "SOURCE_SECRET_MARKER";
    for (size_t i = 0; i < sizeof SOURCE; ++i)
        SOURCE[i] = (unsigned char)marker[i % (sizeof marker - 1)];
}

static size_t add_file(const char *path, size_t symbol_count, size_t *next_symbol)
{
    static size_t file_index = 0;
    assert(file_index < TOTAL_FILES);
    FileFixture *file = &FIXTURES[file_index];
    int written = snprintf(file->path, sizeof file->path, "%s", path);
    assert(written > 0 && (size_t)written < sizeof file->path);
    file->first_symbol = *next_symbol;
    file->symbol_count = symbol_count;
    file->symbols = calloc(symbol_count, sizeof *file->symbols);
    assert(file->symbols != NULL);
    for (size_t i = 0; i < symbol_count; ++i) {
        size_t global = *next_symbol + i;
        assert(global < TOTAL_SYMBOLS);
        written = snprintf(SYMBOL_NAMES[global], sizeof SYMBOL_NAMES[global],
                           "sym_%04zu", global);
        assert(written > 0 && (size_t)written < sizeof SYMBOL_NAMES[global]);
        size_t start = i * 10;
        file->symbols[i] = (ParsedSymbol){
            .id = i + 1,
            .parent_id = 0,
            .kind = PARSER_FUNCTION,
            .form = PARSER_DEFINITION,
            .name = SYMBOL_NAMES[global],
            .qualified_name = SYMBOL_NAMES[global],
            .signature = NULL,
            .range = {start, start + 8, i + 1, i + 1}
        };
    }
    *next_symbol += symbol_count;
    return file_index++;
}

static void add_call(FileFixture *file, size_t caller, size_t callee_symbol)
{
    const ParsedSymbol *symbol = &file->symbols[caller];
    size_t start = symbol->range.start_byte + 1;
    ParsedCall *grown = realloc(file->calls, (file->call_count + 1) * sizeof *grown);
    assert(grown != NULL);
    file->calls = grown;
    file->calls[file->call_count++] = (ParsedCall){
        .enclosing_symbol_id = symbol->id,
        .callee_text = SYMBOL_NAMES[callee_symbol],
        .range = {start, start + 4, symbol->range.start_line, symbol->range.start_line}
    };
}

static void build_fixtures(void)
{
    fill_source();
    size_t next_symbol = 0;
    for (size_t i = 0; i < BULK_FILES; ++i) {
        char path[64];
        int written = snprintf(path, sizeof path, "mod_bulk/file_%03zu.c", i);
        assert(written > 0 && (size_t)written < sizeof path);
        (void)add_file(path, 1, &next_symbol);
    }

    size_t dense_index = add_file("mod_dense/dense.c", DENSE_SYMBOLS, &next_symbol);
    FileFixture *dense = &FIXTURES[dense_index];
    size_t hub = dense->first_symbol;
    for (size_t i = 1; i < DENSE_SYMBOLS; ++i) {
        add_call(dense, i, hub);
        add_call(dense, 0, dense->first_symbol + i);
    }

    for (size_t module = 0; module < SMALL_MODULE_COUNT; ++module) {
        char path[64];
        int written = snprintf(path, sizeof path, "mod_%02zu/file.c", module);
        assert(written > 0 && (size_t)written < sizeof path);
        size_t file_index = add_file(path, SMALL_SYMBOLS, &next_symbol);
        FileFixture *file = &FIXTURES[file_index];
        for (size_t i = 0; i < SMALL_SYMBOLS; ++i)
            add_call(file, i, file->first_symbol + (i + 1) % SMALL_SYMBOLS);
    }

    assert(next_symbol == TOTAL_SYMBOLS);
    size_t calls = 0;
    for (size_t i = 0; i < TOTAL_FILES; ++i) {
        FileFixture *file = &FIXTURES[i];
        PARSED[i] = (ParsedFile){
            .revision = REVISION,
            .file_path = file->path,
            .language = "c",
            .source_length = SOURCE_SIZE,
            .symbols = file->symbols,
            .symbol_count = file->symbol_count,
            .calls = file->calls,
            .call_count = file->call_count,
            .coverage = CHRONOS_COMPLETE
        };
        BLOBS[i] = (GitBlob){REVISION, file->path, SOURCE, SOURCE_SIZE};
        INPUTS[i] = (IndexFileInput){&PARSED[i], &BLOBS[i]};
        calls += file->call_count;
    }
    assert(calls == TOTAL_CALLS);
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

static void assert_source_resolution(ContextSession *session, const ContextPage *page)
{
    for (size_t i = 0; i < page->evidence_count; ++i) {
        const ContextEvidence *evidence = &page->evidence[i];
        assert(evidence->id != NULL);
        ContextSource source = {0};
        int status = context_session_source(session, evidence->id, &source);
        assert(status == CHRONOS_OK || status == CHRONOS_PARTIAL);
        switch (source.status) {
        case CONTEXT_SOURCE_PRESENT:
            assert(source.location != NULL);
            assert(source.bytes != NULL);
            assert(source.byte_count == source.location->range.end_byte -
                                       source.location->range.start_byte);
            break;
        case CONTEXT_SOURCE_ABSENT:
        case CONTEXT_SOURCE_UNAVAILABLE:
            assert(source.location == NULL);
            assert(source.bytes == NULL);
            assert(source.byte_count == 0);
            break;
        default:
            assert(0 && "unknown source status");
        }
    }
}

static FetchedPage fetch_page(ContextSession *session, const ContextPageRequest *request,
                              const char *label, int byte_limit)
{
    FetchedPage out = {0};
    clock_t started = clock();
    assert(context_session_page(session, request, &out.page) == CHRONOS_OK);
    out.length = context_page_write_json(&out.page, NULL, 0);
    assert(out.length > 0);
    out.json = malloc((size_t)out.length + 1);
    assert(out.json != NULL);
    assert(context_page_write_json(&out.page, out.json, (size_t)out.length + 1) == out.length);
    double elapsed = (double)(clock() - started) / CLOCKS_PER_SEC;

    printf("context page %-14s %7d bytes  nodes %3zu/%-4zu  edges %3zu/%-4zu  "
           "evidence %3zu/%-4zu  %.2f ms\n",
           label, out.length, out.page.node_count, out.page.node_total,
           out.page.edge_count, out.page.edge_total, out.page.evidence_count,
           out.page.evidence_total, elapsed * 1000.0);

    assert(elapsed < 0.1);
    assert(out.length <= byte_limit);
    assert(strstr(out.json, "SOURCE_SECRET_MARKER") == NULL);
    assert(strstr(out.json, "\"source\":") == NULL);
    assert_source_resolution(session, &out.page);
    return out;
}

static void free_page(FetchedPage *page)
{
    free(page->json);
    context_page_free(&page->page);
}

int main(void)
{
    build_fixtures();
    size_t builds = index_build_count();
    RepositoryIndex *index = NULL;
    assert(index_build(&REVISION, INPUTS, TOTAL_FILES, CHRONOS_COMPLETE, &index) == CHRONOS_OK);
    assert(index_build_count() == builds + 1);
    builds = index_build_count();

    const GraphSymbol *hub_symbol = find_symbol(index, SYMBOL_NAMES[BULK_FILES]);
    assert(hub_symbol != NULL);
    char *bulk_id = context_scope_id_alloc(CONTEXT_SCOPE_MODULE, "mod_bulk", NULL);
    char *dense_id = context_scope_id_alloc(CONTEXT_SCOPE_FILE, "mod_dense/dense.c", NULL);
    char *hub_id = context_symbol_scope_id_alloc(hub_symbol);
    assert(bulk_id && dense_id && hub_id);

    const ContextFlowRequest flow = {
        .mode = CONTEXT_FLOW_ONBOARDING, .max_hops = 3, .max_flows = 8, .max_nodes = 8
    };
    const ContextViewsRequest views = {&flow, {12, 4096}};
    ContextSession *session = NULL;
    assert(context_session_open(index, &views, &session) == CHRONOS_OK);
    assert(session != NULL);
    assert(index_build_count() == builds);

    int brief_length = context_session_brief(session, NULL, 0);
    assert(brief_length > 0);
    char *brief = malloc((size_t)brief_length + 1);
    assert(brief != NULL);
    assert(context_session_brief(session, brief, (size_t)brief_length + 1) == brief_length);
    free(brief);

    const ContextPageRequest root_request = {.kind = CONTEXT_PAGE_ROOT};
    FetchedPage root = fetch_page(session, &root_request, "root", 64 * 1024);
    assert(root.page.node_count == CHRONOS_PAGE_DEFAULT_NODES);
    assert(root.page.node_total == MODULE_COUNT);
    assert(root.page.node_next_offset == CHRONOS_PAGE_DEFAULT_NODES);
    assert(root.page.evidence_count == 0);
    assert(brief_length + root.length < (int)CHRONOS_PAGE_INITIAL_TARGET_BYTES);

    const ContextPageRequest module_request = {
        .kind = CONTEXT_PAGE_MODULE, .parent_scope_id = bulk_id
    };
    FetchedPage module = fetch_page(session, &module_request, "module bulk", 128 * 1024);
    assert(module.page.node_count == 200);
    assert(module.page.node_total == BULK_FILES);
    assert(module.page.node_next_offset == 200);
    assert(module.page.edge_total == BULK_FILES);
    for (size_t i = 0; i < module.page.node_count; ++i) {
        assert(module.page.nodes[i].kind == CONTEXT_SCOPE_FILE);
        char *expected = context_scope_id_alloc(CONTEXT_SCOPE_FILE,
                                                 module.page.nodes[i].label, NULL);
        assert(expected != NULL);
        assert(strcmp(module.page.nodes[i].id, expected) == 0);
        free(expected);
    }

    const ContextPageRequest module_next_request = {
        .kind = CONTEXT_PAGE_MODULE, .parent_scope_id = bulk_id, .node_offset = 200
    };
    FetchedPage module_next =
        fetch_page(session, &module_next_request, "module bulk+", 128 * 1024);
    assert(module_next.page.node_count == BULK_FILES - 200);
    assert(module_next.page.node_total == BULK_FILES);
    assert(module_next.page.node_next_offset == BULK_FILES);

    const ContextPageRequest file_request = {
        .kind = CONTEXT_PAGE_FILE, .parent_scope_id = dense_id
    };
    FetchedPage file_page = fetch_page(session, &file_request, "file dense", 256 * 1024);
    assert(file_page.page.node_count == 200);
    assert(file_page.page.node_total == DENSE_SYMBOLS);
    assert(file_page.page.node_next_offset == 200);
    assert(file_page.page.edge_total == DENSE_SYMBOLS);
    for (size_t i = 0; i < file_page.page.node_count; ++i) {
        assert(file_page.page.nodes[i].kind == CONTEXT_SCOPE_SYMBOL);
        const GraphSymbol *symbol = find_symbol(index, file_page.page.nodes[i].label);
        assert(symbol != NULL);
        char *expected = context_symbol_scope_id_alloc(symbol);
        assert(expected != NULL);
        assert(strcmp(file_page.page.nodes[i].id, expected) == 0);
        free(expected);
    }

    const ContextPageRequest symbol_request = {
        .kind = CONTEXT_PAGE_SYMBOL, .parent_scope_id = hub_id
    };
    FetchedPage symbol = fetch_page(session, &symbol_request, "symbol hub", 256 * 1024);
    assert(symbol.page.node_count == 1);
    assert(symbol.page.node_total == 1);
    assert(symbol.page.edge_count == 200);
    assert(symbol.page.edge_total == 2 * (DENSE_SYMBOLS - 1));
    assert(symbol.page.edge_next_offset == 200);
    assert(symbol.page.evidence_count == 400);
    assert(symbol.page.evidence_total == 2 * (DENSE_SYMBOLS - 1));
    assert(symbol.page.evidence_next_offset == 400);

    const ContextPageRequest symbol_more_request = {
        .kind = CONTEXT_PAGE_SYMBOL, .parent_scope_id = hub_id,
        .edge_offset = 200, .evidence_offset = 400
    };
    FetchedPage symbol_more =
        fetch_page(session, &symbol_more_request, "symbol hub+", 256 * 1024);
    assert(symbol_more.page.edge_count == 200);
    assert(symbol_more.page.edge_next_offset == 400);
    assert(symbol_more.page.evidence_count == 18);
    assert(symbol_more.page.evidence_next_offset == 2 * (DENSE_SYMBOLS - 1));

    const ContextPageRequest symbol_tail_request = {
        .kind = CONTEXT_PAGE_SYMBOL, .parent_scope_id = hub_id, .edge_offset = 400
    };
    FetchedPage symbol_tail =
        fetch_page(session, &symbol_tail_request, "symbol hub++", 256 * 1024);
    assert(symbol_tail.page.edge_count == 2 * (DENSE_SYMBOLS - 1) - 400);

    FetchedPage module_repeat =
        fetch_page(session, &module_request, "module repeat", 128 * 1024);
    assert(strcmp(module.json, module_repeat.json) == 0);

    FetchedPage root_repeat = fetch_page(session, &root_request, "root repeat", 64 * 1024);
    assert(strcmp(root.json, root_repeat.json) == 0);

    assert(index_build_count() == builds);

    printf("context page scale metrics: initial=%d bytes (%d brief + %d root), "
           "files=%d symbols=%d calls=%d index_builds=%zu\n",
           brief_length + root.length, brief_length, root.length, TOTAL_FILES,
           TOTAL_SYMBOLS, TOTAL_CALLS, index_build_count());

    free_page(&root);
    free_page(&root_repeat);
    free_page(&module);
    free_page(&module_next);
    free_page(&module_repeat);
    free_page(&file_page);
    free_page(&symbol);
    free_page(&symbol_more);
    free_page(&symbol_tail);
    context_session_close(session);
    free(bulk_id);
    free(dense_id);
    free(hub_id);
    for (size_t i = 0; i < TOTAL_FILES; ++i) {
        free(FIXTURES[i].symbols);
        free(FIXTURES[i].calls);
    }
    puts("context page scale and determinism tests passed");
    return 0;
}
