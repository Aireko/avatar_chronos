#ifndef CHRONOS_CONTEXT_PACKAGE_H
#define CHRONOS_CONTEXT_PACKAGE_H

#include "context_select.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CHRONOS_CONTEXT_SCHEMA_VERSION 1

/* A borrowed view of one explicitly selected symbol in a pinned revision.
 * A single-revision review sets comparison to NULL and previous.status to
 * CONTEXT_SOURCE_UNAVAILABLE. With a comparison, the target belongs to
 * either side and the previous/current sources refer to base/head. */
typedef struct {
    SymbolVersionRef target;
    const GraphComparison *comparison;
    ContextSource previous;
    ContextSource current;
    ContextBudget budget;
    ContextSelection evidence;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} ReviewContext;

/* review-context.json v1 uses these top-level fields:
 *   schemaVersion, target, comparison, previous, current, evidence, budget,
 *   omittedEvidenceIds, diagnostics
 *
 * target, comparison, call, diagnostic and location use the graph JSON
 * shapes. A source is {status, location, source}, with status "present",
 * "absent" or "unavailable"; absent/unavailable use null location and source.
 * evidence is {status, items}, with graph coverage strings. Items are
 * {id, direction, call, snippet, relevance}; direction is "incoming" or
 * "outgoing". Use null items for unavailable and [] for known-empty.
 * budget is {maxItems, maxSourceBytes, usedItems, usedSourceBytes};
 * usedItems is evidence.selected_count. omittedEvidenceIds is an array.
 *
 * Serialization preserves selection order and reads only the supplied view.
 * The view and all referenced data must remain valid throughout the call and
 * must not overlap out. All offsets and counts fit in JSON safe integers.
 * The caller can supply a hand-built ReviewContext for package tests.
 *
 * Returns byte length excluding NUL. Query with NULL, 0. A short buffer
 * returns required length and is untouched. A sufficient buffer is
 * NUL-terminated. Invalid input returns CHRONOS_INVALID_ARGUMENT. Oversized
 * output or coordinates return CHRONOS_TOO_LARGE. Errors leave out untouched. */
int context_write_json(const ReviewContext *context, char *out, size_t out_size);

#ifdef __cplusplus
}
#endif
#endif
