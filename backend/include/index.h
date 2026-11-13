#ifndef CHRONOS_INDEX_H
#define CHRONOS_INDEX_H

#include "git_history.h"
#include "mapper.h"
#include "context_select.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct RepositoryIndex RepositoryIndex;

typedef enum {
    INDEX_PROJECT,
    INDEX_MODULE,
    INDEX_FILE,
    INDEX_SYMBOL
} IndexScopeKind;

#define INDEX_NO_SCOPE ((size_t)-1)

/* IDs are array positions in index_scopes(). Root is 0. Modules correspond
 * to Git directories. Empty source files still have a scope. */
typedef struct {
    IndexScopeKind kind;
    size_t parent;
    const char *path;
    const GraphSymbol *symbol;
    ChronosCoverage coverage;
} IndexScope;

const IndexScope *index_scopes(const RepositoryIndex *index, size_t *count);
size_t index_find_symbol(const RepositoryIndex *index, const SymbolVersionRef *ref);

/* Each result borrows its call and scope IDs from the index. Unresolved and
 * ambiguous calls have INDEX_NO_SCOPE as the target. */
typedef struct {
    const GraphCall *call;
    size_t caller;
    size_t callee;
} IndexCallLink;

typedef struct {
    const IndexCallLink *links;
    size_t count;
    ChronosCoverage coverage;
} IndexCallMap;

/* Select calls between any two subtrees. INDEX_NO_SCOPE on either side is
 * unrestricted. An explicitly selected target requires a resolved edge.
 * The map owns its array and borrows calls from the index. */
int index_map_calls(const RepositoryIndex *index, size_t from, size_t to, IndexCallMap *out);
void index_call_map_free(IndexCallMap *map);

/* Open a pinned revision and parse its tracked source files. The scope,
 * revision, diagnostic and source accessors borrow from the index. */
int index_build_revision(const GitRepository *repo, const char *selector, RepositoryIndex **out);
const RevisionRef *index_revision(const RepositoryIndex *index);
const ChronosDiagnostic *index_diagnostics(const RepositoryIndex *index, size_t *count);
int index_symbol_source(const RepositoryIndex *index, const SymbolVersionRef *ref, ContextSource *out);

/* Supply phase two with direct callers/callees and pinned source. The index
 * must outlive the context, ranking, and selection. Candidates with
 * overlapping snippets in the same direction collapse to the first candidate
 * in collection order, so the same source bytes are not repeated. */
typedef struct {
    ContextSource target_source;
    ContextCandidates candidates;
} IndexContext;

int index_collect_context(const RepositoryIndex *index, const SymbolVersionRef *target,
                          IndexContext *out);
void index_context_free(IndexContext *context);

typedef struct {
    const ParsedFile *parsed;
    const GitBlob *blob; /* Optional. Must match the parsed revision, path and byte length. */
} IndexFileInput;

typedef enum {
    INDEX_MATCHED,
    INDEX_NO_MATCH,
    INDEX_AMBIGUOUS,
    INDEX_MATCH_UNAVAILABLE
} IndexMatchStatus;

typedef struct {
    IndexMatchStatus match;
    const SymbolChangeKind *kind; /* NULL when classification is unavailable. */
    const SymbolVersionRef *before;
    const SymbolVersionRef *after;
    const SymbolVersionRef *candidates; /* Opposite-side candidates for an ambiguous match. */
    size_t candidate_count;
} IndexSymbolChange;

typedef struct {
    GraphComparison revisions;
    const IndexSymbolChange *items;
    size_t count;
    ChronosCoverage coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} IndexChangeSet;

/* All inputs belong to revision and have unique exact Git paths. Include
 * unchanged files so their symbols can resolve calls from changed files.
 * file_coverage describes the inventory of supported source files. Each
 * ParsedFile independently describes parse coverage. Blobs enable exact
 * symbol byte comparisons. The index copies data it retains. On failure
 * *out is NULL. A usable partial index returns CHRONOS_PARTIAL. */
int index_build(const RevisionRef *revision, const IndexFileInput *files,
                size_t file_count, ChronosCoverage file_coverage,
                RepositoryIndex **out);

/* Match exact paths and qualified names. A unique pair can be INDEX_MATCHED
 * with a NULL kind when its bytes cannot be compared. Ambiguous or unknown
 * matches include the known anchor in before or after and leave kind NULL.
 * A confirmed addition has only after; a confirmed deletion has only before.
 * Incomplete inventory or parse evidence cannot prove absence. The optional
 * Git change list must match the same base/head pair; path renames do not
 * imply symbol identity. out owns its data independently of both indexes. */
int index_compare_revisions(const RepositoryIndex *base,
                            const RepositoryIndex *head,
                            const GitChangedFiles *changes,
                            IndexChangeSet *out);

/* Build an owned graph snapshot for this index's revision. comparison may
 * be NULL for an unannotated graph, or describe a pair that includes this
 * revision. Graph output remains valid after freeing the inputs. */
int index_export_graph(const RepositoryIndex *index,
                       const IndexChangeSet *comparison,
                       RepositoryGraph *out);

/* Start struct outputs zeroed. Cleanup accepts NULL and resets structs. */
void index_change_set_free(IndexChangeSet *changes);
void index_graph_free(RepositoryGraph *graph);
void index_free(RepositoryIndex *index);

#ifdef __cplusplus
}
#endif

#endif