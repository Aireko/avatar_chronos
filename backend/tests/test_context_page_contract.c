#include "context_page.h"

#include <assert.h>
#include <stdio.h>

int main(void)
{
    ContextPageLimits limits = {0};

    ContextPageRequest root = {.kind = CONTEXT_PAGE_ROOT};
    assert(context_page_request_limits(&root, &limits) == CHRONOS_OK);
    assert(limits.max_nodes == 64 && limits.max_edges == 128 && limits.max_evidence == 0);

    ContextPageRequest module = {
        .kind = CONTEXT_PAGE_MODULE, .parent_scope_id = "[\"module\",\"src\"]"
    };
    assert(context_page_request_limits(&module, &limits) == CHRONOS_OK);
    assert(limits.max_nodes == 200 && limits.max_edges == 300 && limits.max_evidence == 100);

    ContextPageRequest file = {
        .kind = CONTEXT_PAGE_FILE, .parent_scope_id = "[\"file\",\"src/a.c\"]"
    };
    assert(context_page_request_limits(&file, &limits) == CHRONOS_OK);
    assert(limits.max_nodes == 200 && limits.max_edges == 300 && limits.max_evidence == 200);

    ContextPageRequest symbol = {
        .kind = CONTEXT_PAGE_SYMBOL, .parent_scope_id = "[\"symbol\",\"a\"]"
    };
    assert(context_page_request_limits(&symbol, &limits) == CHRONOS_OK);
    assert(limits.max_nodes == 1 && limits.max_edges == 200 && limits.max_evidence == 400);

    ContextPageRequest custom = module;
    custom.max_nodes = 50;
    custom.max_edges = 60;
    custom.max_evidence = 70;
    assert(context_page_request_limits(&custom, &limits) == CHRONOS_OK);
    assert(limits.max_nodes == 50 && limits.max_edges == 60 && limits.max_evidence == 70);

    ContextPageRequest too_big = module;
    too_big.max_edges = CHRONOS_PAGE_MAX_EDGES + 1;
    assert(context_page_request_limits(&too_big, &limits) == CHRONOS_INVALID_ARGUMENT);

    ContextPageRequest bad_root = root;
    bad_root.parent_scope_id = "[\"module\",\"src\"]";
    assert(context_page_request_limits(&bad_root, &limits) == CHRONOS_INVALID_ARGUMENT);

    ContextPageRequest bad_module = module;
    bad_module.parent_scope_id = NULL;
    assert(context_page_request_limits(&bad_module, &limits) == CHRONOS_INVALID_ARGUMENT);

    ContextPageRequest bad_kind = module;
    bad_kind.kind = (ContextPageKind)99;
    assert(context_page_request_limits(&bad_kind, &limits) == CHRONOS_INVALID_ARGUMENT);

    assert(CHRONOS_PAGE_INITIAL_TARGET_BYTES == 1024u * 1024u);
    assert(CHRONOS_PAGE_TARGET_BYTES == 256u * 1024u);
    puts("context page contract tests passed");
    return 0;
}
