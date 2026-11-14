#include "context_package.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const RevisionRef BASE = {
    "example/context", "1111111111111111111111111111111111111111"
};
static const RevisionRef HEAD = {
    "example/context", "2222222222222222222222222222222222222222"
};
static const SymbolVersionRef TARGET = {
    HEAD, "[\"target.c\",\"target\",\"function\",\"definition\",0,27]"
};
static const SymbolVersionRef NEIGHBOR = {
    HEAD, "[\"other.c\",\"helper\",\"function\",\"definition\",0,29]"
};
static const SymbolVersionRef CANDIDATE_A = {
    HEAD, "[\"a.c\",\"save\",\"function\",\"definition\",0,10]"
};
static const SymbolVersionRef CANDIDATE_B = {
    HEAD, "[\"b.c\",\"save\",\"function\",\"definition\",0,10]"
};
static const char PREVIOUS_SOURCE[] = "int target() { return 0; }";
static const char CURRENT_SOURCE[] = "int target() { return 1; }";
static const char HELPER_SOURCE[] = "int helper(void) { return 1; }";
static const SourceLocation PREVIOUS_LOCATION = {
    BASE, "target.c", {0, sizeof PREVIOUS_SOURCE - 1, 1, 1}
};
static const SourceLocation CURRENT_LOCATION = {
    HEAD, "target.c", {0, sizeof CURRENT_SOURCE - 1, 1, 1}
};
static const SourceLocation HELPER_LOCATION = {
    HEAD, "other.c", {0, sizeof HELPER_SOURCE - 1, 1, 1}
};
static const SourceLocation CALL_SITE = {
    HEAD, "target.c", {10, 20, 1, 1}
};

static char *serialize(const ReviewContext *context)
{
    char guard[] = "guard";
    int length = context_write_json(context, NULL, 0);
    assert(length > 0);
    assert(context_write_json(context, guard, sizeof guard) == length);
    assert(strcmp(guard, "guard") == 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_write_json(context, json, (size_t)length + 1) == length);
    assert(json[length] == '\0');
    return json;
}

static void assert_contains(const char *json, const char *fragment)
{
    if (strstr(json, fragment) == NULL) {
        fprintf(stderr, "missing fragment: %s\njson: %s\n", fragment, json);
        assert(0);
    }
}

int main(void)
{
    const GraphComparison comparison = {BASE, HEAD};
    const SymbolVersionRef ambiguous_candidates[] = {CANDIDATE_A, CANDIDATE_B};
    const GraphCall incoming = {
        .caller = NEIGHBOR, .callee_text = "target", .call_site = CALL_SITE,
        .resolution = CALL_RESOLVED, .callee = &TARGET
    };
    const GraphCall outgoing = {
        .caller = TARGET, .callee_text = "helper", .call_site = CALL_SITE,
        .resolution = CALL_RESOLVED, .callee = &NEIGHBOR
    };
    const GraphCall ambiguous = {
        .caller = TARGET, .callee_text = "save", .call_site = CALL_SITE,
        .resolution = CALL_AMBIGUOUS, .candidates = ambiguous_candidates,
        .candidate_count = 2
    };
    const GraphCall unresolved = {
        .caller = TARGET, .callee_text = "missing", .call_site = CALL_SITE,
        .resolution = CALL_UNRESOLVED
    };
    const ContextCandidate candidates[] = {
        {"ev-in", CONTEXT_INCOMING_CALL, &incoming,
         {CONTEXT_SOURCE_PRESENT, &HELPER_LOCATION, HELPER_SOURCE,
          sizeof HELPER_SOURCE - 1}},
        {"ev-out", CONTEXT_OUTGOING_CALL, &outgoing,
         {CONTEXT_SOURCE_PRESENT, &HELPER_LOCATION, HELPER_SOURCE,
          sizeof HELPER_SOURCE - 1}},
        {"ev-amb", CONTEXT_OUTGOING_CALL, &ambiguous,
         {CONTEXT_SOURCE_UNAVAILABLE, NULL, NULL, 0}},
        {"ev-miss", CONTEXT_OUTGOING_CALL, &unresolved,
         {CONTEXT_SOURCE_UNAVAILABLE, NULL, NULL, 0}}
    };
    const ContextRankedItem selected[] = {
        {&candidates[0], 1.0},
        {&candidates[1], 0.9},
        {&candidates[2], 0.5}
    };
    const char *omitted[] = {"ev-miss"};
    const ChronosDiagnostic diagnostics[] = {
        {"context-test", DIAGNOSTIC_INFO, "contract fixture", NULL}
    };
    const ReviewContext context = {
        .target = TARGET,
        .comparison = &comparison,
        .previous = {CONTEXT_SOURCE_PRESENT, &PREVIOUS_LOCATION, PREVIOUS_SOURCE,
                     sizeof PREVIOUS_SOURCE - 1},
        .current = {CONTEXT_SOURCE_PRESENT, &CURRENT_LOCATION, CURRENT_SOURCE,
                    sizeof CURRENT_SOURCE - 1},
        .budget = {3, 4096},
        .evidence = {selected, 3, omitted, 1,
                     sizeof HELPER_SOURCE - 1, CHRONOS_COMPLETE},
        .diagnostics = diagnostics,
        .diagnostic_count = 1
    };

    char *json = serialize(&context);
    assert_contains(json, "\"schemaVersion\":1");
    assert_contains(json, "\"target\":{\"revision\":");
    assert_contains(json, "\"comparison\":{\"base\":");
    assert_contains(json, "\"previous\":{\"status\":\"present\",\"location\":{");
    assert_contains(json, "\"current\":{\"status\":\"present\",\"location\":{");
    assert_contains(json, "\"source\":\"int helper(void) { return 1; }\"");
    assert_contains(json, "\"evidence\":{\"status\":\"complete\",\"items\":[");
    assert_contains(json, "\"direction\":\"incoming\"");
    assert_contains(json, "\"direction\":\"outgoing\"");
    assert_contains(json, "\"resolution\":\"ambiguous\"");
    assert_contains(json, "\"snippet\":{\"status\":\"unavailable\"");
    assert_contains(json, "\"relevance\":1.000000");
    assert_contains(json, "\"relevance\":0.500000");
    assert_contains(json, "\"budget\":{\"maxItems\":3,\"maxSourceBytes\":4096,"
                           "\"usedItems\":3,\"usedSourceBytes\":");
    assert_contains(json, "\"omittedEvidenceIds\":[\"ev-miss\"]");
    assert_contains(json, "\"diagnostics\":[{\"code\":\"context-test\"");
    free(json);

    ReviewContext missing = context;
    missing.previous = (ContextSource){CONTEXT_SOURCE_UNAVAILABLE, NULL, NULL, 0};
    missing.current = (ContextSource){CONTEXT_SOURCE_UNAVAILABLE, NULL, NULL, 0};
    missing.evidence = (ContextSelection){
        selected, 1, NULL, 0, 0, CHRONOS_COMPLETE
    };
    json = serialize(&missing);
    assert_contains(json, "\"previous\":{\"status\":\"unavailable\","
                           "\"location\":null,\"source\":null}");
    assert_contains(json, "\"current\":{\"status\":\"unavailable\","
                           "\"location\":null,\"source\":null}");
    assert_contains(json, "\"snippet\":{\"status\":\"present\"");
    free(json);

    ReviewContext unavailable = context;
    unavailable.evidence = (ContextSelection){
        NULL, 0, NULL, 0, 0, CHRONOS_UNAVAILABLE
    };
    json = serialize(&unavailable);
    assert_contains(json, "\"evidence\":{\"status\":\"unavailable\",\"items\":null}");
    free(json);

    ReviewContext invalid = context;
    invalid.previous.byte_count--;
    assert(context_write_json(&invalid, NULL, 0) == CHRONOS_INVALID_ARGUMENT);
    invalid = context;
    invalid.evidence.coverage = CHRONOS_UNAVAILABLE;
    assert(context_write_json(&invalid, NULL, 0) == CHRONOS_INVALID_ARGUMENT);
    invalid = context;
    invalid.evidence.omitted_ids = NULL;
    assert(context_write_json(&invalid, NULL, 0) == CHRONOS_INVALID_ARGUMENT);
    assert(context_write_json(NULL, NULL, 0) == CHRONOS_INVALID_ARGUMENT);
    char guard[] = "guard";
    assert(context_write_json(&context, guard, sizeof guard) > 0);
    assert(strcmp(guard, "guard") == 0);

    puts("context package JSON tests passed");
    return 0;
}
