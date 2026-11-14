/*
 * Contract tests for the context compiler: request validation, stable IDs,
 * graph/brief shape, evidence references, and serialization guards.
 */
#include "context_compiler.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const RevisionRef BASE_REVISION = {
    "example/payments", "1111111111111111111111111111111111111111"
};
static const RevisionRef HEAD_REVISION = {
    "example/payments", "2222222222222222222222222222222222222222"
};
static const GitRepository REPOSITORY = {
    "example/payments", "contracts/fixtures/payments"
};
static const GraphComparison COMPARISON = {BASE_REVISION, HEAD_REVISION};

static const SymbolVersionRef PAY_REF = {
    HEAD_REVISION, "[\"payments/payment.c\",\"pay\",\"function\",\"definition\",0,35]"
};
static const SymbolVersionRef VALIDATE_REF = {
    HEAD_REVISION,
    "[\"shared/checks/validation.c\",\"validate\",\"function\",\"definition\",0,30]"
};

static const SourceLocation PAY_LOCATION = {
    HEAD_REVISION, "payments/payment.c", {0, 35, 1, 1}
};
static const SourceLocation VALIDATE_LOCATION = {
    HEAD_REVISION, "shared/checks/validation.c", {0, 30, 1, 1}
};
static const SourceLocation PAY_CALL_LOCATION = {
    HEAD_REVISION, "payments/payment.c", {16, 26, 1, 1}
};
static const SourceLocation VALIDATE_CALL_LOCATION = {
    HEAD_REVISION, "shared/checks/validation.c", {0, 9, 1, 1}
};
static const SourceLocation MISSING_CALL_LOCATION = {
    HEAD_REVISION, "payments/payment.c", {27, 34, 1, 1}
};

static char *serialize_request(const ContextRequest *request)
{
    char guard[] = "guard";
    int length = context_request_write_json(request, NULL, 0);
    assert(length > 0);
    assert(context_request_write_json(request, guard, sizeof guard) == length);
    assert(strcmp(guard, "guard") == 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_request_write_json(request, json, (size_t)length + 1) == length);
    assert(json[length] == '\0');
    return json;
}

static char *serialize_graph(const ContextGraph *graph)
{
    char guard[] = "guard";
    int length = context_graph_write_json(graph, NULL, 0);
    assert(length > 0);
    assert(context_graph_write_json(graph, guard, sizeof guard) == length);
    assert(strcmp(guard, "guard") == 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_graph_write_json(graph, json, (size_t)length + 1) == length);
    assert(json[length] == '\0');
    return json;
}

static char *serialize_brief(const ContextBrief *brief)
{
    char guard[] = "guard";
    int length = context_brief_write_json(brief, NULL, 0);
    assert(length > 0);
    assert(context_brief_write_json(brief, guard, sizeof guard) == length);
    assert(strcmp(guard, "guard") == 0);
    char *json = malloc((size_t)length + 1);
    assert(json != NULL);
    assert(context_brief_write_json(brief, json, (size_t)length + 1) == length);
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

static const ContextEvidence *find_evidence(const ContextEvidence *items, size_t count,
                                            const char *id)
{
    for (size_t i = 0; i < count; ++i)
        if (strcmp(items[i].id, id) == 0) return &items[i];
    return NULL;
}

static const ContextGraphNode *find_node(const ContextGraphNode *items, size_t count,
                                         const char *id)
{
    for (size_t i = 0; i < count; ++i)
        if (strcmp(items[i].id, id) == 0) return &items[i];
    return NULL;
}

static int has_edge_state(const ContextGraph *graph, ContextRelationState state)
{
    for (size_t i = 0; i < graph->edge_count; ++i)
        if (graph->edges[i].state == state) return 1;
    return 0;
}

/* These checks mirror the properties a consumer needs. The fixture is then
 * compared byte-for-byte with the serialization of these validated objects. */
static void validate_contract_objects(const ContextGraph *graph, const ContextBrief *brief,
                                      const ContextRequest *request)
{
    for (size_t i = 0; i < graph->node_count; ++i) {
        for (size_t j = i + 1; j < graph->node_count; ++j)
            assert(strcmp(graph->nodes[i].id, graph->nodes[j].id) != 0);
    }
    for (size_t i = 0; i < graph->edge_count; ++i) {
        for (size_t j = i + 1; j < graph->edge_count; ++j)
            assert(strcmp(graph->edges[i].id, graph->edges[j].id) != 0);
        const ContextGraphEdge *edge = &graph->edges[i];
        assert(edge->evidence_id != NULL);
        assert(find_evidence(graph->evidence, graph->evidence_count, edge->evidence_id) != NULL);
        if (edge->state == CONTEXT_RELATION_SELECTED ||
            edge->state == CONTEXT_RELATION_OMITTED)
            assert(find_node(graph->nodes, graph->node_count, edge->to) != NULL);
        if (edge->state == CONTEXT_RELATION_UNRESOLVED ||
            edge->state == CONTEXT_RELATION_AMBIGUOUS)
            assert(edge->to == NULL);
    }
    for (size_t i = 0; i < graph->evidence_count; ++i) {
        for (size_t j = i + 1; j < graph->evidence_count; ++j)
            assert(strcmp(graph->evidence[i].id, graph->evidence[j].id) != 0);
        assert(find_evidence(brief->evidence, brief->evidence_count,
                             graph->evidence[i].id) != NULL);
    }
    for (size_t i = 0; i < brief->section_count; ++i) {
        const ContextBriefSection *section = &brief->sections[i];
        for (size_t j = 0; j < section->item_count; ++j) {
            const ContextBriefItem *item = &section->items[j];
            for (size_t k = 0; k < item->evidence_count; ++k)
                assert(find_evidence(graph->evidence, graph->evidence_count,
                                     item->evidence_ids[k]) != NULL);
        }
    }
    for (size_t i = 0; i < brief->omitted_count; ++i) {
        const ContextEvidence *evidence =
            find_evidence(graph->evidence, graph->evidence_count, brief->omitted_ids[i]);
        assert(evidence != NULL && evidence->state == CONTEXT_RELATION_OMITTED);
    }
    assert(brief->evidence_count == graph->evidence_count);
    assert(has_edge_state(graph, CONTEXT_RELATION_SELECTED));
    assert(has_edge_state(graph, CONTEXT_RELATION_OMITTED));
    assert(has_edge_state(graph, CONTEXT_RELATION_UNRESOLVED));
    assert(has_edge_state(graph, CONTEXT_RELATION_UNAVAILABLE));
    assert(brief->used_source_bytes <= request->budget.max_source_bytes);
}

int main(void)
{
    char *project_id = context_scope_id_alloc(CONTEXT_SCOPE_PROJECT, NULL, NULL);
    char *payments_id = context_scope_id_alloc(CONTEXT_SCOPE_MODULE, "payments", NULL);
    char *shared_id = context_scope_id_alloc(CONTEXT_SCOPE_MODULE, "shared", NULL);
    char *checks_id = context_scope_id_alloc(CONTEXT_SCOPE_MODULE, "shared/checks", NULL);
    char *payment_file_id = context_scope_id_alloc(CONTEXT_SCOPE_FILE, "payments/payment.c", NULL);
    char *validation_file_id =
        context_scope_id_alloc(CONTEXT_SCOPE_FILE, "shared/checks/validation.c", NULL);
    char *pay_versioned_id = context_scope_id_alloc(CONTEXT_SCOPE_SYMBOL, NULL, &PAY_REF);
    GraphSymbol logical_pay = {
        .ref = PAY_REF, .logical_id = "[\"payments/payment.c\",\"pay\"]"
    };
    GraphSymbol logical_validate = {
        .ref = VALIDATE_REF, .logical_id = "[\"shared/checks/validation.c\",\"validate\"]"
    };
    char *pay_id = context_symbol_scope_id_alloc(&logical_pay);
    char *validate_id = context_symbol_scope_id_alloc(&logical_validate);
    assert(project_id && payments_id && shared_id && checks_id && payment_file_id &&
           validation_file_id && pay_versioned_id && pay_id && validate_id);

    assert(strcmp(project_id, "[\"project\"]") == 0);
    assert(strcmp(payments_id, "[\"module\",\"payments\"]") == 0);
    assert(strcmp(pay_versioned_id, "[\"symbol\",[\"payments/payment.c\",\"pay\",\"function\","
                                   "\"definition\",0,35]]") == 0);
    assert(strcmp(pay_id, "[\"symbol\",[\"payments/payment.c\",\"pay\"]]") == 0);
    assert(strcmp(validate_id,
                  "[\"symbol\",[\"shared/checks/validation.c\",\"validate\"]]") == 0);

    GraphCall selected_call = {
        .caller = PAY_REF, .callee_text = "validate", .call_site = PAY_CALL_LOCATION,
        .resolution = CALL_RESOLVED, .callee = &VALIDATE_REF
    };
    GraphCall omitted_call = {
        .caller = VALIDATE_REF, .callee_text = "pay",
        .call_site = VALIDATE_CALL_LOCATION, .resolution = CALL_RESOLVED, .callee = &PAY_REF
    };
    GraphCall unresolved_call = {
        .caller = PAY_REF, .callee_text = "missing", .call_site = MISSING_CALL_LOCATION,
        .resolution = CALL_UNRESOLVED
    };

    char *pay_source_evidence = context_symbol_evidence_id_alloc(&PAY_REF);
    char *validate_source_evidence = context_symbol_evidence_id_alloc(&VALIDATE_REF);
    char *selected_evidence = context_call_evidence_id_alloc(&selected_call);
    char *omitted_evidence = context_call_evidence_id_alloc(&omitted_call);
    char *unresolved_evidence = context_call_evidence_id_alloc(&unresolved_call);
    assert(pay_source_evidence && validate_source_evidence && selected_evidence &&
           omitted_evidence && unresolved_evidence);

    assert(strncmp(pay_source_evidence, "source:v1:", 10) == 0);
    assert(strstr(pay_source_evidence, PAY_REF.id) != NULL);
    assert(strncmp(selected_evidence, "call:v1:", 8) == 0);
    assert(strstr(selected_evidence, PAY_REF.id) != NULL);
    assert(strstr(selected_evidence, VALIDATE_REF.id) != NULL);
    assert(strstr(selected_evidence, ":16:26") != NULL);
    char *selected_evidence_again = context_call_evidence_id_alloc(&selected_call);
    assert(selected_evidence_again != NULL);
    assert(strcmp(selected_evidence, selected_evidence_again) == 0);
    assert(strcmp(unresolved_evidence, selected_evidence) != 0);

    char *contains_root_payments = context_contains_evidence_id_alloc(project_id, payments_id);
    char *contains_root_shared = context_contains_evidence_id_alloc(project_id, shared_id);
    char *contains_shared_checks = context_contains_evidence_id_alloc(shared_id, checks_id);
    char *contains_payment_file =
        context_contains_evidence_id_alloc(payments_id, payment_file_id);
    char *contains_validation_file =
        context_contains_evidence_id_alloc(checks_id, validation_file_id);
    char *contains_payment_pay =
        context_contains_evidence_id_alloc(payment_file_id, pay_id);
    char *contains_validation_validate =
        context_contains_evidence_id_alloc(validation_file_id, validate_id);
    char *unavailable_contains =
        context_contains_evidence_id_alloc(checks_id, "unavailable:shared/checks/generated.c");
    assert(contains_root_payments && contains_root_shared && contains_shared_checks &&
           contains_payment_file && contains_validation_file && contains_payment_pay &&
           contains_validation_validate && unavailable_contains);

    const ContextGraphNode nodes[] = {
        {project_id, CONTEXT_SCOPE_PROJECT, NULL, "example/payments", NULL,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED},
        {payments_id, CONTEXT_SCOPE_MODULE, project_id, "payments", NULL,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED},
        {shared_id, CONTEXT_SCOPE_MODULE, project_id, "shared", NULL,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED},
        {checks_id, CONTEXT_SCOPE_MODULE, shared_id, "shared/checks", NULL,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED},
        {payment_file_id, CONTEXT_SCOPE_FILE, payments_id, "payments/payment.c", NULL,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED},
        {validation_file_id, CONTEXT_SCOPE_FILE, checks_id, "shared/checks/validation.c", NULL,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED},
        {pay_id, CONTEXT_SCOPE_SYMBOL, payment_file_id, "pay", &PAY_REF,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED},
        {validate_id, CONTEXT_SCOPE_SYMBOL, validation_file_id, "validate", &VALIDATE_REF,
         CHRONOS_COMPLETE, CONTEXT_RELATION_SELECTED}
    };
    const ContextGraphEdge edges[] = {
        {contains_root_payments, project_id, payments_id, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_SELECTED, contains_root_payments, NULL},
        {contains_root_shared, project_id, shared_id, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_SELECTED, contains_root_shared, NULL},
        {contains_shared_checks, shared_id, checks_id, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_SELECTED, contains_shared_checks, NULL},
        {contains_payment_file, payments_id, payment_file_id, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_SELECTED, contains_payment_file, NULL},
        {contains_validation_file, checks_id, validation_file_id, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_SELECTED, contains_validation_file, NULL},
        {contains_payment_pay, payment_file_id, pay_id, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_SELECTED, contains_payment_pay, NULL},
        {contains_validation_validate, validation_file_id, validate_id,
         CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_SELECTED,
         contains_validation_validate, NULL},
        {selected_evidence, pay_id, validate_id, CONTEXT_EVIDENCE_CALL,
         CONTEXT_RELATION_SELECTED, selected_evidence, &selected_call},
        {omitted_evidence, validate_id, pay_id, CONTEXT_EVIDENCE_CALL,
         CONTEXT_RELATION_OMITTED, omitted_evidence, &omitted_call},
        {unresolved_evidence, pay_id, NULL, CONTEXT_EVIDENCE_CALL,
         CONTEXT_RELATION_UNRESOLVED, unresolved_evidence, &unresolved_call},
        {unavailable_contains, checks_id, NULL, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_UNAVAILABLE, unavailable_contains, NULL}
    };
    const ContextEvidence evidence[] = {
        {pay_source_evidence, CONTEXT_EVIDENCE_SOURCE, CONTEXT_RELATION_SELECTED,
         &PAY_LOCATION, NULL},
        {validate_source_evidence, CONTEXT_EVIDENCE_SOURCE, CONTEXT_RELATION_SELECTED,
         &VALIDATE_LOCATION, NULL},
        {contains_root_payments, CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_SELECTED,
         NULL, NULL},
        {contains_root_shared, CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_SELECTED,
         NULL, NULL},
        {contains_shared_checks, CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_SELECTED,
         NULL, NULL},
        {contains_payment_file, CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_SELECTED,
         NULL, NULL},
        {contains_validation_file, CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_SELECTED,
         NULL, NULL},
        {contains_payment_pay, CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_SELECTED,
         &PAY_LOCATION, NULL},
        {contains_validation_validate, CONTEXT_EVIDENCE_CONTAINS,
         CONTEXT_RELATION_SELECTED, &VALIDATE_LOCATION, NULL},
        {selected_evidence, CONTEXT_EVIDENCE_CALL, CONTEXT_RELATION_SELECTED,
         &PAY_CALL_LOCATION, &selected_call},
        {omitted_evidence, CONTEXT_EVIDENCE_CALL, CONTEXT_RELATION_OMITTED,
         &VALIDATE_CALL_LOCATION, &omitted_call},
        {unresolved_evidence, CONTEXT_EVIDENCE_CALL, CONTEXT_RELATION_UNRESOLVED,
         &MISSING_CALL_LOCATION, &unresolved_call},
        {unavailable_contains, CONTEXT_EVIDENCE_CONTAINS, CONTEXT_RELATION_UNAVAILABLE,
         NULL, NULL}
    };

    const ContextRequest request = {
        .schema_version = CHRONOS_COMPILER_REQUEST_SCHEMA_VERSION,
        .repository = &REPOSITORY,
        .head = HEAD_REVISION,
        .base = &BASE_REVISION,
        .mode = CONTEXT_MODE_REVIEW,
        .anchors = &(ContextAnchor){CONTEXT_ANCHOR_SYMBOL, NULL, &PAY_REF},
        .anchor_count = 1,
        .max_hops = 3,
        .budget = {8, 4096}
    };
    assert(context_request_validate(&request) == CHRONOS_OK);

    ContextRequest invalid = request;
    invalid.mode = CONTEXT_MODE_TASK;
    assert(context_request_validate(&invalid) == CHRONOS_OK);
    const ContextAnchor path_anchor = {CONTEXT_ANCHOR_PATH, "payments/payment.c", NULL};
    invalid.anchors = &path_anchor;
    assert(context_request_validate(&invalid) == CHRONOS_OK);
    invalid.mode = CONTEXT_MODE_REVIEW;
    assert(context_request_validate(&invalid) == CHRONOS_INVALID_ARGUMENT);
    invalid = request;
    invalid.anchor_count = 0;
    assert(context_request_validate(&invalid) == CHRONOS_INVALID_ARGUMENT);
    invalid = request;
    invalid.max_hops = CHRONOS_COMPILER_MAX_HOPS + 1;
    assert(context_request_validate(&invalid) == CHRONOS_INVALID_ARGUMENT);
    invalid = request;
    invalid.head.commit_sha = "not-a-sha";
    assert(context_request_validate(&invalid) == CHRONOS_INVALID_ARGUMENT);
    invalid = request;
    invalid.budget.max_items = 0;
    invalid.budget.max_source_bytes = 0;
    assert(context_request_validate(&invalid) == CHRONOS_OK);
    const ContextAnchor changed_anchor = {CONTEXT_ANCHOR_CHANGED_SYMBOL, NULL, &PAY_REF};
    invalid = request;
    invalid.base = NULL;
    invalid.mode = CONTEXT_MODE_TASK;
    invalid.anchors = &changed_anchor;
    assert(context_request_validate(&invalid) == CHRONOS_INVALID_ARGUMENT);

    const ContextGraph graph = {
        .schema_version = CHRONOS_COMPILER_GRAPH_SCHEMA_VERSION,
        .revision = HEAD_REVISION,
        .comparison = &COMPARISON,
        .nodes = nodes,
        .node_count = sizeof nodes / sizeof nodes[0],
        .node_coverage = CHRONOS_COMPLETE,
        .edges = edges,
        .edge_count = sizeof edges / sizeof edges[0],
        .edge_coverage = CHRONOS_COMPLETE,
        .evidence = evidence,
        .evidence_count = sizeof evidence / sizeof evidence[0],
        .evidence_coverage = CHRONOS_COMPLETE
    };

    char *request_json = serialize_request(&request);
    assert_contains(request_json, "\"schemaVersion\":1");
    assert_contains(request_json, "\"mode\":\"review\"");
    assert_contains(request_json, "\"base\":{\"repositoryId\":\"example/payments\"");
    assert_contains(request_json, "\"kind\":\"symbol\"");
    assert_contains(request_json, "\"budget\":{\"maxItems\":8,\"maxSourceBytes\":4096}");

    char *graph_json = serialize_graph(&graph);
    assert_contains(graph_json, "\"adapter\":{\"name\":\"minikv-ui\",\"schemaVersion\":1");
    assert_contains(graph_json, "\"graphSchemaVersion\":1");
    assert_contains(graph_json, "\"reviewContextSchemaVersion\":1");
    assert_contains(graph_json, "\"state\":\"selected\"");
    assert_contains(graph_json, "\"state\":\"omitted\"");
    assert_contains(graph_json, "\"state\":\"unresolved\"");
    assert_contains(graph_json, "\"state\":\"unavailable\"");
    assert_contains(graph_json, "\"evidenceId\":\"call:v1:");
    assert(strstr(graph_json, "\"source\":") == NULL);
    assert(strstr(graph_json, "\"sourceBytes\":") == NULL);

    ContextGraph invalid_graph = graph;
    ContextGraphEdge broken_edge = edges[0];
    broken_edge.evidence_id = NULL;
    invalid_graph.edges = &broken_edge;
    invalid_graph.edge_count = 1;
    assert(context_graph_write_json(&invalid_graph, NULL, 0) == CHRONOS_INVALID_ARGUMENT);
    broken_edge = edges[7];
    broken_edge.call = NULL;
    invalid_graph.edges = &broken_edge;
    assert(context_graph_write_json(&invalid_graph, NULL, 0) == CHRONOS_INVALID_ARGUMENT);
    ContextGraphNode broken_node = nodes[0];
    broken_node.id = NULL;
    invalid_graph = graph;
    invalid_graph.nodes = &broken_node;
    invalid_graph.node_count = 1;
    assert(context_graph_write_json(&invalid_graph, NULL, 0) == CHRONOS_INVALID_ARGUMENT);

    const char *entry_evidence[] = {pay_source_evidence};
    const char *flow_evidence[] = {selected_evidence, validate_source_evidence};
    const char *unresolved_item_evidence[] = {unresolved_evidence};
    const char *unavailable_item_evidence[] = {unavailable_contains};
    const ContextBriefItem entry_items[] = {
        {"Start at pay in payments/payment.c.", entry_evidence, 1,
         CONTEXT_RELATION_SELECTED}
    };
    const ContextBriefItem flow_items[] = {
        {"pay calls validate across module boundaries.", flow_evidence, 2,
         CONTEXT_RELATION_SELECTED}
    };
    const ContextBriefItem edit_items[] = {
        {"Edit pay in payments/payment.c.", entry_evidence, 1, CONTEXT_RELATION_SELECTED}
    };
    const ContextBriefItem test_items[] = {
        {"No directly affected tests were indexed.", NULL, 0, CONTEXT_RELATION_SELECTED}
    };
    const ContextBriefItem unresolved_items[] = {
        {"missing has no unique indexed target.", unresolved_item_evidence, 1,
         CONTEXT_RELATION_UNRESOLVED}
    };
    const ContextBriefItem unavailable_items[] = {
        {"Discovery is unavailable for shared/checks/generated.c.",
         unavailable_item_evidence, 1, CONTEXT_RELATION_UNAVAILABLE}
    };
    const ContextBriefSection sections[] = {
        {"entry-points", "Entry points", entry_items, 1},
        {"flows", "Top flows", flow_items, 1},
        {"edit-locations", "Likely edit locations", edit_items, 1},
        {"test-locations", "Likely test locations", test_items, 1},
        {"unresolved", "Unresolved relationships", unresolved_items, 1},
        {"unavailable", "Unavailable evidence", unavailable_items, 1}
    };
    const char *omitted_ids[] = {omitted_evidence};
    const ContextBrief brief = {
        .schema_version = CHRONOS_COMPILER_BRIEF_SCHEMA_VERSION,
        .revision = HEAD_REVISION,
        .comparison = &COMPARISON,
        .sections = sections,
        .section_count = sizeof sections / sizeof sections[0],
        .used_source_bytes = 65,
        .omitted_ids = omitted_ids,
        .omitted_count = 1,
        .coverage = CHRONOS_COMPLETE,
        .evidence = evidence,
        .evidence_count = sizeof evidence / sizeof evidence[0],
        .evidence_coverage = CHRONOS_COMPLETE
    };

    validate_contract_objects(&graph, &brief, &request);

    char *brief_json = serialize_brief(&brief);
    assert_contains(brief_json, "\"id\":\"entry-points\"");
    assert_contains(brief_json, "\"state\":\"omitted\"");
    assert_contains(brief_json, "\"state\":\"unresolved\"");
    assert_contains(brief_json, "\"state\":\"unavailable\"");
    assert_contains(brief_json, "\"omittedEvidenceIds\":[\"call:v1:");
    assert_contains(brief_json, "\"usedSourceBytes\":65");
    assert_contains(brief_json, "\"evidence\":{\"status\":\"complete\",\"items\":[");

    ContextBrief invalid_brief = brief;
    const char *unknown_ids[] = {"missing-evidence"};
    const ContextBriefItem broken_item = {
        "Invalid evidence reference.", unknown_ids, 1, CONTEXT_RELATION_SELECTED
    };
    const ContextBriefSection broken_section = {
        "broken", "Broken", &broken_item, 1
    };
    invalid_brief.sections = &broken_section;
    invalid_brief.section_count = 1;
    assert(context_brief_write_json(&invalid_brief, NULL, 0) == CHRONOS_INVALID_ARGUMENT);

    puts("context compiler contract tests passed");
    free(request_json);
    free(graph_json);
    free(brief_json);
    return 0;
}
