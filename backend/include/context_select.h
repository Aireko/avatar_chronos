#ifndef CHRONOS_CONTEXT_SELECT_H
#define CHRONOS_CONTEXT_SELECT_H

#include "graph.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    CONTEXT_SOURCE_PRESENT,
    CONTEXT_SOURCE_ABSENT,
    CONTEXT_SOURCE_UNAVAILABLE
} ContextSourceStatus;

/* PRESENT requires a location and UTF-8 bytes. The byte count must equal
 * the location's range length. Empty present source has length zero.
 * ABSENT means confirmed absence; UNAVAILABLE means evidence is missing.
 * For either, set location and bytes to NULL and byte_count to zero. */
typedef struct {
    ContextSourceStatus status;
    const SourceLocation *location;
    const char *bytes;
    size_t byte_count;
} ContextSource;

typedef enum {
    CONTEXT_INCOMING_CALL,
    CONTEXT_OUTGOING_CALL
} ContextCallDirection;

/* The caller supplies direct call evidence from a RepositoryGraph. Incoming
 * evidence is resolved and points to the target. Outgoing evidence starts
 * at the target and retains the graph's resolution and candidate refs.
 * Report a self-call once, as outgoing. IDs are unique, stable within the
 * target, and derived from the call site and symbol refs, not array order.
 * A snippet can be unavailable while its call evidence remains usable. */
typedef struct {
    const char *id;
    ContextCallDirection direction;
    const GraphCall *call;
    ContextSource snippet;
} ContextCandidate;

typedef struct {
    const ContextCandidate *items;
    size_t count;
    ChronosCoverage coverage;
} ContextCandidates;

typedef struct {
    const ContextCandidate *candidate;
    double relevance; /* Finite and in [0, 1]. */
} ContextRankedItem;

typedef struct {
    const ContextRankedItem *items;
    size_t count;
    ChronosCoverage coverage;
} ContextRanking;

/* Rank usable direct call evidence by descending relevance, then by
 * ascending evidence ID (strcmp). Copy discovery coverage unchanged.
 * No graph traversal or source lookup is needed for this operation. */
int context_rank_candidates(const ContextCandidates *candidates, ContextRanking *out);
void context_ranking_free(ContextRanking *ranking);

typedef struct {
    size_t max_items;
    size_t max_source_bytes;
} ContextBudget;

typedef struct {
    const ContextRankedItem *selected;
    size_t selected_count;
    const char *const *omitted_ids; /* Evidence IDs excluded by budget. */
    size_t omitted_count;
    size_t used_source_bytes;
    ChronosCoverage coverage; /* Discovery coverage before budget trimming. */
} ContextSelection;

/* Scan the ranking in order. Skip an item that exceeds a remaining cap and
 * continue scanning. The item limit counts each selected candidate once.
 * The byte limit counts only present evidence snippets, using raw UTF-8 byte
 * lengths. Empty or unavailable snippets cost zero bytes. Zero caps are valid.
 *
 * Start out structs zeroed. Each output owns its arrays. Candidate pointers
 * and evidence ID strings borrow the original inputs, which must outlive
 * both outputs. The selection can outlive the ranking. Free functions accept
 * NULL and reset their outputs. Negative status leaves out empty. */
int context_select(const ContextRanking *ranking, const ContextBudget *budget,
                   ContextSelection *out);
void context_selection_free(ContextSelection *selection);

/* Collection rule: COMPLETE and INCOMPLETE expose known items, with zero
 * count for a known-empty subset. UNAVAILABLE requires NULL and zero count.
 * Successful operations return CHRONOS_OK for complete discovery and
 * CHRONOS_PARTIAL for incomplete or unavailable discovery. Budget omissions
 * are reported separately and do not change discovery coverage. */

#ifdef __cplusplus
}
#endif
#endif
