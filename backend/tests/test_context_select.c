#include "context_select.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const RevisionRef REVISION = {
    "example/context", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};
static const SymbolVersionRef TARGET = {
    REVISION, "[\"target.c\",\"target\",\"function\",\"definition\",0,40]"
};
static const SymbolVersionRef NEIGHBOR_A = {
    REVISION, "[\"a.c\",\"a\",\"function\",\"definition\",0,40]"
};
static const SymbolVersionRef NEIGHBOR_B = {
    REVISION, "[\"b.c\",\"b\",\"function\",\"definition\",0,10]"
};
static const SourceLocation CALL_SITE = {
    REVISION, "target.c", {10, 20, 1, 1}
};
static const char SNIPPET_40[] = "1234567890123456789012345678901234567890";
static const char SNIPPET_70[] =
    "1234567890123456789012345678901234567890123456789012345678901234567890";
static const char SNIPPET_10[] = "1234567890";
static const char SNIPPET_5[] = "12345";
static const SourceLocation LOCATION_40 = {
    REVISION, "a.c", {0, sizeof SNIPPET_40 - 1, 1, 1}
};
static const SourceLocation LOCATION_70 = {
    REVISION, "m.c", {0, sizeof SNIPPET_70 - 1, 1, 1}
};
static const SourceLocation LOCATION_10 = {
    REVISION, "b.c", {0, sizeof SNIPPET_10 - 1, 1, 1}
};
static const SourceLocation LOCATION_5 = {
    REVISION, "c.c", {0, sizeof SNIPPET_5 - 1, 1, 1}
};

static void test_ranking_and_selection(void)
{
    const SymbolVersionRef ambiguous_candidates[] = {NEIGHBOR_A, NEIGHBOR_B};
    const GraphCall incoming_z = {
        .caller = NEIGHBOR_A, .callee_text = "target", .call_site = CALL_SITE,
        .resolution = CALL_RESOLVED, .callee = &TARGET
    };
    const GraphCall incoming_a = {
        .caller = NEIGHBOR_B, .callee_text = "target", .call_site = CALL_SITE,
        .resolution = CALL_RESOLVED, .callee = &TARGET
    };
    const GraphCall outgoing_m = {
        .caller = TARGET, .callee_text = "m", .call_site = CALL_SITE,
        .resolution = CALL_RESOLVED, .callee = &NEIGHBOR_A
    };
    const GraphCall outgoing_b = {
        .caller = TARGET, .callee_text = "save", .call_site = CALL_SITE,
        .resolution = CALL_AMBIGUOUS, .candidates = ambiguous_candidates,
        .candidate_count = 2
    };
    const GraphCall outgoing_c = {
        .caller = TARGET, .callee_text = "missing", .call_site = CALL_SITE,
        .resolution = CALL_UNRESOLVED
    };
    const ContextCandidate candidates[] = {
        {"z", CONTEXT_INCOMING_CALL, &incoming_z,
         {CONTEXT_SOURCE_UNAVAILABLE, NULL, NULL, 0}},
        {"a", CONTEXT_INCOMING_CALL, &incoming_a,
         {CONTEXT_SOURCE_PRESENT, &LOCATION_40, SNIPPET_40, sizeof SNIPPET_40 - 1}},
        {"m", CONTEXT_OUTGOING_CALL, &outgoing_m,
         {CONTEXT_SOURCE_PRESENT, &LOCATION_70, SNIPPET_70, sizeof SNIPPET_70 - 1}},
        {"b", CONTEXT_OUTGOING_CALL, &outgoing_b,
         {CONTEXT_SOURCE_PRESENT, &LOCATION_10, SNIPPET_10, sizeof SNIPPET_10 - 1}},
        {"c", CONTEXT_OUTGOING_CALL, &outgoing_c,
         {CONTEXT_SOURCE_PRESENT, &LOCATION_5, SNIPPET_5, sizeof SNIPPET_5 - 1}}
    };
    const ContextCandidates input = {
        candidates, sizeof candidates / sizeof candidates[0], CHRONOS_COMPLETE
    };
    ContextRanking ranking = {0};
    assert(context_rank_candidates(&input, &ranking) == CHRONOS_OK);
    assert(ranking.count == 5 && ranking.coverage == CHRONOS_COMPLETE);
    const char *order[] = {"a", "z", "m", "b", "c"};
    for (size_t i = 0; i < 5; ++i)
        assert(strcmp(ranking.items[i].candidate->id, order[i]) == 0);
    assert(ranking.items[0].relevance == 1.0);
    assert(ranking.items[1].relevance == 1.0);
    assert(ranking.items[2].relevance == 0.9);
    assert(ranking.items[3].relevance == 0.5);
    assert(ranking.items[4].relevance == 0.25);

    const ContextBudget budget = {3, 100};
    ContextSelection selection = {0};
    assert(context_select(&ranking, &budget, &selection) == CHRONOS_OK);
    assert(selection.selected_count == 3);
    assert(strcmp(selection.selected[0].candidate->id, "a") == 0);
    assert(strcmp(selection.selected[1].candidate->id, "z") == 0);
    assert(strcmp(selection.selected[2].candidate->id, "b") == 0);
    assert(selection.used_source_bytes == sizeof SNIPPET_40 + sizeof SNIPPET_10 - 2);
    assert(selection.omitted_count == 2);
    assert(strcmp(selection.omitted_ids[0], "m") == 0);
    assert(strcmp(selection.omitted_ids[1], "c") == 0);
    assert(selection.coverage == CHRONOS_COMPLETE);

    ContextSelection zero_items = {0};
    const ContextBudget no_items = {0, 100};
    assert(context_select(&ranking, &no_items, &zero_items) == CHRONOS_OK);
    assert(zero_items.selected_count == 0 && zero_items.selected == NULL);
    assert(zero_items.omitted_count == 5);
    assert(zero_items.used_source_bytes == 0);

    ContextSelection zero_bytes = {0};
    const ContextBudget no_bytes = {5, 0};
    assert(context_select(&ranking, &no_bytes, &zero_bytes) == CHRONOS_OK);
    assert(zero_bytes.selected_count == 1);
    assert(strcmp(zero_bytes.selected[0].candidate->id, "z") == 0);
    assert(zero_bytes.used_source_bytes == 0);
    assert(zero_bytes.omitted_count == 4);

    context_selection_free(&zero_items);
    context_selection_free(&zero_bytes);
    context_selection_free(&selection);
    context_ranking_free(&ranking);
    assert(ranking.items == NULL && ranking.count == 0);

    ContextCandidates incomplete = input;
    incomplete.coverage = CHRONOS_INCOMPLETE;
    assert(context_rank_candidates(&incomplete, &ranking) == CHRONOS_PARTIAL);
    assert(ranking.coverage == CHRONOS_INCOMPLETE);
    context_ranking_free(&ranking);
}

static void test_invalid_inputs(void)
{
    ContextRanking ranking = {0};
    assert(context_rank_candidates(NULL, &ranking) == CHRONOS_INVALID_ARGUMENT);
    ContextCandidates unavailable = {NULL, 0, CHRONOS_UNAVAILABLE};
    assert(context_rank_candidates(&unavailable, &ranking) == CHRONOS_PARTIAL);
    assert(ranking.items == NULL && ranking.count == 0);
    context_ranking_free(&ranking);
    const ContextCandidate bad_candidate = {
        "bad", CONTEXT_OUTGOING_CALL, NULL,
        {CONTEXT_SOURCE_UNAVAILABLE, NULL, NULL, 0}
    };
    const ContextCandidates broken = {&bad_candidate, 1, CHRONOS_COMPLETE};
    assert(context_rank_candidates(&broken, &ranking) == CHRONOS_INVALID_ARGUMENT);

    const ContextBudget budget = {1, 1};
    ContextSelection selection = {0};
    assert(context_select(NULL, &budget, &selection) == CHRONOS_INVALID_ARGUMENT);
}

int main(void)
{
    test_ranking_and_selection();
    test_invalid_inputs();
    puts("context ranking and selection tests passed");
    return 0;
}
