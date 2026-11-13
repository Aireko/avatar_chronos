#ifndef CHRONOS_INDEX_H
#define CHRONOS_INDEX_H

#include "git_history.h"
#include "mapper.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct RepositoryIndex RepositoryIndex;

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