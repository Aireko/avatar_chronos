#include "context_views.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define T_ENTRY_ONBOARDING "Entry point: %s in %s."
#define T_ENTRY_TASK "Task anchor: %s in %s."
#define T_TARGET "Target: %s in %s."
#define T_FLOW "Flow: %s -> %s (%zu hops, relevance %.2f)."
#define T_EDIT "Likely edit location: %s in %s."
#define T_TEST "Likely test location: %s in %s."
#define T_NO_TEST "No directly affected tests were indexed."
#define T_NO_ENTRY "No entry points were recognized."
#define T_UNRESOLVED "Unresolved call: %s from %s."
#define T_AMBIGUOUS "Ambiguous call: %s from %s."

typedef struct {
    ContextEvidence *items;
    size_t count;
    size_t capacity;
} EvidenceCatalog;

typedef struct {
    const char **items;
    size_t count;
    size_t capacity;
} IdList;

typedef struct {
    const char *id;
    const char *title;
    ContextBriefItem *items;
    size_t count;
    size_t capacity;
} SectionBuilder;

enum {
    SECTION_TARGET,
    SECTION_ENTRY,
    SECTION_FLOW,
    SECTION_EDIT,
    SECTION_TEST,
    SECTION_UNRESOLVED,
    SECTION_COUNT
};

typedef struct {
    const RepositoryIndex *index;
    EvidenceCatalog *catalog;
    size_t max_items;
    size_t max_source_bytes;
    size_t used_items;
    size_t used_source_bytes;
    IdList selected;
    IdList omitted;
    SectionBuilder sections[SECTION_COUNT];
} BriefBuilder;

static char *render_template(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    va_list copy;
    va_copy(copy, args);
    int length = vsnprintf(NULL, 0, format, copy);
    va_end(copy);
    if (length < 0) {
        va_end(args);
        return NULL;
    }
    char *text = malloc((size_t)length + 1);
    if (text != NULL) (void)vsnprintf(text, (size_t)length + 1, format, args);
    va_end(args);
    return text;
}

static int same_text(const char *left, const char *right)
{
    return left != NULL && right != NULL && strcmp(left, right) == 0;
}

static int id_list_has(const IdList *list, const char *id)
{
    for (size_t i = 0; i < list->count; ++i)
        if (same_text(list->items[i], id)) return 1;
    return 0;
}

static int id_list_add(IdList *list, const char *id)
{
    if (id == NULL || id_list_has(list, id)) return 1;
    if (list->count == list->capacity) {
        size_t capacity = list->capacity ? list->capacity * 2 : 8;
        const char **items = realloc(list->items, capacity * sizeof *items);
        if (items == NULL) return 0;
        list->items = items;
        list->capacity = capacity;
    }
    list->items[list->count++] = id;
    return 1;
}

static void id_list_free(IdList *list)
{
    free(list->items);
    *list = (IdList){0};
}

static ContextRelationState merge_state(ContextRelationState old_state,
                                        ContextRelationState new_state)
{
    if (old_state == CONTEXT_RELATION_SELECTED ||
        new_state == CONTEXT_RELATION_SELECTED) return CONTEXT_RELATION_SELECTED;
    if (old_state == CONTEXT_RELATION_UNRESOLVED ||
        old_state == CONTEXT_RELATION_AMBIGUOUS) return old_state;
    if (new_state == CONTEXT_RELATION_UNRESOLVED ||
        new_state == CONTEXT_RELATION_AMBIGUOUS) return new_state;
    if (old_state == CONTEXT_RELATION_UNAVAILABLE ||
        new_state == CONTEXT_RELATION_UNAVAILABLE) return CONTEXT_RELATION_UNAVAILABLE;
    return old_state;
}

static const char *catalog_add_owned(EvidenceCatalog *catalog, char *id,
                                     ContextEvidenceKind kind, ContextRelationState state,
                                     const SourceLocation *location, const GraphCall *call)
{
    if (id == NULL) return NULL;
    for (size_t i = 0; i < catalog->count; ++i) {
        if (same_text(catalog->items[i].id, id)) {
            catalog->items[i].state = merge_state(catalog->items[i].state, state);
            free(id);
            return catalog->items[i].id;
        }
    }
    if (catalog->count == catalog->capacity) {
        size_t capacity = catalog->capacity ? catalog->capacity * 2 : 16;
        ContextEvidence *items = realloc(catalog->items, capacity * sizeof *items);
        if (items == NULL) {
            free(id);
            return NULL;
        }
        catalog->items = items;
        catalog->capacity = capacity;
    }
    catalog->items[catalog->count] = (ContextEvidence){id, kind, state, location, call};
    return catalog->items[catalog->count++].id;
}

static const char *catalog_add_source(EvidenceCatalog *catalog, const GraphSymbol *symbol,
                                      ContextRelationState state)
{
    char *id = context_symbol_evidence_id_alloc(&symbol->ref);
    return catalog_add_owned(catalog, id, CONTEXT_EVIDENCE_SOURCE, state,
                             &symbol->location, NULL);
}

static const char *catalog_add_call(EvidenceCatalog *catalog, const GraphCall *call,
                                    ContextRelationState state)
{
    char *id = context_call_evidence_id_alloc(call);
    return catalog_add_owned(catalog, id, CONTEXT_EVIDENCE_CALL, state,
                             &call->call_site, call);
}

static void catalog_free(EvidenceCatalog *catalog)
{
    for (size_t i = 0; i < catalog->count; ++i) free((void *)catalog->items[i].id);
    free(catalog->items);
    *catalog = (EvidenceCatalog){0};
}

static void reconcile_omitted(EvidenceCatalog *catalog, const IdList *selected,
                              const IdList *omitted)
{
    for (size_t i = 0; i < catalog->count; ++i) {
        ContextEvidence *item = &catalog->items[i];
        if (item->state == CONTEXT_RELATION_SELECTED &&
            id_list_has(omitted, item->id) && !id_list_has(selected, item->id))
            item->state = CONTEXT_RELATION_OMITTED;
    }
}

static size_t symbol_source_cost(const RepositoryIndex *index, const GraphSymbol *symbol)
{
    ContextSource source = {0};
    if (index_symbol_source(index, &symbol->ref, &source) < 0) return 0;
    return source.status == CONTEXT_SOURCE_PRESENT ? source.byte_count : 0;
}

static int section_add(SectionBuilder *section, char *text, const char **ids,
                       size_t id_count, ContextRelationState state)
{
    if (section->count == section->capacity) {
        size_t capacity = section->capacity ? section->capacity * 2 : 4;
        ContextBriefItem *items = realloc(section->items, capacity * sizeof *items);
        if (items == NULL) {
            free(text);
            free(ids);
            return CHRONOS_OUT_OF_MEMORY;
        }
        section->items = items;
        section->capacity = capacity;
    }
    section->items[section->count++] = (ContextBriefItem){text, ids, id_count, state};
    return CHRONOS_OK;
}

static int add_candidate(BriefBuilder *builder, SectionBuilder *section, char *text,
                         const char **ids, size_t id_count, size_t source_cost,
                         ContextRelationState state, int report_omitted)
{
    if (text == NULL || (id_count != 0 && ids == NULL)) {
        free(text);
        free(ids);
        return CHRONOS_OUT_OF_MEMORY;
    }
    int fits = builder->used_items < builder->max_items &&
               source_cost <= builder->max_source_bytes - builder->used_source_bytes;
    if (!fits) {
        if (report_omitted) {
            for (size_t i = 0; i < id_count; ++i)
                if (!id_list_add(&builder->omitted, ids[i])) {
                    free(text);
                    free(ids);
                    return CHRONOS_OUT_OF_MEMORY;
                }
        }
        free(text);
        free(ids);
        return CHRONOS_OK;
    }
    for (size_t i = 0; i < id_count; ++i)
        if (!id_list_add(&builder->selected, ids[i])) {
            free(text);
            free(ids);
            return CHRONOS_OUT_OF_MEMORY;
        }
    int status = section_add(section, text, ids, id_count, state);
    if (status < 0) return status;
    ++builder->used_items;
    builder->used_source_bytes += source_cost;
    return CHRONOS_OK;
}

static int add_source_item(BriefBuilder *builder, SectionBuilder *section,
                           const GraphSymbol *symbol, const char *template_text,
                           int count_source)
{
    char *text = render_template(template_text, symbol->name, symbol->location.file_path);
    const char *id = catalog_add_source(builder->catalog, symbol,
                                        CONTEXT_RELATION_SELECTED);
    const char **ids = malloc(sizeof *ids);
    if (text == NULL || id == NULL || ids == NULL) {
        free(text);
        free(ids);
        return CHRONOS_OUT_OF_MEMORY;
    }
    ids[0] = id;
    return add_candidate(builder, section, text, ids, 1,
                         count_source ? symbol_source_cost(builder->index, symbol) : 0,
                         CONTEXT_RELATION_SELECTED, 1);
}

static int add_flow_item(BriefBuilder *builder, SectionBuilder *section,
                         const ContextFlow *flow)
{
    if (flow == NULL || flow->edge_count == 0 || flow->node_count == 0) return CHRONOS_OK;
    const GraphSymbol *target = flow->nodes[flow->node_count - 1].symbol;
    char *text = render_template(T_FLOW, flow->seed->name, target->name,
                                 flow->edge_count, flow->relevance);
    const char **ids = calloc(flow->edge_count, sizeof *ids);
    if (text == NULL || ids == NULL) {
        free(text);
        free(ids);
        return CHRONOS_OUT_OF_MEMORY;
    }
    for (size_t i = 0; i < flow->edge_count; ++i) {
        const char *id = catalog_add_call(builder->catalog, flow->edges[i].call,
                                          CONTEXT_RELATION_SELECTED);
        if (id == NULL) {
            free(text);
            free(ids);
            return CHRONOS_OUT_OF_MEMORY;
        }
        ids[i] = id;
    }
    return add_candidate(builder, section, text, ids, flow->edge_count, 0,
                         CONTEXT_RELATION_SELECTED, 1);
}

static int add_unresolved_item(BriefBuilder *builder, SectionBuilder *section,
                               const GraphCall *call, const GraphSymbol *caller,
                               ContextRelationState state)
{
    const char *template_text = state == CONTEXT_RELATION_AMBIGUOUS
        ? T_AMBIGUOUS : T_UNRESOLVED;
    char *text = render_template(template_text, call->callee_text, caller->name);
    const char *id = catalog_add_call(builder->catalog, call, state);
    const char **ids = malloc(sizeof *ids);
    if (text == NULL || id == NULL || ids == NULL) {
        free(text);
        free(ids);
        return CHRONOS_OUT_OF_MEMORY;
    }
    ids[0] = id;
    return add_candidate(builder, section, text, ids, 1, 0, state, 0);
}

static int is_test_like(const GraphSymbol *symbol)
{
    const char *path = symbol->location.file_path;
    const char *name = symbol->name;
    if (symbol->language != NULL && strcmp(symbol->language, "python") == 0) {
        if (!path || !name || symbol->kind == PARSER_CLASS ||
            symbol->form != PARSER_DEFINITION || strncmp(name, "test_", 5) != 0) return 0;
        const char *base = strrchr(path, '/');
        base = base ? base + 1 : path;
        size_t length = strlen(base);
        return length > 3 && strcmp(base + length - 3, ".py") == 0 &&
               (strncmp(base, "test_", 5) == 0 ||
                (length >= 8 && strcmp(base + length - 8, "_test.py") == 0));
    }
    if (symbol->language != NULL && strcmp(symbol->language, "java") == 0) {
        if (!path || !name || symbol->kind == PARSER_CLASS ||
            symbol->form != PARSER_DEFINITION || strncmp(name, "test", 4) != 0) return 0;
        const char *base = strrchr(path, '/');
        base = base ? base + 1 : path;
        size_t length = strlen(base);
        return (length > 9 && strcmp(base + length - 9, "Test.java") == 0) ||
               (length > 10 && strcmp(base + length - 10, "Tests.java") == 0) ||
               strstr(path, "/src/test/") != NULL;
    }
    return (path != NULL && (strstr(path, "test") != NULL || strstr(path, "spec") != NULL)) ||
           (name != NULL && (strncmp(name, "test_", 5) == 0 ||
                             strncmp(name, "test", 4) == 0 ||
                             (strlen(name) >= 5 && strcmp(name + strlen(name) - 5, "_test") == 0)));
}

static int build_target_section(BriefBuilder *builder, const ContextFlowSet *flows,
                                ContextFlowMode mode)
{
    if (mode != CONTEXT_FLOW_TASK || flows->seed_count <= 1) return CHRONOS_OK;
    SectionBuilder *section = &builder->sections[SECTION_TARGET];
    size_t limit = flows->seed_count < 32 ? flows->seed_count : 32;
    for (size_t i = 0; i < limit; ++i) {
        int status = add_source_item(builder, section, flows->seeds[i], T_TARGET, 0);
        if (status < 0) return status;
    }
    return CHRONOS_OK;
}

static int build_entry_section(BriefBuilder *builder, const ContextFlowSet *flows,
                               ContextFlowMode mode)
{
    SectionBuilder *section = &builder->sections[SECTION_ENTRY];
    if (flows->seed_count == 0) {
        char *text = render_template(T_NO_ENTRY);
        return add_candidate(builder, section, text, NULL, 0, 0,
                             CONTEXT_RELATION_SELECTED, 1);
    }
    size_t limit = flows->seed_count < 4 ? flows->seed_count : 4;
    for (size_t i = 0; i < limit; ++i) {
        int status = add_source_item(builder, section, flows->seeds[i],
                                     mode == CONTEXT_FLOW_TASK ? T_ENTRY_TASK
                                                               : T_ENTRY_ONBOARDING, 1);
        if (status < 0) return status;
    }
    return CHRONOS_OK;
}

static int build_flow_section(BriefBuilder *builder, const ContextFlowSet *flows)
{
    size_t limit = flows->count < 4 ? flows->count : 4;
    for (size_t i = 0; i < limit; ++i) {
        int status = add_flow_item(builder, &builder->sections[SECTION_FLOW], &flows->flows[i]);
        if (status < 0) return status;
    }
    return CHRONOS_OK;
}

static int build_edit_section(BriefBuilder *builder, const ContextFlowSet *flows,
                              ContextFlowMode mode)
{
    SectionBuilder *section = &builder->sections[SECTION_EDIT];
    IdList seen = {0};
    int status = CHRONOS_OK;
    for (size_t i = 0; i < flows->seed_count && i < 4; ++i) {
        const GraphSymbol *symbol = flows->seeds[i];
        if (!id_list_add(&seen, symbol->ref.id)) {
            status = CHRONOS_OUT_OF_MEMORY;
            goto done;
        }
        status = add_source_item(builder, section, symbol, T_EDIT, 1);
        if (status < 0) goto done;
    }
    if (flows->count != 0) {
        const ContextFlow *flow = &flows->flows[0];
        const GraphSymbol *target = flow->nodes[flow->node_count - 1].symbol;
        if (!id_list_has(&seen, target->ref.id)) {
            if (!id_list_add(&seen, target->ref.id)) {
                status = CHRONOS_OUT_OF_MEMORY;
                goto done;
            }
            status = add_source_item(builder, section, target, T_EDIT, 1);
            if (status < 0) goto done;
        }
    }
    if (mode == CONTEXT_FLOW_TASK) {
        size_t added = 0;
        for (size_t i = 0; i < flows->count && added < 2; ++i) {
            const ContextFlow *flow = &flows->flows[i];
            for (size_t j = 0; j < flow->node_count; ++j) {
                const ContextFlowNode *node = &flow->nodes[j];
                if (!node->via_incoming || node->hop != 1 ||
                    id_list_has(&seen, node->symbol->ref.id)) continue;
                if (!id_list_add(&seen, node->symbol->ref.id)) {
                    status = CHRONOS_OUT_OF_MEMORY;
                    goto done;
                }
                status = add_source_item(builder, section, node->symbol, T_EDIT, 1);
                if (status < 0) goto done;
                ++added;
                break;
            }
        }
    }
done:
    id_list_free(&seen);
    return status;
}

static int build_test_section(BriefBuilder *builder, const ContextFlowSet *flows)
{
    SectionBuilder *section = &builder->sections[SECTION_TEST];
    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(builder->index, &scope_count);
    int *relevant = calloc(scope_count, sizeof *relevant);
    if (relevant == NULL) return CHRONOS_OUT_OF_MEMORY;
    for (size_t i = 0; i < flows->seed_count; ++i) {
        size_t scope = index_find_symbol(builder->index, &flows->seeds[i]->ref);
        if (scope != INDEX_NO_SCOPE) relevant[scope] = 1;
    }
    for (size_t i = 0; i < flows->count; ++i)
        for (size_t j = 0; j < flows->flows[i].node_count; ++j)
            relevant[flows->flows[i].nodes[j].scope] = 1;

    size_t link_count = 0;
    const IndexCallLink *links = index_call_links(builder->index, &link_count);
    IdList seen = {0};
    int status = CHRONOS_OK;
    for (size_t i = 0; i < link_count; ++i) {
        size_t caller_scope = links[i].caller;
        if (caller_scope == INDEX_NO_SCOPE || scopes[caller_scope].symbol == NULL) continue;
        const GraphSymbol *caller = scopes[caller_scope].symbol;
        if (!is_test_like(caller)) continue;
        if (!(relevant[caller_scope] ||
              (links[i].callee != INDEX_NO_SCOPE && relevant[links[i].callee]))) continue;
        if (id_list_has(&seen, caller->ref.id)) continue;
        if (!id_list_add(&seen, caller->ref.id)) {
            status = CHRONOS_OUT_OF_MEMORY;
            goto done;
        }
        status = add_source_item(builder, section, caller, T_TEST, 1);
        if (status < 0) goto done;
    }
    if (section->count == 0) {
        char *text = render_template(T_NO_TEST);
        status = add_candidate(builder, section, text, NULL, 0, 0,
                               CONTEXT_RELATION_SELECTED, 1);
    }
done:
    id_list_free(&seen);
    free(relevant);
    return status;
}

static int build_unresolved_section(BriefBuilder *builder, const ContextFlowSet *flows)
{
    SectionBuilder *section = &builder->sections[SECTION_UNRESOLVED];
    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(builder->index, &scope_count);
    int *relevant = calloc(scope_count, sizeof *relevant);
    if (relevant == NULL) return CHRONOS_OUT_OF_MEMORY;
    for (size_t i = 0; i < flows->seed_count; ++i) {
        size_t scope = index_find_symbol(builder->index, &flows->seeds[i]->ref);
        if (scope != INDEX_NO_SCOPE) relevant[scope] = 1;
    }
    for (size_t i = 0; i < flows->count; ++i)
        for (size_t j = 0; j < flows->flows[i].node_count; ++j)
            relevant[flows->flows[i].nodes[j].scope] = 1;

    size_t link_count = 0;
    const IndexCallLink *links = index_call_links(builder->index, &link_count);
    int status = CHRONOS_OK;
    for (size_t i = 0; i < link_count; ++i) {
        if (links[i].caller == INDEX_NO_SCOPE || !relevant[links[i].caller]) continue;
        const GraphCall *call = links[i].call;
        ContextRelationState state;
        if (call->resolution == CALL_UNRESOLVED) state = CONTEXT_RELATION_UNRESOLVED;
        else if (call->resolution == CALL_AMBIGUOUS) state = CONTEXT_RELATION_AMBIGUOUS;
        else continue;
        const GraphSymbol *caller = scopes[links[i].caller].symbol;
        status = add_unresolved_item(builder, section, call, caller, state);
        if (status < 0) break;
    }
    free(relevant);
    return status;
}

static void free_brief_arrays(ContextBrief *brief)
{
    for (size_t i = 0; i < brief->section_count; ++i) {
        const ContextBriefSection *section = &brief->sections[i];
        for (size_t j = 0; j < section->item_count; ++j) {
            free((void *)section->items[j].text);
            free((void *)section->items[j].evidence_ids);
        }
        free((void *)section->items);
    }
    free((void *)brief->sections);
    free((void *)brief->omitted_ids);
    *brief = (ContextBrief){0};
}

static void free_builder(BriefBuilder *builder)
{
    for (size_t i = 0; i < SECTION_COUNT; ++i) {
        SectionBuilder *section = &builder->sections[i];
        for (size_t j = 0; j < section->count; ++j) {
            free((void *)section->items[j].text);
            free((void *)section->items[j].evidence_ids);
        }
        free(section->items);
    }
    id_list_free(&builder->selected);
    id_list_free(&builder->omitted);
}

static int build_brief(BriefBuilder *builder, const ContextFlowSet *flows,
                       ContextFlowMode mode, ChronosCoverage coverage,
                       ContextBrief *out)
{
    static const char *const ids[SECTION_COUNT] = {
        "targets", "entry-points", "top-flows", "edit-locations",
        "test-locations", "unresolved"
    };
    static const char *const titles[SECTION_COUNT] = {
        "Targets", "Entry points", "Top flows", "Likely edit locations",
        "Likely test locations", "Unresolved relationships"
    };
    for (size_t i = 0; i < SECTION_COUNT; ++i) {
        builder->sections[i].id = ids[i];
        builder->sections[i].title = titles[i];
    }
    if (mode == CONTEXT_FLOW_TASK) builder->sections[SECTION_ENTRY].title = "Task anchors";

    int status = build_target_section(builder, flows, mode);
    if (status < 0) return status;
    status = build_entry_section(builder, flows, mode);
    if (status < 0) return status;
    status = build_flow_section(builder, flows);
    if (status < 0) return status;
    status = build_edit_section(builder, flows, mode);
    if (status < 0) return status;
    status = build_test_section(builder, flows);
    if (status < 0) return status;
    status = build_unresolved_section(builder, flows);
    if (status < 0) return status;

    reconcile_omitted(builder->catalog, &builder->selected, &builder->omitted);

    size_t section_count = 0;
    for (size_t i = 0; i < SECTION_COUNT; ++i)
        if (builder->sections[i].count != 0) ++section_count;
    ContextBriefSection *sections = section_count
        ? calloc(section_count, sizeof *sections) : NULL;
    if (section_count && sections == NULL) return CHRONOS_OUT_OF_MEMORY;
    size_t next = 0;
    for (size_t i = 0; i < SECTION_COUNT; ++i) {
        SectionBuilder *section = &builder->sections[i];
        if (section->count == 0) continue;
        sections[next++] = (ContextBriefSection){
            section->id, section->title, section->items, section->count
        };
        section->items = NULL;
        section->count = 0;
        section->capacity = 0;
    }

    const char **omitted = NULL;
    size_t omitted_count = 0;
    for (size_t i = 0; i < builder->omitted.count; ++i)
        if (!id_list_has(&builder->selected, builder->omitted.items[i])) ++omitted_count;
    if (omitted_count != 0) {
        omitted = calloc(omitted_count, sizeof *omitted);
        if (omitted == NULL) {
            for (size_t i = 0; i < section_count; ++i) {
                for (size_t j = 0; j < sections[i].item_count; ++j) {
                    free((void *)sections[i].items[j].text);
                    free((void *)sections[i].items[j].evidence_ids);
                }
                free((void *)sections[i].items);
            }
            free(sections);
            return CHRONOS_OUT_OF_MEMORY;
        }
        size_t next_omitted = 0;
        for (size_t i = 0; i < builder->omitted.count; ++i) {
            const char *id = builder->omitted.items[i];
            if (!id_list_has(&builder->selected, id))
                omitted[next_omitted++] = id;
        }
    }
    *out = (ContextBrief){
        .schema_version = CHRONOS_COMPILER_BRIEF_SCHEMA_VERSION,
        .revision = *index_revision(builder->index),
        .comparison = NULL,
        .sections = sections,
        .section_count = section_count,
        .used_source_bytes = builder->used_source_bytes,
        .omitted_ids = omitted,
        .omitted_count = omitted_count,
        .coverage = coverage,
        .evidence = NULL,
        .evidence_count = 0,
        .evidence_coverage = coverage
    };
    return CHRONOS_OK;
}

static int build_brief_catalog(const ContextBrief* brief, const ContextEvidence* catalog,
                               size_t catalog_count, ContextEvidence** out, size_t* out_count)
{
    IdList needed = {0};
    for (size_t i = 0; i < brief->section_count; ++i) {
        const ContextBriefSection* section = &brief->sections[i];
        for (size_t j = 0; j < section->item_count; ++j) {
            const ContextBriefItem* item = &section->items[j];
            for (size_t k = 0; k < item->evidence_count; ++k) {
                if (!id_list_add(&needed, item->evidence_ids[k])) {
                    id_list_free(&needed);
                    return CHRONOS_OUT_OF_MEMORY;
                }
            }
        }
    }
    for (size_t i = 0; i < brief->omitted_count; ++i) {
        if (!id_list_add(&needed, brief->omitted_ids[i])) {
            id_list_free(&needed);
            return CHRONOS_OUT_OF_MEMORY;
        }
    }
    ContextEvidence* subset = needed.count
        ? calloc(needed.count, sizeof *subset) : NULL;
    if (needed.count && !subset) {
        id_list_free(&needed);
        return CHRONOS_OUT_OF_MEMORY;
    }
    size_t next = 0;
    for (size_t i = 0; i < catalog_count; ++i) {
        if (id_list_has(&needed, catalog[i].id)) subset[next++] = catalog[i];
    }
    *out = subset;
    *out_count = next;
    id_list_free(&needed);
    return CHRONOS_OK;
}

static ChronosCoverage combined_coverage(ChronosCoverage flows, ChronosCoverage bridges)
{
    if (flows == CHRONOS_UNAVAILABLE) return CHRONOS_INCOMPLETE;
    if (flows == CHRONOS_INCOMPLETE || bridges == CHRONOS_INCOMPLETE)
        return CHRONOS_INCOMPLETE;
    return CHRONOS_COMPLETE;
}

static char *scope_id_for(const IndexScope *scope)
{
    switch (scope->kind) {
    case INDEX_PROJECT:
        return context_scope_id_alloc(CONTEXT_SCOPE_PROJECT, NULL, NULL);
    case INDEX_MODULE:
        return context_scope_id_alloc(CONTEXT_SCOPE_MODULE, scope->path, NULL);
    case INDEX_FILE:
        return context_scope_id_alloc(CONTEXT_SCOPE_FILE, scope->path, NULL);
    case INDEX_SYMBOL:
        return context_symbol_scope_id_alloc(scope->symbol);
    default:
        return NULL;
    }
}

static const char *scope_label(const RepositoryIndex *index, const IndexScope *scope)
{
    if (scope->kind == INDEX_PROJECT) return index_revision(index)->repository_id;
    if (scope->kind == INDEX_SYMBOL && scope->symbol != NULL) return scope->symbol->name;
    return scope->path;
}

static void free_scope_ids(char **ids, size_t count)
{
    for (size_t i = 0; i < count; ++i) free(ids[i]);
    free(ids);
}

static void free_graph_arrays(ContextGraph *graph)
{
    free((void *)graph->nodes);
    free((void *)graph->edges);
    *graph = (ContextGraph){0};
}

static int build_graph(const RepositoryIndex *index, const ContextFlowSet *flows,
                       const ContextBridgeSet *bridges, const IdList *selected,
                       EvidenceCatalog *catalog, char ***scope_ids_out,
                       size_t *scope_count_out, ContextGraph *out)
{
    (void)flows;
    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(index, &scope_count);
    char **scope_ids = calloc(scope_count, sizeof *scope_ids);
    ContextGraphNode *nodes = calloc(scope_count, sizeof *nodes);
    if ((scope_count && (scope_ids == NULL || nodes == NULL))) {
        free(scope_ids);
        free(nodes);
        return CHRONOS_OUT_OF_MEMORY;
    }
    for (size_t i = 0; i < scope_count; ++i) {
        scope_ids[i] = scope_id_for(&scopes[i]);
        if (scope_ids[i] == NULL) {
            free_scope_ids(scope_ids, scope_count);
            free(nodes);
            return CHRONOS_OUT_OF_MEMORY;
        }
    }
    for (size_t i = 0; i < scope_count; ++i) {
        const IndexScope *scope = &scopes[i];
        const char *parent = scope->parent == INDEX_NO_SCOPE
            ? NULL : scope_ids[scope->parent];
        ContextScopeKind kind = scope->kind == INDEX_PROJECT ? CONTEXT_SCOPE_PROJECT
            : scope->kind == INDEX_MODULE ? CONTEXT_SCOPE_MODULE
            : scope->kind == INDEX_FILE ? CONTEXT_SCOPE_FILE : CONTEXT_SCOPE_SYMBOL;
        nodes[i] = (ContextGraphNode){
            scope_ids[i], kind, parent, scope_label(index, scope),
            scope->symbol ? &scope->symbol->ref : NULL,
            scope->coverage, CONTEXT_RELATION_SELECTED
        };
    }

    size_t link_count = 0;
    const IndexCallLink *links = index_call_links(index, &link_count);
    size_t contains_count = scope_count == 0 ? 0 : scope_count - 1;
    size_t edge_capacity = contains_count + link_count;
    ContextGraphEdge *edges = edge_capacity ? calloc(edge_capacity, sizeof *edges) : NULL;
    if (edge_capacity && edges == NULL) {
        free_scope_ids(scope_ids, scope_count);
        free(nodes);
        return CHRONOS_OUT_OF_MEMORY;
    }
    size_t edge_count = 0;
    for (size_t i = 1; i < scope_count; ++i) {
        const IndexScope *scope = &scopes[i];
        if (scope->parent == INDEX_NO_SCOPE) continue;
        const SourceLocation *location = scope->symbol ? &scope->symbol->location : NULL;
        const char *id = NULL;
        char *new_id = context_contains_evidence_id_alloc(scope_ids[scope->parent],
                                                          scope_ids[i]);
        id = catalog_add_owned(catalog, new_id, CONTEXT_EVIDENCE_CONTAINS,
                               CONTEXT_RELATION_SELECTED, location, NULL);
        if (id == NULL) goto oom;
        edges[edge_count++] = (ContextGraphEdge){
            id, scope_ids[scope->parent], scope_ids[i], CONTEXT_EVIDENCE_CONTAINS,
            CONTEXT_RELATION_SELECTED, id, NULL
        };
    }
    for (size_t i = 0; i < link_count; ++i) {
        const IndexCallLink *link = &links[i];
        if (link->caller == INDEX_NO_SCOPE) continue;
        const GraphCall *call = link->call;
        char *new_id = context_call_evidence_id_alloc(call);
        if (new_id == NULL) goto oom;
        ContextRelationState state;
        if (call->resolution == CALL_UNRESOLVED) state = CONTEXT_RELATION_UNRESOLVED;
        else if (call->resolution == CALL_AMBIGUOUS) state = CONTEXT_RELATION_AMBIGUOUS;
        else state = id_list_has(selected, new_id)
            ? CONTEXT_RELATION_SELECTED : CONTEXT_RELATION_OMITTED;
        const char *id = catalog_add_owned(catalog, new_id, CONTEXT_EVIDENCE_CALL, state,
                                           &call->call_site, call);
        if (id == NULL) goto oom;
        const char *to = link->callee == INDEX_NO_SCOPE ? NULL : scope_ids[link->callee];
        edges[edge_count++] = (ContextGraphEdge){
            id, scope_ids[link->caller], to, CONTEXT_EVIDENCE_CALL, state, id, call
        };
    }

    ChronosCoverage call_coverage = index_call_coverage(index);
    ChronosCoverage evidence_coverage = combined_coverage(call_coverage, bridges->coverage);
    ChronosCoverage node_coverage = scope_count == 0 ? CHRONOS_COMPLETE : scopes[0].coverage;
    if (node_coverage == CHRONOS_UNAVAILABLE && scope_count != 0) node_coverage = CHRONOS_INCOMPLETE;
    ChronosCoverage edge_coverage = call_coverage == CHRONOS_COMPLETE
        ? CHRONOS_COMPLETE : CHRONOS_INCOMPLETE;
    size_t diagnostic_count = 0;
    const ChronosDiagnostic *diagnostics = index_diagnostics(index, &diagnostic_count);
    *out = (ContextGraph){
        .schema_version = CHRONOS_COMPILER_GRAPH_SCHEMA_VERSION,
        .revision = *index_revision(index),
        .comparison = NULL,
        .nodes = nodes,
        .node_count = scope_count,
        .node_coverage = node_coverage,
        .edges = edges,
        .edge_count = edge_count,
        .edge_coverage = edge_coverage,
        .evidence = catalog->items,
        .evidence_count = catalog->count,
        .evidence_coverage = evidence_coverage,
        .diagnostics = diagnostics,
        .diagnostic_count = diagnostic_count
    };
    *scope_ids_out = scope_ids;
    *scope_count_out = scope_count;
    return CHRONOS_OK;

oom:
    free((void *)edges);
    free_scope_ids(scope_ids, scope_count);
    free(nodes);
    return CHRONOS_OUT_OF_MEMORY;
}

void context_views_free(ContextViews *views)
{
    if (views == NULL) return;
    ContextEvidence *catalog_items = (ContextEvidence *)views->graph.evidence;
    size_t catalog_count = views->graph.evidence_count;
    const ContextEvidence *brief_items = views->brief.evidence;
    free_graph_arrays(&views->graph);
    free_brief_arrays(&views->brief);
    if (brief_items != (const ContextEvidence *)catalog_items) free((void *)brief_items);
    EvidenceCatalog catalog = {catalog_items, catalog_count, 0};
    catalog_free(&catalog);
    free_scope_ids(views->scope_ids, views->scope_id_count);
    context_flow_set_free(&views->flows);
    context_bridge_set_free(&views->bridges);
    *views = (ContextViews){0};
}

int context_build_views(const RepositoryIndex *index, const ContextViewsRequest *request,
                        ContextViews *out)
{
    if (index == NULL || request == NULL || request->flow == NULL || out == NULL)
        return CHRONOS_INVALID_ARGUMENT;
    *out = (ContextViews){0};
    ContextViews result = {0};
    EvidenceCatalog catalog = {0};
    ContextGraph graph = {0};
    ContextBrief brief = {0};
    char **scope_ids = NULL;
    size_t scope_id_count = 0;
    BriefBuilder builder = {0};
    size_t max_items = request->budget.max_items
        ? request->budget.max_items : CHRONOS_VIEWS_DEFAULT_MAX_ITEMS;
    if (max_items > CHRONOS_VIEWS_MAX_ITEMS) max_items = CHRONOS_VIEWS_MAX_ITEMS;
    size_t max_bytes = request->budget.max_source_bytes
        ? request->budget.max_source_bytes : CHRONOS_VIEWS_DEFAULT_MAX_SOURCE_BYTES;

    int status = context_discover_flows(index, request->flow, &result.flows);
    if (status < 0) goto cleanup;

    status = context_discover_bridges(index, &result.bridges);
    if (status < 0) goto cleanup;

    builder = (BriefBuilder){
        .index = index,
        .catalog = &catalog,
        .max_items = max_items,
        .max_source_bytes = max_bytes
    };
    ChronosCoverage coverage = combined_coverage(result.flows.coverage,
                                                 result.bridges.coverage);
    status = build_brief(&builder, &result.flows, request->flow->mode, coverage, &brief);
    if (status < 0) goto cleanup;

    status = build_graph(index, &result.flows, &result.bridges, &builder.selected,
                         &catalog, &scope_ids, &scope_id_count, &graph);
    if (status < 0) goto cleanup;

    ContextEvidence *brief_catalog = NULL;
    size_t brief_catalog_count = 0;
    status = build_brief_catalog(&brief, catalog.items, catalog.count,
                                 &brief_catalog, &brief_catalog_count);
    if (status < 0) {
        free(brief_catalog);
        goto cleanup;
    }
    brief.evidence = brief_catalog;
    brief.evidence_count = brief_catalog_count;
    result.graph = graph;
    result.brief = brief;
    result.scope_ids = scope_ids;
    result.scope_id_count = scope_id_count;
    graph = (ContextGraph){0};
    brief = (ContextBrief){0};
    scope_ids = NULL;
    scope_id_count = 0;
    catalog = (EvidenceCatalog){0};
    free_builder(&builder);
    *out = result;
    return coverage == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;

cleanup:
    free_builder(&builder);
    free_graph_arrays(&graph);
    free_brief_arrays(&brief);
    catalog_free(&catalog);
    free_scope_ids(scope_ids, scope_id_count);
    context_views_free(&result);
    return status;
}
