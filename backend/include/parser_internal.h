#ifndef CHRONOS_PARSER_INTERNAL_H
#define CHRONOS_PARSER_INTERNAL_H

#include <stddef.h>

/* Legacy commit/merge diff model. The source parser uses ParsedFile. */
#define NAME_MAX_LEN           256

enum { CH_MOD = 0, CH_ADD = 1, CH_DEL = 2 };

typedef struct {
    char*       name;
    const char* kind;
    int         change;
    long        start;
    long        end;
    int         range_new; /* 1: new-file coordinates, 0: old-file coordinates */
} sym_t;

typedef struct {
    long old_start, old_count, new_start, new_count;
    int  sym;
} hunk_t;

typedef struct {
    char*   path;
    char*   old_path;
    char    status;
    int     binary;
    long    additions;
    long    deletions;
    sym_t*  syms;
    size_t  nsyms, csyms;
    hunk_t* hunks;
    size_t  nhunks, chunks;
} file_t;

typedef struct {
    file_t* items;
    size_t  n, cap;
} filelist_t;

typedef struct {
    long        cur;
    int         in_hunk;
    long        old_rem, new_rem, old_line, new_line;
    long        hunk_idx;
    int         plus_sym, minus_sym, ctx_sym;
    int         has_ctx;
    char        ctx_name[NAME_MAX_LEN];
    const char* ctx_kind;
    int         keep_hunks;
    int         oom;
} diff_state_t;

void chronos_diff_state_init(diff_state_t* state, int keep_hunks);
void chronos_diff_feed(diff_state_t* state, filelist_t* files, const char* line);
void chronos_filelist_free(filelist_t* files);
char* chronos_git_unquote(const char* path);

typedef struct {
    char*      hash;
    char*      short_hash;
    char*      author;
    char*      message;
    long long  ts;
    char**     parents;
    size_t     np, cp;
    char**     refs;
    size_t     nr, cr;
    filelist_t files;
} commit_t;

int chronos_parse_commit_header(const char* line, commit_t* commit);

/* The line-based definition detector used for diffs (parser.c), exposed for
 * languages the tree-sitter parser doesn't cover. */
int chronos_detect_def(const char* line, char* name, size_t cap, const char** kind);

/* A function, method or class definition with its 1-based, inclusive lines. */
typedef struct {
    char*       name;
    const char* kind; /* "function" | "method" | "class" (static) */
    long        start;
    long        end;
} chronos_def_t;

/* Definitions in `source` found by the tree-sitter parser, sorted by position
 * (definitions.c). Returns 1 on success (possibly with none), 0 when the
 * language isn't supported or the source can't be parsed, -1 when out of
 * memory. Free with chronos_free_definitions(). */
int chronos_parse_definitions(const char* path, const char* commit_sha, const char* source, size_t length,
                              chronos_def_t** defs, size_t* count);
void chronos_free_definitions(chronos_def_t* defs, size_t count);

#endif