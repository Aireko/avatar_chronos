#include "context_compiler.h"

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
    int status;
} TextBuffer;

static int buffer_reserve(TextBuffer *buffer, size_t extra)
{
    if (buffer->status < 0) return 0;
    if (extra > SIZE_MAX - buffer->length - 1) {
        buffer->status = CHRONOS_TOO_LARGE;
        return 0;
    }
    size_t needed = buffer->length + extra + 1;
    if (needed <= buffer->capacity) return 1;
    size_t capacity = buffer->capacity ? buffer->capacity : 128;
    while (capacity < needed) {
        if (capacity > SIZE_MAX / 2) {
            capacity = needed;
            break;
        }
        capacity *= 2;
    }
    char *data = realloc(buffer->data, capacity);
    if (data == NULL) {
        buffer->status = CHRONOS_OUT_OF_MEMORY;
        return 0;
    }
    buffer->data = data;
    buffer->capacity = capacity;
    return 1;
}

static void buffer_bytes(TextBuffer *buffer, const char *bytes, size_t length)
{
    if (!buffer_reserve(buffer, length)) return;
    memcpy(buffer->data + buffer->length, bytes, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
}

static void buffer_text(TextBuffer *buffer, const char *text)
{
    buffer_bytes(buffer, text, strlen(text));
}

static void buffer_char(TextBuffer *buffer, char value)
{
    buffer_bytes(buffer, &value, 1);
}

static void buffer_integer(TextBuffer *buffer, size_t value)
{
    char digits[sizeof(size_t) * CHAR_BIT + 1];
    if ((uintmax_t)value > UINTMAX_C(9007199254740991)) {
        buffer->status = CHRONOS_TOO_LARGE;
        return;
    }
    (void)snprintf(digits, sizeof digits, "%zu", value);
    buffer_text(buffer, digits);
}

static void buffer_string(TextBuffer *buffer, const char *value)
{
    static const char hex[] = "0123456789abcdef";
    if (value == NULL) {
        buffer_text(buffer, "null");
        return;
    }
    buffer_char(buffer, '"');
    for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
        switch (*p) {
        case '"': buffer_text(buffer, "\\\""); break;
        case '\\': buffer_text(buffer, "\\\\"); break;
        case '\b': buffer_text(buffer, "\\b"); break;
        case '\f': buffer_text(buffer, "\\f"); break;
        case '\n': buffer_text(buffer, "\\n"); break;
        case '\r': buffer_text(buffer, "\\r"); break;
        case '\t': buffer_text(buffer, "\\t"); break;
        default:
            if (*p < 0x20) {
                char escape[] = {'\\', 'u', '0', '0', hex[*p >> 4], hex[*p & 15]};
                buffer_bytes(buffer, escape, sizeof escape);
            } else {
                buffer_char(buffer, (char)*p);
            }
        }
    }
    buffer_char(buffer, '"');
}

static void buffer_required_string(TextBuffer *buffer, const char *value)
{
    if (value == NULL) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, value);
}

/* Scope and symbol IDs already have a JSON-array form. Copy them verbatim. */
static void buffer_json_or_string(TextBuffer *buffer, const char *value)
{
    if (value == NULL) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    if (value[0] == '[') buffer_text(buffer, value);
    else buffer_string(buffer, value);
}

static char *buffer_take(TextBuffer *buffer)
{
    if (buffer->status < 0) {
        free(buffer->data);
        return NULL;
    }
    if (buffer->data == NULL) {
        buffer->data = malloc(1);
        if (buffer->data == NULL) return NULL;
        buffer->data[0] = '\0';
    }
    return buffer->data;
}

static int finish_json(TextBuffer *buffer, char *out, size_t out_size)
{
    if (buffer->status < 0) {
        free(buffer->data);
        return buffer->status;
    }
    if (buffer->length > (size_t)INT_MAX) {
        free(buffer->data);
        return CHRONOS_TOO_LARGE;
    }
    int length = (int)buffer->length;
    if (out_size > buffer->length) {
        memcpy(out, buffer->data, buffer->length);
        out[buffer->length] = '\0';
    }
    free(buffer->data);
    return length;
}

static int append_framed(TextBuffer *buffer, const char *prefix, const char *first,
                         const char *second)
{
    size_t first_length = strlen(first);
    size_t second_length = strlen(second);
    buffer_text(buffer, prefix);
    buffer_integer(buffer, first_length);
    buffer_char(buffer, ':');
    buffer_text(buffer, first);
    buffer_integer(buffer, second_length);
    buffer_char(buffer, ':');
    buffer_text(buffer, second);
    return buffer->status;
}

char *context_scope_id_alloc(ContextScopeKind kind, const char *path,
                             const SymbolVersionRef *symbol)
{
    TextBuffer buffer = {0};
    buffer_text(&buffer, "[");
    switch (kind) {
    case CONTEXT_SCOPE_PROJECT:
        buffer_text(&buffer, "\"project\"");
        break;
    case CONTEXT_SCOPE_MODULE:
    case CONTEXT_SCOPE_FILE:
        if (path == NULL || *path == '\0') {
            buffer.status = CHRONOS_INVALID_ARGUMENT;
            break;
        }
        buffer_text(&buffer, kind == CONTEXT_SCOPE_MODULE ? "\"module\"," : "\"file\",");
        buffer_string(&buffer, path);
        break;
    case CONTEXT_SCOPE_SYMBOL:
        if (symbol == NULL) {
            buffer.status = CHRONOS_INVALID_ARGUMENT;
            break;
        }
        buffer_text(&buffer, "\"symbol\",");
        buffer_json_or_string(&buffer, symbol->id);
        break;
    default:
        buffer.status = CHRONOS_INVALID_ARGUMENT;
        break;
    }
    buffer_text(&buffer, "]");
    return buffer_take(&buffer);
}

char *context_symbol_scope_id_alloc(const GraphSymbol *symbol)
{
    if (symbol == NULL) return NULL;
    TextBuffer buffer = {0};
    buffer_text(&buffer, "[\"symbol\",");
    buffer_json_or_string(&buffer, symbol->logical_id ? symbol->logical_id : symbol->ref.id);
    buffer_text(&buffer, "]");
    return buffer_take(&buffer);
}

char *context_symbol_evidence_id_alloc(const SymbolVersionRef *symbol)
{
    if (symbol == NULL || symbol->id == NULL) return NULL;
    TextBuffer buffer = {0};
    size_t length = strlen(symbol->id);
    buffer_text(&buffer, "source:v1:");
    buffer_integer(&buffer, length);
    buffer_char(&buffer, ':');
    buffer_text(&buffer, symbol->id);
    return buffer_take(&buffer);
}

char *context_call_evidence_id_alloc(const GraphCall *call)
{
    if (call == NULL || call->caller.id == NULL || call->callee_text == NULL) return NULL;
    const char *callee = call->callee && call->callee->id ? call->callee->id : call->callee_text;
    TextBuffer buffer = {0};
    size_t caller_length = strlen(call->caller.id);
    size_t callee_length = strlen(callee);
    buffer_text(&buffer, "call:v1:");
    buffer_integer(&buffer, caller_length);
    buffer_char(&buffer, ':');
    buffer_text(&buffer, call->caller.id);
    buffer_integer(&buffer, callee_length);
    buffer_char(&buffer, ':');
    buffer_text(&buffer, callee);
    buffer_char(&buffer, ':');
    buffer_integer(&buffer, call->call_site.range.start_byte);
    buffer_char(&buffer, ':');
    buffer_integer(&buffer, call->call_site.range.end_byte);
    return buffer_take(&buffer);
}

char *context_contains_evidence_id_alloc(const char *parent_id, const char *child_id)
{
    if (parent_id == NULL || child_id == NULL) return NULL;
    TextBuffer buffer = {0};
    buffer_text(&buffer, "contains:v1:");
    (void)append_framed(&buffer, "", parent_id, child_id);
    return buffer_take(&buffer);
}

char *context_change_evidence_id_alloc(const SymbolVersionRef *before,
                                       const SymbolVersionRef *after)
{
    const char *before_id = before && before->id ? before->id : "null";
    const char *after_id = after && after->id ? after->id : "null";
    TextBuffer buffer = {0};
    buffer_text(&buffer, "change:v1:");
    (void)append_framed(&buffer, "", before_id, after_id);
    return buffer_take(&buffer);
}

const char *context_mode_name(ContextCompilerMode mode)
{
    switch (mode) {
    case CONTEXT_MODE_ONBOARDING: return "onboarding";
    case CONTEXT_MODE_TASK: return "task";
    case CONTEXT_MODE_REVIEW: return "review";
    default: return NULL;
    }
}

const char *context_relation_state_name(ContextRelationState state)
{
    switch (state) {
    case CONTEXT_RELATION_SELECTED: return "selected";
    case CONTEXT_RELATION_OMITTED: return "omitted";
    case CONTEXT_RELATION_UNRESOLVED: return "unresolved";
    case CONTEXT_RELATION_AMBIGUOUS: return "ambiguous";
    case CONTEXT_RELATION_UNAVAILABLE: return "unavailable";
    default: return NULL;
    }
}

const char *context_scope_kind_name(ContextScopeKind kind)
{
    switch (kind) {
    case CONTEXT_SCOPE_PROJECT: return "project";
    case CONTEXT_SCOPE_MODULE: return "module";
    case CONTEXT_SCOPE_FILE: return "file";
    case CONTEXT_SCOPE_SYMBOL: return "symbol";
    default: return NULL;
    }
}

const char *context_evidence_kind_name(ContextEvidenceKind kind)
{
    switch (kind) {
    case CONTEXT_EVIDENCE_CALL: return "call";
    case CONTEXT_EVIDENCE_CONTAINS: return "contains";
    case CONTEXT_EVIDENCE_CHANGE: return "change";
    case CONTEXT_EVIDENCE_SOURCE: return "source";
    default: return NULL;
    }
}

static int valid_text(const char *text)
{
    return text != NULL && *text != '\0';
}

static int valid_commit_sha(const char *sha)
{
    if (sha == NULL || strlen(sha) != 40) return 0;
    for (const char *p = sha; *p; ++p) {
        if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return 0;
    }
    return 1;
}

static int valid_revision(const RevisionRef *revision)
{
    return revision != NULL && valid_text(revision->repository_id) &&
           valid_commit_sha(revision->commit_sha);
}

static int same_revision(const RevisionRef *left, const RevisionRef *right)
{
    return left != NULL && right != NULL &&
           strcmp(left->repository_id, right->repository_id) == 0 &&
           strcmp(left->commit_sha, right->commit_sha) == 0;
}

static int valid_range(SourceRange range)
{
    return range.start_byte <= range.end_byte && range.start_line != 0 &&
           range.start_line <= range.end_line &&
           (range.start_byte != range.end_byte || range.start_line == range.end_line) &&
           (uintmax_t)range.end_byte <= UINTMAX_C(9007199254740991) &&
           (uintmax_t)range.end_line <= UINTMAX_C(9007199254740991);
}

static int valid_location(const SourceLocation *location)
{
    return location != NULL && valid_revision(&location->revision) &&
           valid_text(location->file_path) && valid_range(location->range);
}

static int valid_ref(const SymbolVersionRef *ref)
{
    return ref != NULL && valid_revision(&ref->revision) && valid_text(ref->id);
}

static int valid_call(const GraphCall *call)
{
    if (call == NULL || !valid_ref(&call->caller) || !valid_text(call->callee_text) ||
        !valid_location(&call->call_site)) return 0;
    switch (call->resolution) {
    case CALL_RESOLVED:
        return valid_ref(call->callee) && call->candidate_count == 0;
    case CALL_UNRESOLVED:
        return call->callee == NULL && call->candidate_count == 0;
    case CALL_AMBIGUOUS:
        if (call->callee != NULL || call->candidate_count < 2 || call->candidates == NULL)
            return 0;
        for (size_t i = 0; i < call->candidate_count; ++i)
            if (!valid_ref(&call->candidates[i])) return 0;
        return 1;
    default:
        return 0;
    }
}

static int valid_coverage(ChronosCoverage coverage)
{
    return (unsigned)coverage <= CHRONOS_UNAVAILABLE;
}

static int valid_comparison(const GraphComparison *comparison, const RevisionRef *revision)
{
    if (comparison == NULL) return 1;
    return valid_revision(&comparison->base) && valid_revision(&comparison->head) &&
           strcmp(comparison->base.repository_id, comparison->head.repository_id) == 0 &&
           (same_revision(revision, &comparison->base) || same_revision(revision, &comparison->head));
}

static int valid_diagnostic(const ChronosDiagnostic *item)
{
    return item != NULL && item->code != NULL && item->message != NULL &&
           (unsigned)item->severity <= DIAGNOSTIC_ERROR &&
           (item->location == NULL || valid_location(item->location));
}

static int valid_anchor(const ContextRequest *request, const ContextAnchor *anchor)
{
    if (anchor == NULL) return 0;
    switch (anchor->kind) {
    case CONTEXT_ANCHOR_SYMBOL:
        return anchor->path == NULL && valid_ref(anchor->symbol) &&
               (same_revision(&anchor->symbol->revision, &request->head) ||
                (request->base != NULL && same_revision(&anchor->symbol->revision, request->base)));
    case CONTEXT_ANCHOR_PATH:
        return valid_text(anchor->path) && anchor->symbol == NULL;
    case CONTEXT_ANCHOR_CHANGED_SYMBOL:
        return anchor->path == NULL && request->base != NULL && valid_ref(anchor->symbol) &&
               (same_revision(&anchor->symbol->revision, &request->head) ||
                same_revision(&anchor->symbol->revision, request->base));
    default:
        return 0;
    }
}

int context_request_validate(const ContextRequest *request)
{
    if (request == NULL || request->schema_version != CHRONOS_COMPILER_REQUEST_SCHEMA_VERSION)
        return CHRONOS_INVALID_ARGUMENT;
    if (request->repository == NULL || !valid_text(request->repository->id) ||
        !valid_text(request->repository->local_path)) return CHRONOS_INVALID_ARGUMENT;
    if (!valid_revision(&request->head) ||
        strcmp(request->head.repository_id, request->repository->id) != 0)
        return CHRONOS_INVALID_ARGUMENT;
    if (request->base != NULL &&
        (!valid_revision(request->base) ||
         strcmp(request->base->repository_id, request->repository->id) != 0))
        return CHRONOS_INVALID_ARGUMENT;
    if (context_mode_name(request->mode) == NULL) return CHRONOS_INVALID_ARGUMENT;
    if (request->anchor_count != 0 && request->anchors == NULL) return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < request->anchor_count; ++i) {
        if (!valid_anchor(request, &request->anchors[i])) return CHRONOS_INVALID_ARGUMENT;
    }
    if (request->mode == CONTEXT_MODE_REVIEW &&
        (request->anchor_count != 1 || request->anchors[0].kind != CONTEXT_ANCHOR_SYMBOL))
        return CHRONOS_INVALID_ARGUMENT;
    if (request->mode == CONTEXT_MODE_TASK && request->anchor_count == 0)
        return CHRONOS_INVALID_ARGUMENT;
    if (request->max_hops > CHRONOS_COMPILER_MAX_HOPS) return CHRONOS_INVALID_ARGUMENT;
    return CHRONOS_OK;
}

static void write_revision(TextBuffer *buffer, const RevisionRef *revision)
{
    buffer_text(buffer, "{\"repositoryId\":");
    buffer_required_string(buffer, revision->repository_id);
    buffer_text(buffer, ",\"commitSha\":");
    buffer_required_string(buffer, revision->commit_sha);
    buffer_text(buffer, "}");
}

static void write_ref(TextBuffer *buffer, const SymbolVersionRef *ref)
{
    if (ref == NULL) {
        buffer_text(buffer, "null");
        return;
    }
    buffer_text(buffer, "{\"revision\":");
    write_revision(buffer, &ref->revision);
    buffer_text(buffer, ",\"id\":");
    buffer_required_string(buffer, ref->id);
    buffer_text(buffer, "}");
}

static void write_location(TextBuffer *buffer, const SourceLocation *location)
{
    if (location == NULL) {
        buffer_text(buffer, "null");
        return;
    }
    buffer_text(buffer, "{\"revision\":");
    write_revision(buffer, &location->revision);
    buffer_text(buffer, ",\"filePath\":");
    buffer_required_string(buffer, location->file_path);
    buffer_text(buffer, ",\"range\":{\"startByte\":");
    buffer_integer(buffer, location->range.start_byte);
    buffer_text(buffer, ",\"endByte\":");
    buffer_integer(buffer, location->range.end_byte);
    buffer_text(buffer, ",\"startLine\":");
    buffer_integer(buffer, location->range.start_line);
    buffer_text(buffer, ",\"endLine\":");
    buffer_integer(buffer, location->range.end_line);
    buffer_text(buffer, "}}");
}

static void write_call(TextBuffer *buffer, const GraphCall *call)
{
    static const char *const resolutions[] = {"resolved", "unresolved", "ambiguous"};
    buffer_text(buffer, "{\"caller\":");
    write_ref(buffer, &call->caller);
    buffer_text(buffer, ",\"calleeText\":");
    buffer_required_string(buffer, call->callee_text);
    buffer_text(buffer, ",\"callSite\":");
    write_location(buffer, &call->call_site);
    buffer_text(buffer, ",\"resolution\":");
    if ((unsigned)call->resolution >= sizeof resolutions / sizeof resolutions[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, resolutions[call->resolution]);
    buffer_text(buffer, ",\"callee\":");
    write_ref(buffer, call->callee);
    buffer_text(buffer, ",\"candidates\":[");
    for (size_t i = 0; i < call->candidate_count; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        write_ref(buffer, &call->candidates[i]);
    }
    buffer_text(buffer, "]}");
}

static void write_diagnostic(TextBuffer *buffer, const ChronosDiagnostic *diagnostic)
{
    static const char *const severities[] = {"info", "warning", "error"};
    buffer_text(buffer, "{\"code\":");
    buffer_required_string(buffer, diagnostic->code);
    buffer_text(buffer, ",\"severity\":");
    if ((unsigned)diagnostic->severity >= sizeof severities / sizeof severities[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, severities[diagnostic->severity]);
    buffer_text(buffer, ",\"message\":");
    buffer_required_string(buffer, diagnostic->message);
    buffer_text(buffer, ",\"location\":");
    write_location(buffer, diagnostic->location);
    buffer_text(buffer, "}");
}

static void begin_collection(TextBuffer *buffer, ChronosCoverage coverage)
{
    static const char *const names[] = {"complete", "incomplete", "unavailable"};
    buffer_text(buffer, "{\"status\":");
    if ((unsigned)coverage >= sizeof names / sizeof names[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, names[coverage]);
    buffer_text(buffer, coverage == CHRONOS_UNAVAILABLE ? ",\"items\":null" : ",\"items\":[");
}

static void end_collection(TextBuffer *buffer, ChronosCoverage coverage)
{
    buffer_text(buffer, coverage == CHRONOS_UNAVAILABLE ? "}" : "]}");
}

static int write_request(TextBuffer *buffer, const ContextRequest *request)
{
    buffer_text(buffer, "{\"schemaVersion\":");
    buffer_integer(buffer, request->schema_version);
    buffer_text(buffer, ",\"repository\":{\"id\":");
    buffer_required_string(buffer, request->repository->id);
    buffer_text(buffer, ",\"path\":");
    buffer_required_string(buffer, request->repository->local_path);
    buffer_text(buffer, "},\"head\":");
    write_revision(buffer, &request->head);
    buffer_text(buffer, ",\"base\":");
    if (request->base == NULL) buffer_text(buffer, "null");
    else write_revision(buffer, request->base);
    buffer_text(buffer, ",\"mode\":");
    const char *mode = context_mode_name(request->mode);
    if (mode == NULL) buffer->status = CHRONOS_INVALID_ARGUMENT;
    else buffer_string(buffer, mode);
    buffer_text(buffer, ",\"anchors\":[");
    for (size_t i = 0; i < request->anchor_count; ++i) {
        const ContextAnchor *anchor = &request->anchors[i];
        if (i != 0) buffer_char(buffer, ',');
        buffer_text(buffer, "{\"kind\":");
        switch (anchor->kind) {
        case CONTEXT_ANCHOR_SYMBOL: buffer_string(buffer, "symbol"); break;
        case CONTEXT_ANCHOR_PATH: buffer_string(buffer, "path"); break;
        case CONTEXT_ANCHOR_CHANGED_SYMBOL: buffer_string(buffer, "changedSymbol"); break;
        default: buffer->status = CHRONOS_INVALID_ARGUMENT; break;
        }
        buffer_text(buffer, ",\"path\":");
        buffer_string(buffer, anchor->path);
        buffer_text(buffer, ",\"symbol\":");
        write_ref(buffer, anchor->symbol);
        buffer_char(buffer, '}');
    }
    buffer_text(buffer, "],\"maxHops\":");
    buffer_integer(buffer, request->max_hops ? request->max_hops : CHRONOS_COMPILER_DEFAULT_MAX_HOPS);
    buffer_text(buffer, ",\"budget\":{\"maxItems\":");
    buffer_integer(buffer, request->budget.max_items);
    buffer_text(buffer, ",\"maxSourceBytes\":");
    buffer_integer(buffer, request->budget.max_source_bytes);
    buffer_text(buffer, "}}");
    return buffer->status;
}

int context_request_write_json(const ContextRequest *request, char *out, size_t out_size)
{
    if (context_request_validate(request) < 0 || (out == NULL && out_size != 0))
        return CHRONOS_INVALID_ARGUMENT;
    TextBuffer buffer = {0};
    (void)write_request(&buffer, request);
    return finish_json(&buffer, out, out_size);
}

static int valid_node(const ContextGraphNode *node)
{
    if (node == NULL || !valid_text(node->id) || !valid_coverage(node->coverage) ||
        context_scope_kind_name(node->kind) == NULL ||
        context_relation_state_name(node->state) == NULL) return 0;
    if (node->kind == CONTEXT_SCOPE_SYMBOL) {
        if (!valid_ref(node->symbol)) return 0;
    } else if (node->symbol != NULL) {
        return 0;
    }
    if (node->kind == CONTEXT_SCOPE_PROJECT) return node->parent_id == NULL;
    return valid_text(node->parent_id);
}

static int valid_edge(const ContextGraphEdge *edge)
{
    if (edge == NULL || !valid_text(edge->id) || !valid_text(edge->from) ||
        context_evidence_kind_name(edge->kind) == NULL ||
        context_relation_state_name(edge->state) == NULL ||
        !valid_text(edge->evidence_id)) return 0;
    switch (edge->kind) {
    case CONTEXT_EVIDENCE_CALL:
        if (!valid_call(edge->call)) return 0;
        break;
    case CONTEXT_EVIDENCE_CONTAINS:
    case CONTEXT_EVIDENCE_CHANGE:
        if (edge->call != NULL) return 0;
        break;
    default:
        return 0;
    }
    switch (edge->state) {
    case CONTEXT_RELATION_SELECTED:
    case CONTEXT_RELATION_OMITTED:
        return valid_text(edge->to);
    case CONTEXT_RELATION_UNRESOLVED:
    case CONTEXT_RELATION_AMBIGUOUS:
        return edge->to == NULL;
    case CONTEXT_RELATION_UNAVAILABLE:
        return 1;
    default:
        return 0;
    }
}

static int valid_evidence(const ContextEvidence *evidence)
{
    if (evidence == NULL || !valid_text(evidence->id) ||
        context_evidence_kind_name(evidence->kind) == NULL ||
        context_relation_state_name(evidence->state) == NULL) return 0;
    if (evidence->kind == CONTEXT_EVIDENCE_CALL)
        return valid_call(evidence->call) && valid_location(evidence->location);
    if (evidence->kind == CONTEXT_EVIDENCE_SOURCE)
        return evidence->call == NULL && valid_location(evidence->location);
    return evidence->call == NULL &&
           (evidence->location == NULL || valid_location(evidence->location));
}

static int collection_valid(ChronosCoverage coverage, const void *items, size_t count)
{
    if (!valid_coverage(coverage)) return 0;
    if (coverage == CHRONOS_UNAVAILABLE) return items == NULL && count == 0;
    return count == 0 || items != NULL;
}

static int write_graph(TextBuffer *buffer, const ContextGraph *graph)
{
    buffer_text(buffer, "{\"schemaVersion\":");
    buffer_integer(buffer, graph->schema_version);
    buffer_text(buffer, ",\"repositoryId\":");
    buffer_required_string(buffer, graph->revision.repository_id);
    buffer_text(buffer, ",\"revision\":");
    write_revision(buffer, &graph->revision);
    buffer_text(buffer, ",\"comparison\":");
    if (graph->comparison == NULL) {
        buffer_text(buffer, "null");
    } else {
        buffer_text(buffer, "{\"base\":");
        write_revision(buffer, &graph->comparison->base);
        buffer_text(buffer, ",\"head\":");
        write_revision(buffer, &graph->comparison->head);
        buffer_text(buffer, "}");
    }

    buffer_text(buffer, ",\"nodes\":");
    begin_collection(buffer, graph->node_coverage);
    for (size_t i = 0; i < graph->node_count && buffer->status >= 0; ++i) {
        const ContextGraphNode *node = &graph->nodes[i];
        if (i != 0) buffer_char(buffer, ',');
        buffer_text(buffer, "{\"id\":");
        buffer_required_string(buffer, node->id);
        buffer_text(buffer, ",\"kind\":");
        buffer_string(buffer, context_scope_kind_name(node->kind));
        buffer_text(buffer, ",\"parentId\":");
        buffer_string(buffer, node->parent_id);
        buffer_text(buffer, ",\"label\":");
        buffer_required_string(buffer, node->label);
        buffer_text(buffer, ",\"symbol\":");
        write_ref(buffer, node->symbol);
        buffer_text(buffer, ",\"coverage\":");
        buffer_string(buffer, node->coverage == CHRONOS_COMPLETE ? "complete" :
                              node->coverage == CHRONOS_INCOMPLETE ? "incomplete" : "unavailable");
        buffer_text(buffer, ",\"state\":");
        buffer_string(buffer, context_relation_state_name(node->state));
        buffer_char(buffer, '}');
    }
    end_collection(buffer, graph->node_coverage);

    buffer_text(buffer, ",\"edges\":");
    begin_collection(buffer, graph->edge_coverage);
    for (size_t i = 0; i < graph->edge_count && buffer->status >= 0; ++i) {
        const ContextGraphEdge *edge = &graph->edges[i];
        if (i != 0) buffer_char(buffer, ',');
        buffer_text(buffer, "{\"id\":");
        buffer_required_string(buffer, edge->id);
        buffer_text(buffer, ",\"from\":");
        buffer_required_string(buffer, edge->from);
        buffer_text(buffer, ",\"to\":");
        buffer_string(buffer, edge->to);
        buffer_text(buffer, ",\"kind\":");
        buffer_string(buffer, context_evidence_kind_name(edge->kind));
        buffer_text(buffer, ",\"state\":");
        buffer_string(buffer, context_relation_state_name(edge->state));
        buffer_text(buffer, ",\"evidenceId\":");
        buffer_required_string(buffer, edge->evidence_id);
        buffer_text(buffer, ",\"call\":");
        if (edge->call == NULL) buffer_text(buffer, "null");
        else write_call(buffer, edge->call);
        buffer_char(buffer, '}');
    }
    end_collection(buffer, graph->edge_coverage);

    buffer_text(buffer, ",\"evidence\":");
    begin_collection(buffer, graph->evidence_coverage);
    for (size_t i = 0; i < graph->evidence_count && buffer->status >= 0; ++i) {
        const ContextEvidence *evidence = &graph->evidence[i];
        if (i != 0) buffer_char(buffer, ',');
        buffer_text(buffer, "{\"id\":");
        buffer_required_string(buffer, evidence->id);
        buffer_text(buffer, ",\"kind\":");
        buffer_string(buffer, context_evidence_kind_name(evidence->kind));
        buffer_text(buffer, ",\"state\":");
        buffer_string(buffer, context_relation_state_name(evidence->state));
        buffer_text(buffer, ",\"location\":");
        write_location(buffer, evidence->location);
        buffer_text(buffer, ",\"call\":");
        if (evidence->call == NULL) buffer_text(buffer, "null");
        else write_call(buffer, evidence->call);
        buffer_char(buffer, '}');
    }
    end_collection(buffer, graph->evidence_coverage);

    buffer_text(buffer, ",\"diagnostics\":[");
    for (size_t i = 0; i < graph->diagnostic_count && buffer->status >= 0; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        write_diagnostic(buffer, &graph->diagnostics[i]);
    }
    buffer_text(buffer, "],\"adapter\":{\"name\":");
    buffer_string(buffer, CHRONOS_MOCK_UI_ADAPTER);
    buffer_text(buffer, ",\"schemaVersion\":");
    buffer_integer(buffer, CHRONOS_MOCK_UI_ADAPTER_VERSION);
    buffer_text(buffer, ",\"graphSchemaVersion\":");
    buffer_integer(buffer, CHRONOS_COMPILER_GRAPH_SCHEMA_VERSION);
    buffer_text(buffer, ",\"briefSchemaVersion\":");
    buffer_integer(buffer, CHRONOS_COMPILER_BRIEF_SCHEMA_VERSION);
    buffer_text(buffer, ",\"reviewContextSchemaVersion\":");
    buffer_integer(buffer, CHRONOS_CONTEXT_SCHEMA_VERSION);
    buffer_text(buffer, "}}");
    return buffer->status;
}

int context_graph_write_json(const ContextGraph *graph, char *out, size_t out_size)
{
    if (graph == NULL || (out == NULL && out_size != 0) ||
        graph->schema_version != CHRONOS_COMPILER_GRAPH_SCHEMA_VERSION ||
        !valid_revision(&graph->revision) ||
        !valid_comparison(graph->comparison, &graph->revision) ||
        !collection_valid(graph->node_coverage, graph->nodes, graph->node_count) ||
        !collection_valid(graph->edge_coverage, graph->edges, graph->edge_count) ||
        !collection_valid(graph->evidence_coverage, graph->evidence, graph->evidence_count) ||
        (graph->diagnostic_count != 0 && graph->diagnostics == NULL))
        return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < graph->node_count; ++i)
        if (!valid_node(&graph->nodes[i])) return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < graph->edge_count; ++i)
        if (!valid_edge(&graph->edges[i])) return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < graph->evidence_count; ++i)
        if (!valid_evidence(&graph->evidence[i])) return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < graph->diagnostic_count; ++i)
        if (!valid_diagnostic(&graph->diagnostics[i])) return CHRONOS_INVALID_ARGUMENT;

    TextBuffer buffer = {0};
    (void)write_graph(&buffer, graph);
    return finish_json(&buffer, out, out_size);
}

static int evidence_exists(const ContextEvidence *items, size_t count, const char *id)
{
    for (size_t i = 0; i < count; ++i)
        if (strcmp(items[i].id, id) == 0) return 1;
    return 0;
}

static int evidence_is_omitted(const ContextEvidence *items, size_t count, const char *id)
{
    for (size_t i = 0; i < count; ++i)
        if (strcmp(items[i].id, id) == 0)
            return items[i].state == CONTEXT_RELATION_OMITTED;
    return 0;
}

static int valid_brief_item(const ContextBriefItem *item, const ContextEvidence *evidence,
                            size_t evidence_count)
{
    if (item == NULL || item->text == NULL ||
        context_relation_state_name(item->state) == NULL ||
        (item->evidence_count != 0 && item->evidence_ids == NULL)) return 0;
    for (size_t i = 0; i < item->evidence_count; ++i)
        if (!valid_text(item->evidence_ids[i]) ||
            !evidence_exists(evidence, evidence_count, item->evidence_ids[i])) return 0;
    return 1;
}

static int write_brief(TextBuffer *buffer, const ContextBrief *brief)
{
    buffer_text(buffer, "{\"schemaVersion\":");
    buffer_integer(buffer, brief->schema_version);
    buffer_text(buffer, ",\"repositoryId\":");
    buffer_required_string(buffer, brief->revision.repository_id);
    buffer_text(buffer, ",\"revision\":");
    write_revision(buffer, &brief->revision);
    buffer_text(buffer, ",\"comparison\":");
    if (brief->comparison == NULL) {
        buffer_text(buffer, "null");
    } else {
        buffer_text(buffer, "{\"base\":");
        write_revision(buffer, &brief->comparison->base);
        buffer_text(buffer, ",\"head\":");
        write_revision(buffer, &brief->comparison->head);
        buffer_text(buffer, "}");
    }
    buffer_text(buffer, ",\"sections\":[");
    for (size_t i = 0; i < brief->section_count && buffer->status >= 0; ++i) {
        const ContextBriefSection *section = &brief->sections[i];
        if (i != 0) buffer_char(buffer, ',');
        buffer_text(buffer, "{\"id\":");
        buffer_required_string(buffer, section->id);
        buffer_text(buffer, ",\"title\":");
        buffer_required_string(buffer, section->title);
        buffer_text(buffer, ",\"items\":[");
        for (size_t j = 0; j < section->item_count && buffer->status >= 0; ++j) {
            const ContextBriefItem *item = &section->items[j];
            if (j != 0) buffer_char(buffer, ',');
            buffer_text(buffer, "{\"text\":");
            buffer_required_string(buffer, item->text);
            buffer_text(buffer, ",\"evidenceIds\":[");
            for (size_t k = 0; k < item->evidence_count; ++k) {
                if (k != 0) buffer_char(buffer, ',');
                buffer_required_string(buffer, item->evidence_ids[k]);
            }
            buffer_text(buffer, "],\"state\":");
            buffer_string(buffer, context_relation_state_name(item->state));
            buffer_char(buffer, '}');
        }
        buffer_text(buffer, "]}");
    }
    buffer_text(buffer, "],\"budget\":{\"usedSourceBytes\":");
    buffer_integer(buffer, brief->used_source_bytes);
    buffer_text(buffer, "},\"omittedEvidenceIds\":[");
    for (size_t i = 0; i < brief->omitted_count; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        buffer_required_string(buffer, brief->omitted_ids[i]);
    }
    buffer_text(buffer, "],\"coverage\":");
    buffer_string(buffer, brief->coverage == CHRONOS_COMPLETE ? "complete" :
                          brief->coverage == CHRONOS_INCOMPLETE ? "incomplete" : "unavailable");
    buffer_text(buffer, ",\"evidence\":");
    begin_collection(buffer, brief->evidence_coverage);
    for (size_t i = 0; i < brief->evidence_count && buffer->status >= 0; ++i) {
        const ContextEvidence *evidence = &brief->evidence[i];
        if (i != 0) buffer_char(buffer, ',');
        buffer_text(buffer, "{\"id\":");
        buffer_required_string(buffer, evidence->id);
        buffer_text(buffer, ",\"kind\":");
        buffer_string(buffer, context_evidence_kind_name(evidence->kind));
        buffer_text(buffer, ",\"state\":");
        buffer_string(buffer, context_relation_state_name(evidence->state));
        buffer_text(buffer, ",\"location\":");
        write_location(buffer, evidence->location);
        buffer_text(buffer, ",\"call\":");
        if (evidence->call == NULL) buffer_text(buffer, "null");
        else write_call(buffer, evidence->call);
        buffer_char(buffer, '}');
    }
    end_collection(buffer, brief->evidence_coverage);
    buffer_char(buffer, '}');
    return buffer->status;
}

int context_brief_write_json(const ContextBrief *brief, char *out, size_t out_size)
{
    if (brief == NULL || (out == NULL && out_size != 0) ||
        brief->schema_version != CHRONOS_COMPILER_BRIEF_SCHEMA_VERSION ||
        !valid_revision(&brief->revision) ||
        !valid_comparison(brief->comparison, &brief->revision) ||
        !collection_valid(brief->evidence_coverage, brief->evidence, brief->evidence_count) ||
        !valid_coverage(brief->coverage) ||
        (brief->section_count != 0 && brief->sections == NULL) ||
        (brief->omitted_count != 0 && brief->omitted_ids == NULL))
        return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < brief->evidence_count; ++i)
        if (!valid_evidence(&brief->evidence[i])) return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < brief->section_count; ++i) {
        const ContextBriefSection *section = &brief->sections[i];
        if (!valid_text(section->id) || !valid_text(section->title) ||
            (section->item_count != 0 && section->items == NULL))
            return CHRONOS_INVALID_ARGUMENT;
        for (size_t j = 0; j < section->item_count; ++j)
            if (!valid_brief_item(&section->items[j], brief->evidence, brief->evidence_count))
                return CHRONOS_INVALID_ARGUMENT;
    }
    for (size_t i = 0; i < brief->omitted_count; ++i) {
        if (!valid_text(brief->omitted_ids[i]) ||
            !evidence_is_omitted(brief->evidence, brief->evidence_count, brief->omitted_ids[i]))
            return CHRONOS_INVALID_ARGUMENT;
    }

    TextBuffer buffer = {0};
    (void)write_brief(&buffer, brief);
    return finish_json(&buffer, out, out_size);
}
