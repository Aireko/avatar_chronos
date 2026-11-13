/* Definitions (functions, methods, classes) with their full line ranges, used to
 * scope git blame to one function. Uses the tree-sitter parser for the
 * languages it supports; chronos_blame falls back to the line-based detector
 * for everything else. */
#include "parser.h"
#include "parser_internal.h"

#include <stdlib.h>
#include <string.h>

static char* copy_text(const char* s)
{
    size_t n = strlen(s);
    char* p = (char*)malloc(n + 1);
    if (p) memcpy(p, s, n + 1);
    return p;
}

static int by_position(const void* a, const void* b)
{
    const chronos_def_t* x = (const chronos_def_t*)a;
    const chronos_def_t* y = (const chronos_def_t*)b;
    if (x->start != y->start) return x->start < y->start ? -1 : 1;
    if (x->end != y->end) return x->end > y->end ? -1 : 1; /* outer before inner */
    return 0;
}

void chronos_free_definitions(chronos_def_t* defs, size_t count)
{
    size_t i;
    if (!defs) return;
    for (i = 0; i < count; i++) free(defs[i].name);
    free(defs);
}

int chronos_parse_definitions(const char* path, const char* commit_sha, const char* source, size_t length,
                              chronos_def_t** defs, size_t* count)
{
    ParsedFile file;
    RevisionRef revision;
    chronos_def_t* out;
    size_t i, n = 0;
    int status;

    *defs = NULL;
    *count = 0;
    if (!path || !commit_sha || !parser_language_for_path(path)) return 0;

    memset(&file, 0, sizeof file);
    revision.repository_id = "blame";
    revision.commit_sha = commit_sha;
    status = parser_parse(path, &revision, source, length, &file);
    if (status == CHRONOS_OUT_OF_MEMORY) return -1;
    if (status < 0) return 0; /* e.g. not valid UTF-8: let the caller fall back */

    out = (chronos_def_t*)calloc(file.symbol_count ? file.symbol_count : 1, sizeof *out);
    if (!out) {
        parser_free(&file);
        return -1;
    }
    for (i = 0; i < file.symbol_count; i++) {
        const ParsedSymbol* s = &file.symbols[i];
        const char* name = (s->qualified_name && *s->qualified_name) ? s->qualified_name : s->name;
        if (s->form != PARSER_DEFINITION || !name || !*name) continue;
        out[n].name = copy_text(name);
        if (!out[n].name) {
            chronos_free_definitions(out, n);
            parser_free(&file);
            return -1;
        }
        out[n].kind = s->kind == PARSER_CLASS ? "class" : s->kind == PARSER_METHOD ? "method" : "function";
        out[n].start = (long)s->range.start_line;
        out[n].end = (long)s->range.end_line;
        n++;
    }
    parser_free(&file);
    qsort(out, n, sizeof *out, by_position);
    *defs = out;
    *count = n;
    return 1;
}
