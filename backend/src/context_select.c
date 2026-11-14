#include "context_select.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static int valid_coverage(ChronosCoverage coverage)
{
    return (unsigned)coverage <= CHRONOS_UNAVAILABLE;
}

static int valid_candidate(const ContextCandidate *candidate)
{
    if (candidate == NULL || candidate->id == NULL || *candidate->id == '\0' ||
        candidate->call == NULL) return 0;
    switch (candidate->direction) {
    case CONTEXT_INCOMING_CALL:
        return candidate->call->resolution == CALL_RESOLVED;
    case CONTEXT_OUTGOING_CALL:
        return (unsigned)candidate->call->resolution <= CALL_AMBIGUOUS;
    default:
        return 0;
    }
}

static double candidate_relevance(const ContextCandidate *candidate)
{
    if (candidate->direction == CONTEXT_INCOMING_CALL) return 1.0;
    switch (candidate->call->resolution) {
    case CALL_RESOLVED: return 0.9;
    case CALL_AMBIGUOUS: return 0.5;
    case CALL_UNRESOLVED: return 0.25;
    default: return 0.0;
    }
}

static int compare_ranked(const void *left, const void *right)
{
    const ContextRankedItem *a = left;
    const ContextRankedItem *b = right;
    if (a->relevance > b->relevance) return -1;
    if (a->relevance < b->relevance) return 1;
    return strcmp(a->candidate->id, b->candidate->id);
}

void context_ranking_free(ContextRanking *ranking)
{
    if (ranking == NULL) return;
    free((void *)ranking->items);
    *ranking = (ContextRanking){0};
}

int context_rank_candidates(const ContextCandidates *candidates, ContextRanking *out)
{
    if (candidates == NULL || out == NULL || !valid_coverage(candidates->coverage) ||
        (candidates->coverage == CHRONOS_UNAVAILABLE &&
         (candidates->items != NULL || candidates->count != 0)) ||
        (candidates->count != 0 && candidates->items == NULL))
        return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < candidates->count; ++i)
        if (!valid_candidate(&candidates->items[i])) return CHRONOS_INVALID_ARGUMENT;

    ContextRankedItem *items = candidates->count
        ? calloc(candidates->count, sizeof *items) : NULL;
    if (candidates->count != 0 && items == NULL) return CHRONOS_OUT_OF_MEMORY;
    for (size_t i = 0; i < candidates->count; ++i) {
        items[i] = (ContextRankedItem){
            &candidates->items[i], candidate_relevance(&candidates->items[i])
        };
    }
    if (candidates->count > 1)
        qsort(items, candidates->count, sizeof *items, compare_ranked);
    *out = (ContextRanking){items, candidates->count, candidates->coverage};
    return candidates->coverage == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;
}

void context_selection_free(ContextSelection *selection)
{
    if (selection == NULL) return;
    free((void *)selection->selected);
    free((void *)selection->omitted_ids);
    *selection = (ContextSelection){0};
}

int context_select(const ContextRanking *ranking, const ContextBudget *budget,
                   ContextSelection *out)
{
    if (ranking == NULL || budget == NULL || out == NULL ||
        !valid_coverage(ranking->coverage) ||
        (ranking->coverage == CHRONOS_UNAVAILABLE &&
         (ranking->items != NULL || ranking->count != 0)) ||
        (ranking->count != 0 && ranking->items == NULL))
        return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < ranking->count; ++i) {
        if (ranking->items[i].candidate == NULL ||
            ranking->items[i].candidate->id == NULL) return CHRONOS_INVALID_ARGUMENT;
        if (!isfinite(ranking->items[i].relevance) ||
            ranking->items[i].relevance < 0.0 || ranking->items[i].relevance > 1.0)
            return CHRONOS_INVALID_ARGUMENT;
    }

    size_t selected_capacity = ranking->count < budget->max_items
        ? ranking->count : budget->max_items;
    ContextRankedItem *selected = selected_capacity
        ? calloc(selected_capacity, sizeof *selected) : NULL;
    const char **omitted = ranking->count
        ? calloc(ranking->count, sizeof *omitted) : NULL;
    if ((selected_capacity && selected == NULL) ||
        (ranking->count && omitted == NULL)) {
        free(selected);
        free(omitted);
        return CHRONOS_OUT_OF_MEMORY;
    }

    ContextSelection result = {.coverage = ranking->coverage};
    size_t remaining_items = budget->max_items;
    size_t remaining_bytes = budget->max_source_bytes;
    for (size_t i = 0; i < ranking->count; ++i) {
        const ContextCandidate *candidate = ranking->items[i].candidate;
        size_t cost = candidate->snippet.status == CONTEXT_SOURCE_PRESENT
            ? candidate->snippet.byte_count : 0;
        if (remaining_items == 0 || cost > remaining_bytes) {
            omitted[result.omitted_count++] = candidate->id;
            continue;
        }
        selected[result.selected_count++] = ranking->items[i];
        --remaining_items;
        remaining_bytes -= cost;
        result.used_source_bytes += cost;
    }
    if (result.selected_count != 0) {
        result.selected = selected;
    } else {
        free(selected);
    }
    if (result.omitted_count != 0) {
        result.omitted_ids = omitted;
    } else {
        free(omitted);
    }
    *out = result;
    return ranking->coverage == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;
}
