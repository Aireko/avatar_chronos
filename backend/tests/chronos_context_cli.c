/*
 * End-to-end context compiler CLI (sprint slice 2).
 *
 * Usage:
 *   chronos_context <repo> <base> <head> <path> <qualifiedName>
 *                   [maxItems] [maxSourceBytes] [output.json]
 *
 * It resolves one changed symbol, builds the base/head indexes, collects the
 * direct caller/callee evidence, ranks and budgets it, and writes
 * review-context.json v1. With no output path it writes to stdout.
 */
#include "context_package.h"
#include "index.h"

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int usage(void)
{
    fprintf(stderr,
        "usage: chronos_context <repo> <base> <head> <path> <qualifiedName>\n"
        "                       [maxItems] [maxSourceBytes] [output.json]\n");
    return 2;
}

static int parse_size(const char *text, size_t *out)
{
    if (text == NULL || *text == '\0' || *text == '-') return 0;
    errno = 0;
    char *end = NULL;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value > SIZE_MAX) return 0;
    *out = (size_t)value;
    return 1;
}

static const GraphSymbol *symbol_for(const RepositoryIndex *index,
                                     const SymbolVersionRef *ref)
{
    size_t scope = index_find_symbol(index, ref);
    if (scope == INDEX_NO_SCOPE) return NULL;
    const IndexScope *scopes = index_scopes(index, NULL);
    return scopes[scope].symbol;
}

static int ref_matches(const RepositoryIndex *index, const SymbolVersionRef *ref,
                       const char *path, const char *qualified_name)
{
    const GraphSymbol *symbol = symbol_for(index, ref);
    return symbol != NULL &&
           strcmp(symbol->location.file_path, path) == 0 &&
           strcmp(symbol->qualified_name, qualified_name) == 0;
}

static const IndexSymbolChange *find_change(const IndexChangeSet *changes,
                                            const RepositoryIndex *base,
                                            const RepositoryIndex *head,
                                            const char *path,
                                            const char *qualified_name,
                                            int *ambiguous)
{
    const IndexSymbolChange *found = NULL;
    *ambiguous = 0;
    for (size_t i = 0; i < changes->count; ++i) {
        const IndexSymbolChange *item = &changes->items[i];
        int matches = (item->before != NULL &&
                       ref_matches(base, item->before, path, qualified_name)) ||
                      (item->after != NULL &&
                       ref_matches(head, item->after, path, qualified_name));
        if (!matches) continue;
        if (found != NULL) {
            *ambiguous = 1;
            return NULL;
        }
        found = item;
    }
    return found;
}

static int collect_review(const RepositoryIndex *base, const RepositoryIndex *head,
                          const IndexSymbolChange *item, const ContextBudget *budget,
                          const GraphComparison *comparison, ReviewContext *review,
                          IndexContext *context, ContextRanking *ranking,
                          ContextSelection *selection)
{
    if (item->match == INDEX_AMBIGUOUS) return CHRONOS_NOT_FOUND;
    if (item->match == INDEX_MATCH_UNAVAILABLE || item->kind == NULL)
        return CHRONOS_NOT_FOUND;

    const RepositoryIndex *target_index = NULL;
    const SymbolVersionRef *target_ref = NULL;
    ContextSource previous = {.status = CONTEXT_SOURCE_UNAVAILABLE};
    ContextSource current = {.status = CONTEXT_SOURCE_UNAVAILABLE};
    switch (*item->kind) {
    case SYMBOL_ADDED:
        if (item->after == NULL) return CHRONOS_NOT_FOUND;
        target_index = head;
        target_ref = item->after;
        if (index_symbol_source(head, item->after, &current) < 0)
            return CHRONOS_NOT_FOUND;
        break;
    case SYMBOL_MODIFIED:
        if (item->before == NULL || item->after == NULL) return CHRONOS_NOT_FOUND;
        target_index = head;
        target_ref = item->after;
        if (index_symbol_source(base, item->before, &previous) < 0 ||
            index_symbol_source(head, item->after, &current) < 0)
            return CHRONOS_NOT_FOUND;
        break;
    case SYMBOL_DELETED:
        if (item->before == NULL) return CHRONOS_NOT_FOUND;
        target_index = base;
        target_ref = item->before;
        if (index_symbol_source(base, item->before, &previous) < 0)
            return CHRONOS_NOT_FOUND;
        break;
    case SYMBOL_UNCHANGED:
    default:
        return CHRONOS_NOT_FOUND;
    }

    int status = index_collect_context(target_index, target_ref, context);
    if (status < 0) return status;
    status = context_rank_candidates(&context->candidates, ranking);
    if (status < 0) return status;
    status = context_select(ranking, budget, selection);
    if (status < 0) return status;

    size_t diagnostic_count = 0;
    const ChronosDiagnostic *diagnostics = index_diagnostics(target_index, &diagnostic_count);
    *review = (ReviewContext){
        .target = *target_ref,
        .comparison = comparison,
        .previous = previous,
        .current = current,
        .budget = *budget,
        .evidence = *selection,
        .diagnostics = diagnostics,
        .diagnostic_count = diagnostic_count
    };
    return CHRONOS_OK;
}

int main(int argc, char **argv)
{
    if (argc < 6 || argc > 9) return usage();
    const char *repo_path = argv[1];
    const char *base_selector = argv[2];
    const char *head_selector = argv[3];
    const char *path = argv[4];
    const char *qualified_name = argv[5];
    ContextBudget budget = {8, 4096};
    if (argc >= 7 && !parse_size(argv[6], &budget.max_items)) return usage();
    if (argc >= 8 && !parse_size(argv[7], &budget.max_source_bytes)) return usage();
    const char *output_path = argc >= 9 ? argv[8] : NULL;

    const GitRepository repo = {repo_path, repo_path};
    RepositoryIndex *base = NULL, *head = NULL;
    IndexChangeSet changes = {0};
    IndexContext context = {0};
    ContextRanking ranking = {0};
    ContextSelection selection = {0};
    int status = index_build_revision(&repo, base_selector, &base);
    if (status < 0) goto fail;
    status = index_build_revision(&repo, head_selector, &head);
    if (status < 0) goto fail;
    status = index_compare_revisions(base, head, NULL, &changes);
    if (status < 0) goto fail;

    int ambiguous = 0;
    const IndexSymbolChange *item =
        find_change(&changes, base, head, path, qualified_name, &ambiguous);
    if (item == NULL) {
        fprintf(stderr, "chronos_context: %s target %s::%s\n",
                ambiguous ? "ambiguous" : "unknown", path, qualified_name);
        status = CHRONOS_NOT_FOUND;
        goto fail;
    }

    ReviewContext review = {0};
    GraphComparison comparison = {*index_revision(base), *index_revision(head)};
    status = collect_review(base, head, item, &budget, &comparison, &review,
                            &context, &ranking, &selection);
    if (status < 0) goto fail;

    int length = context_write_json(&review, NULL, 0);
    if (length < 0) {
        status = length;
        goto fail;
    }
    char *json = malloc((size_t)length + 1);
    if (json == NULL) {
        status = CHRONOS_OUT_OF_MEMORY;
        goto fail;
    }
    if (context_write_json(&review, json, (size_t)length + 1) != length) {
        free(json);
        status = CHRONOS_IO_ERROR;
        goto fail;
    }

    FILE *out = stdout;
    if (output_path != NULL) {
        out = fopen(output_path, "wb");
        if (out == NULL) {
            free(json);
            status = CHRONOS_IO_ERROR;
            goto fail;
        }
    }
    int write_status = fwrite(json, 1, (size_t)length, out) == (size_t)length &&
                       fputc('\n', out) != EOF;
    if (output_path != NULL && fclose(out) != 0) write_status = 0;
    free(json);
    if (!write_status) {
        status = CHRONOS_IO_ERROR;
        goto fail;
    }

    context_selection_free(&selection);
    context_ranking_free(&ranking);
    index_context_free(&context);
    index_change_set_free(&changes);
    index_free(head);
    index_free(base);
    return 0;

fail:
    fprintf(stderr, "chronos_context: failed with status %d\n", status);
    context_selection_free(&selection);
    context_ranking_free(&ranking);
    index_context_free(&context);
    index_change_set_free(&changes);
    index_free(head);
    index_free(base);
    return 1;
}
