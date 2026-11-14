#include "context_page.h"

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
} PageBuffer;

static int buffer_reserve(PageBuffer *buffer, size_t extra)
{
    if (buffer->status < 0) return 0;
    if (extra > SIZE_MAX - buffer->length - 1) {
        buffer->status = CHRONOS_TOO_LARGE;
        return 0;
    }
    size_t needed = buffer->length + extra + 1;
    if (needed <= buffer->capacity) return 1;
    size_t capacity = buffer->capacity ? buffer->capacity * 2 : 128;
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

static void buffer_bytes(PageBuffer *buffer, const char *bytes, size_t length)
{
    if (!buffer_reserve(buffer, length)) return;
    memcpy(buffer->data + buffer->length, bytes, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
}

static void buffer_text(PageBuffer *buffer, const char *text)
{
    buffer_bytes(buffer, text, strlen(text));
}

static void buffer_char(PageBuffer *buffer, char value)
{
    buffer_bytes(buffer, &value, 1);
}

static void buffer_integer(PageBuffer *buffer, size_t value)
{
    char digits[sizeof(size_t) * CHAR_BIT + 1];
    if ((uintmax_t)value > UINTMAX_C(9007199254740991)) {
        buffer->status = CHRONOS_TOO_LARGE;
        return;
    }
    (void)snprintf(digits, sizeof digits, "%zu", value);
    buffer_text(buffer, digits);
}

static void buffer_string(PageBuffer *buffer, const char *value)
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

static void buffer_required_string(PageBuffer *buffer, const char *value)
{
    if (value == NULL) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, value);
}

static void buffer_source_bytes(PageBuffer *buffer, const char *bytes, size_t length)
{
    static const char hex[] = "0123456789abcdef";
    if (bytes == NULL && length != 0) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_char(buffer, '"');
    for (size_t i = 0; i < length; ++i) {
        unsigned char value = (unsigned char)bytes[i];
        switch (value) {
        case '"': buffer_text(buffer, "\\\""); break;
        case '\\': buffer_text(buffer, "\\\\"); break;
        case '\b': buffer_text(buffer, "\\b"); break;
        case '\f': buffer_text(buffer, "\\f"); break;
        case '\n': buffer_text(buffer, "\\n"); break;
        case '\r': buffer_text(buffer, "\\r"); break;
        case '\t': buffer_text(buffer, "\\t"); break;
        default:
            if (value < 0x20) {
                char escape[] = {'\\', 'u', '0', '0', hex[value >> 4], hex[value & 15]};
                buffer_bytes(buffer, escape, sizeof escape);
            } else {
                buffer_char(buffer, (char)value);
            }
        }
    }
    buffer_char(buffer, '"');
}

static int finish_json(PageBuffer *buffer, char *out, size_t out_size)
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

static int valid_commit_sha(const char *sha)
{
    if (sha == NULL) return 0;
    size_t length = strlen(sha);
    if (length != 40 && length != 64) return 0;
    for (const char *p = sha; *p; ++p)
        if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return 0;
    return 1;
}

static int valid_revision(const RevisionRef *revision)
{
    return revision != NULL && revision->repository_id != NULL &&
           *revision->repository_id != '\0' && valid_commit_sha(revision->commit_sha);
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
           location->file_path != NULL && *location->file_path != '\0' &&
           valid_range(location->range);
}

static int valid_ref(const SymbolVersionRef *ref)
{
    return ref != NULL && valid_revision(&ref->revision) &&
           ref->id != NULL && *ref->id != '\0';
}

static int valid_call(const GraphCall *call)
{
    if (call == NULL || !valid_ref(&call->caller) || call->callee_text == NULL ||
        !valid_location(&call->call_site)) return 0;
    switch (call->resolution) {
    case CALL_RESOLVED:
        return valid_ref(call->callee) && call->candidate_count == 0;
    case CALL_UNRESOLVED:
        return call->callee == NULL && call->candidate_count == 0;
    case CALL_AMBIGUOUS:
        return call->callee == NULL && call->candidate_count >= 2 && call->candidates != NULL;
    default:
        return 0;
    }
}

static int valid_coverage(ChronosCoverage coverage)
{
    return (unsigned)coverage <= CHRONOS_UNAVAILABLE;
}

static int valid_source(const ContextSource *source)
{
    if (source == NULL) return 0;
    switch (source->status) {
    case CONTEXT_SOURCE_PRESENT:
        return valid_location(source->location) &&
               (source->bytes != NULL || source->byte_count == 0) &&
               source->byte_count ==
                   source->location->range.end_byte - source->location->range.start_byte;
    case CONTEXT_SOURCE_ABSENT:
    case CONTEXT_SOURCE_UNAVAILABLE:
        return source->location == NULL && source->bytes == NULL && source->byte_count == 0;
    default:
        return 0;
    }
}

static const char *page_kind_name(ContextPageKind kind)
{
    switch (kind) {
    case CONTEXT_PAGE_ROOT: return "root";
    case CONTEXT_PAGE_MODULE: return "module";
    case CONTEXT_PAGE_FILE: return "file";
    case CONTEXT_PAGE_SYMBOL: return "symbol";
    default: return NULL;
    }
}

static void write_revision(PageBuffer *buffer, const RevisionRef *revision)
{
    buffer_text(buffer, "{\"repositoryId\":");
    buffer_required_string(buffer, revision->repository_id);
    buffer_text(buffer, ",\"commitSha\":");
    buffer_required_string(buffer, revision->commit_sha);
    buffer_char(buffer, '}');
}

static void write_ref(PageBuffer *buffer, const SymbolVersionRef *ref)
{
    if (ref == NULL) {
        buffer_text(buffer, "null");
        return;
    }
    buffer_text(buffer, "{\"revision\":");
    write_revision(buffer, &ref->revision);
    buffer_text(buffer, ",\"id\":");
    buffer_required_string(buffer, ref->id);
    buffer_char(buffer, '}');
}

static void write_location(PageBuffer *buffer, const SourceLocation *location)
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

static void write_call(PageBuffer *buffer, const GraphCall *call)
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

static void write_diagnostic(PageBuffer *buffer, const ChronosDiagnostic *diagnostic)
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
    buffer_char(buffer, '}');
}

static void write_evidence(PageBuffer *buffer, const ContextEvidence *evidence)
{
    static const char *const kinds[] = {"call", "contains", "change", "source"};
    static const char *const states[] = {
        "selected", "omitted", "unresolved", "ambiguous", "unavailable"
    };
    buffer_text(buffer, "{\"id\":");
    buffer_required_string(buffer, evidence->id);
    buffer_text(buffer, ",\"kind\":");
    if ((unsigned)evidence->kind >= sizeof kinds / sizeof kinds[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, kinds[evidence->kind]);
    buffer_text(buffer, ",\"state\":");
    if ((unsigned)evidence->state >= sizeof states / sizeof states[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, states[evidence->state]);
    buffer_text(buffer, ",\"location\":");
    write_location(buffer, evidence->location);
    buffer_text(buffer, ",\"call\":");
    if (evidence->call == NULL) buffer_text(buffer, "null");
    else write_call(buffer, evidence->call);
    buffer_char(buffer, '}');
}

static void write_page_node(PageBuffer *buffer, const ContextPageNode *node)
{
    static const char *const kinds[] = {"project", "module", "file", "symbol"};
    static const char *const states[] = {
        "selected", "omitted", "unresolved", "ambiguous", "unavailable"
    };
    buffer_text(buffer, "{\"id\":");
    buffer_required_string(buffer, node->id);
    buffer_text(buffer, ",\"kind\":");
    if ((unsigned)node->kind >= sizeof kinds / sizeof kinds[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, kinds[node->kind]);
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
    if ((unsigned)node->state >= sizeof states / sizeof states[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, states[node->state]);
    buffer_text(buffer, ",\"childCount\":");
    buffer_integer(buffer, node->child_count);
    buffer_text(buffer, ",\"edgeCount\":");
    buffer_integer(buffer, node->edge_count);
    buffer_char(buffer, '}');
}

static void write_page_edge(PageBuffer *buffer, const ContextGraphEdge *edge)
{
    static const char *const kinds[] = {"call", "contains", "change"};
    static const char *const states[] = {
        "selected", "omitted", "unresolved", "ambiguous", "unavailable"
    };
    buffer_text(buffer, "{\"id\":");
    buffer_required_string(buffer, edge->id);
    buffer_text(buffer, ",\"from\":");
    buffer_required_string(buffer, edge->from);
    buffer_text(buffer, ",\"to\":");
    buffer_string(buffer, edge->to);
    buffer_text(buffer, ",\"kind\":");
    if ((unsigned)edge->kind >= sizeof kinds / sizeof kinds[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, kinds[edge->kind]);
    buffer_text(buffer, ",\"state\":");
    if ((unsigned)edge->state >= sizeof states / sizeof states[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, states[edge->state]);
    buffer_text(buffer, ",\"evidenceId\":");
    buffer_required_string(buffer, edge->evidence_id);
    buffer_text(buffer, ",\"call\":");
    if (edge->call == NULL) buffer_text(buffer, "null");
    else write_call(buffer, edge->call);
    buffer_char(buffer, '}');
}

static void begin_collection(PageBuffer *buffer, ChronosCoverage coverage,
                             size_t total, size_t next_offset)
{
    static const char *const names[] = {"complete", "incomplete", "unavailable"};
    buffer_text(buffer, "{\"status\":");
    if ((unsigned)coverage >= sizeof names / sizeof names[0]) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, names[coverage]);
    buffer_text(buffer, ",\"items\":");
    buffer_text(buffer, coverage == CHRONOS_UNAVAILABLE ? "null" : "[");
    buffer_text(buffer, ",\"total\":");
    buffer_integer(buffer, total);
    buffer_text(buffer, ",\"nextOffset\":");
    buffer_integer(buffer, next_offset);
}

static void end_collection(PageBuffer *buffer, ChronosCoverage coverage)
{
    buffer_text(buffer, coverage == CHRONOS_UNAVAILABLE ? "}" : "]}");
}

static int valid_evidence(const ContextEvidence *evidence)
{
    if (evidence == NULL || evidence->id == NULL ||
        (unsigned)evidence->kind > CONTEXT_EVIDENCE_SOURCE ||
        (unsigned)evidence->state > CONTEXT_RELATION_UNAVAILABLE) return 0;
    if (evidence->kind == CONTEXT_EVIDENCE_CALL)
        return valid_call(evidence->call) && valid_location(evidence->location);
    if (evidence->kind == CONTEXT_EVIDENCE_SOURCE)
        return evidence->call == NULL && valid_location(evidence->location);
    return evidence->call == NULL &&
           (evidence->location == NULL || valid_location(evidence->location));
}

static void write_page(PageBuffer *buffer, const ContextPage *page)
{
    ContextPageLimits limits = {0};
    (void)context_page_request_limits(&page->request, &limits);
    buffer_text(buffer, "{\"schemaVersion\":");
    buffer_integer(buffer, page->schema_version);
    buffer_text(buffer, ",\"page\":{\"kind\":");
    buffer_string(buffer, page_kind_name(page->request.kind));
    buffer_text(buffer, ",\"parentScope\":");
    buffer_string(buffer, page->request.parent_scope_id);
    buffer_text(buffer, ",\"nodeOffset\":");
    buffer_integer(buffer, page->request.node_offset);
    buffer_text(buffer, ",\"edgeOffset\":");
    buffer_integer(buffer, page->request.edge_offset);
    buffer_text(buffer, ",\"evidenceOffset\":");
    buffer_integer(buffer, page->request.evidence_offset);
    buffer_text(buffer, ",\"limits\":{\"maxNodes\":");
    buffer_integer(buffer, limits.max_nodes);
    buffer_text(buffer, ",\"maxEdges\":");
    buffer_integer(buffer, limits.max_edges);
    buffer_text(buffer, ",\"maxEvidence\":");
    buffer_integer(buffer, limits.max_evidence);
    buffer_text(buffer, "}},\"repositoryId\":");
    buffer_required_string(buffer, page->revision.repository_id);
    buffer_text(buffer, ",\"revision\":");
    write_revision(buffer, &page->revision);
    buffer_text(buffer, ",\"nodes\":");
    begin_collection(buffer, page->node_coverage, page->node_total,
                     page->node_next_offset);
    for (size_t i = 0; i < page->node_count && buffer->status >= 0; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        write_page_node(buffer, &page->nodes[i]);
    }
    end_collection(buffer, page->node_coverage);
    buffer_text(buffer, ",\"edges\":");
    begin_collection(buffer, page->edge_coverage, page->edge_total,
                     page->edge_next_offset);
    for (size_t i = 0; i < page->edge_count && buffer->status >= 0; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        write_page_edge(buffer, &page->edges[i]);
    }
    end_collection(buffer, page->edge_coverage);
    buffer_text(buffer, ",\"evidence\":");
    begin_collection(buffer, page->evidence_coverage, page->evidence_total,
                     page->evidence_next_offset);
    for (size_t i = 0; i < page->evidence_count && buffer->status >= 0; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        write_evidence(buffer, &page->evidence[i]);
    }
    end_collection(buffer, page->evidence_coverage);
    buffer_text(buffer, ",\"counts\":{\"children\":");
    buffer_integer(buffer, page->node_total);
    buffer_text(buffer, ",\"edges\":");
    buffer_integer(buffer, page->edge_total);
    buffer_text(buffer, "},\"diagnostics\":[");
    for (size_t i = 0; i < page->diagnostic_count && buffer->status >= 0; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        write_diagnostic(buffer, &page->diagnostics[i]);
    }
    buffer_text(buffer, "]}");
}

int context_page_write_json(const ContextPage *page, char *out, size_t out_size)
{
    ContextPageLimits limits = {0};
    if (page == NULL || (out == NULL && out_size != 0) ||
        page->schema_version != CHRONOS_PAGE_SCHEMA_VERSION ||
        !valid_revision(&page->revision) ||
        page_kind_name(page->request.kind) == NULL ||
        context_page_request_limits(&page->request, &limits) < 0 ||
        !valid_coverage(page->node_coverage) ||
        !valid_coverage(page->edge_coverage) ||
        !valid_coverage(page->evidence_coverage) ||
        (page->node_count != 0 && page->nodes == NULL) ||
        (page->edge_count != 0 && page->edges == NULL) ||
        (page->evidence_count != 0 && page->evidence == NULL) ||
        (page->diagnostic_count != 0 && page->diagnostics == NULL))
        return CHRONOS_INVALID_ARGUMENT;
    if (page->node_coverage == CHRONOS_UNAVAILABLE && page->node_count != 0)
        return CHRONOS_INVALID_ARGUMENT;
    if (page->edge_coverage == CHRONOS_UNAVAILABLE && page->edge_count != 0)
        return CHRONOS_INVALID_ARGUMENT;
    if (page->evidence_coverage == CHRONOS_UNAVAILABLE && page->evidence_count != 0)
        return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < page->evidence_count; ++i)
        if (!valid_evidence(&page->evidence[i])) return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < page->edge_count; ++i)
        if (page->edges[i].id == NULL || page->edges[i].evidence_id == NULL)
            return CHRONOS_INVALID_ARGUMENT;
    for (size_t i = 0; i < page->node_count; ++i)
        if (page->nodes[i].id == NULL || page->nodes[i].label == NULL)
            return CHRONOS_INVALID_ARGUMENT;

    PageBuffer buffer = {0};
    write_page(&buffer, page);
    return finish_json(&buffer, out, out_size);
}

int context_source_write_json(const ContextSource *source, char *out, size_t out_size)
{
    if (source == NULL || (out == NULL && out_size != 0) || !valid_source(source))
        return CHRONOS_INVALID_ARGUMENT;
    PageBuffer buffer = {0};
    buffer_text(&buffer, "{\"status\":");
    switch (source->status) {
    case CONTEXT_SOURCE_PRESENT:
        buffer_text(&buffer, "\"present\",\"location\":");
        write_location(&buffer, source->location);
        buffer_text(&buffer, ",\"source\":");
        buffer_source_bytes(&buffer, source->bytes, source->byte_count);
        break;
    case CONTEXT_SOURCE_ABSENT:
        buffer_text(&buffer, "\"absent\",\"location\":null,\"source\":null");
        break;
    case CONTEXT_SOURCE_UNAVAILABLE:
        buffer_text(&buffer, "\"unavailable\",\"location\":null,\"source\":null");
        break;
    default:
        buffer.status = CHRONOS_INVALID_ARGUMENT;
        break;
    }
    buffer_char(&buffer, '}');
    return finish_json(&buffer, out, out_size);
}
