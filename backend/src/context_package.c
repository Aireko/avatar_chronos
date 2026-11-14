#include "context_package.h"

#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
    int status;
} PackageBuffer;

static int buffer_reserve(PackageBuffer *buffer, size_t extra)
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

static void buffer_bytes(PackageBuffer *buffer, const char *bytes, size_t length)
{
    if (!buffer_reserve(buffer, length)) return;
    memcpy(buffer->data + buffer->length, bytes, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
}

static void buffer_text(PackageBuffer *buffer, const char *text)
{
    buffer_bytes(buffer, text, strlen(text));
}

static void buffer_char(PackageBuffer *buffer, char value)
{
    buffer_bytes(buffer, &value, 1);
}

static void buffer_integer(PackageBuffer *buffer, size_t value)
{
    char digits[sizeof(size_t) * CHAR_BIT + 1];
    if ((uintmax_t)value > UINTMAX_C(9007199254740991)) {
        buffer->status = CHRONOS_TOO_LARGE;
        return;
    }
    (void)snprintf(digits, sizeof digits, "%zu", value);
    buffer_text(buffer, digits);
}

static void buffer_double(PackageBuffer *buffer, double value)
{
    if (!isfinite(value) || value < 0.0 || value > 1.0) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    char digits[64];
    (void)snprintf(digits, sizeof digits, "%.6f", value);
    buffer_text(buffer, digits);
}

static void buffer_string(PackageBuffer *buffer, const char *value)
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

static void buffer_required_string(PackageBuffer *buffer, const char *value)
{
    if (value == NULL) {
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    buffer_string(buffer, value);
}

static void buffer_source_bytes(PackageBuffer *buffer, const char *bytes, size_t length)
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

static int finish_json(PackageBuffer *buffer, char *out, size_t out_size)
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
    for (const char *p = sha; *p; ++p) {
        if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return 0;
    }
    return 1;
}

static int valid_revision(const RevisionRef *revision)
{
    return revision != NULL && revision->repository_id != NULL &&
           *revision->repository_id != '\0' && valid_commit_sha(revision->commit_sha);
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
        *call->callee_text == '\0' || !valid_location(&call->call_site)) return 0;
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

static int valid_diagnostic(const ChronosDiagnostic *item)
{
    return item != NULL && item->code != NULL && item->message != NULL &&
           (unsigned)item->severity <= DIAGNOSTIC_ERROR &&
           (item->location == NULL || valid_location(item->location));
}

static int valid_coverage(ChronosCoverage coverage)
{
    return (unsigned)coverage <= CHRONOS_UNAVAILABLE;
}

static int valid_comparison(const GraphComparison *comparison, const RevisionRef *target)
{
    if (comparison == NULL) return 1;
    return valid_revision(&comparison->base) && valid_revision(&comparison->head) &&
           strcmp(comparison->base.repository_id, comparison->head.repository_id) == 0 &&
           (same_revision(target, &comparison->base) ||
            same_revision(target, &comparison->head));
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

static int valid_candidate(const ContextCandidate *candidate)
{
    if (candidate == NULL || candidate->id == NULL || *candidate->id == '\0' ||
        !valid_call(candidate->call) || !valid_source(&candidate->snippet)) return 0;
    switch (candidate->direction) {
    case CONTEXT_INCOMING_CALL:
        return candidate->call->resolution == CALL_RESOLVED;
    case CONTEXT_OUTGOING_CALL:
        return 1;
    default:
        return 0;
    }
}

static int valid_review_context(const ReviewContext *context)
{
    if (context == NULL || !valid_ref(&context->target) ||
        !valid_comparison(context->comparison, &context->target.revision) ||
        !valid_source(&context->previous) || !valid_source(&context->current) ||
        !valid_coverage(context->evidence.coverage) ||
        (context->evidence.coverage == CHRONOS_UNAVAILABLE &&
         (context->evidence.selected != NULL || context->evidence.selected_count != 0 ||
          context->evidence.omitted_ids != NULL || context->evidence.omitted_count != 0)) ||
        (context->evidence.selected_count != 0 && context->evidence.selected == NULL) ||
        (context->evidence.omitted_count != 0 && context->evidence.omitted_ids == NULL) ||
        (context->diagnostic_count != 0 && context->diagnostics == NULL))
        return 0;
    if (context->comparison == NULL) {
        if (context->previous.status != CONTEXT_SOURCE_UNAVAILABLE) return 0;
        if (context->current.status == CONTEXT_SOURCE_PRESENT &&
            !same_revision(&context->current.location->revision, &context->target.revision))
            return 0;
    } else {
        if (context->previous.status == CONTEXT_SOURCE_PRESENT &&
            !same_revision(&context->previous.location->revision, &context->comparison->base))
            return 0;
        if (context->current.status == CONTEXT_SOURCE_PRESENT &&
            !same_revision(&context->current.location->revision, &context->comparison->head))
            return 0;
    }
    for (size_t i = 0; i < context->evidence.selected_count; ++i) {
        const ContextRankedItem *item = &context->evidence.selected[i];
        if (!valid_candidate(item->candidate) || !isfinite(item->relevance) ||
            item->relevance < 0.0 || item->relevance > 1.0) return 0;
    }
    for (size_t i = 0; i < context->evidence.omitted_count; ++i)
        if (context->evidence.omitted_ids[i] == NULL ||
            *context->evidence.omitted_ids[i] == '\0') return 0;
    for (size_t i = 0; i < context->diagnostic_count; ++i)
        if (!valid_diagnostic(&context->diagnostics[i])) return 0;
    return 1;
}

static void write_revision(PackageBuffer *buffer, const RevisionRef *revision)
{
    buffer_text(buffer, "{\"repositoryId\":");
    buffer_required_string(buffer, revision->repository_id);
    buffer_text(buffer, ",\"commitSha\":");
    buffer_required_string(buffer, revision->commit_sha);
    buffer_text(buffer, "}");
}

static void write_ref(PackageBuffer *buffer, const SymbolVersionRef *ref)
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

static void write_location(PackageBuffer *buffer, const SourceLocation *location)
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

static void write_call(PackageBuffer *buffer, const GraphCall *call)
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

static void write_diagnostic(PackageBuffer *buffer, const ChronosDiagnostic *diagnostic)
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

static void write_source(PackageBuffer *buffer, const ContextSource *source)
{
    buffer_text(buffer, "{\"status\":");
    switch (source->status) {
    case CONTEXT_SOURCE_PRESENT:
        buffer_text(buffer, "\"present\",\"location\":");
        write_location(buffer, source->location);
        buffer_text(buffer, ",\"source\":");
        buffer_source_bytes(buffer, source->bytes, source->byte_count);
        break;
    case CONTEXT_SOURCE_ABSENT:
        buffer_text(buffer, "\"absent\",\"location\":null,\"source\":null");
        break;
    case CONTEXT_SOURCE_UNAVAILABLE:
        buffer_text(buffer, "\"unavailable\",\"location\":null,\"source\":null");
        break;
    default:
        buffer->status = CHRONOS_INVALID_ARGUMENT;
        break;
    }
    buffer_text(buffer, "}");
}

static void begin_collection(PackageBuffer *buffer, ChronosCoverage coverage)
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

static void end_collection(PackageBuffer *buffer, ChronosCoverage coverage)
{
    buffer_text(buffer, coverage == CHRONOS_UNAVAILABLE ? "}" : "]}");
}

static void write_review_context(PackageBuffer *buffer, const ReviewContext *context)
{
    buffer_text(buffer, "{\"schemaVersion\":");
    buffer_integer(buffer, CHRONOS_CONTEXT_SCHEMA_VERSION);
    buffer_text(buffer, ",\"target\":");
    write_ref(buffer, &context->target);
    buffer_text(buffer, ",\"comparison\":");
    if (context->comparison == NULL) {
        buffer_text(buffer, "null");
    } else {
        buffer_text(buffer, "{\"base\":");
        write_revision(buffer, &context->comparison->base);
        buffer_text(buffer, ",\"head\":");
        write_revision(buffer, &context->comparison->head);
        buffer_text(buffer, "}");
    }
    buffer_text(buffer, ",\"previous\":");
    write_source(buffer, &context->previous);
    buffer_text(buffer, ",\"current\":");
    write_source(buffer, &context->current);
    buffer_text(buffer, ",\"evidence\":");
    begin_collection(buffer, context->evidence.coverage);
    for (size_t i = 0; i < context->evidence.selected_count && buffer->status >= 0; ++i) {
        const ContextCandidate *candidate = context->evidence.selected[i].candidate;
        if (i != 0) buffer_char(buffer, ',');
        buffer_text(buffer, "{\"id\":");
        buffer_required_string(buffer, candidate->id);
        buffer_text(buffer, ",\"direction\":");
        buffer_string(buffer, candidate->direction == CONTEXT_INCOMING_CALL
                                  ? "incoming" : "outgoing");
        buffer_text(buffer, ",\"call\":");
        write_call(buffer, candidate->call);
        buffer_text(buffer, ",\"snippet\":");
        write_source(buffer, &candidate->snippet);
        buffer_text(buffer, ",\"relevance\":");
        buffer_double(buffer, context->evidence.selected[i].relevance);
        buffer_char(buffer, '}');
    }
    end_collection(buffer, context->evidence.coverage);
    buffer_text(buffer, ",\"budget\":{\"maxItems\":");
    buffer_integer(buffer, context->budget.max_items);
    buffer_text(buffer, ",\"maxSourceBytes\":");
    buffer_integer(buffer, context->budget.max_source_bytes);
    buffer_text(buffer, ",\"usedItems\":");
    buffer_integer(buffer, context->evidence.selected_count);
    buffer_text(buffer, ",\"usedSourceBytes\":");
    buffer_integer(buffer, context->evidence.used_source_bytes);
    buffer_text(buffer, "},\"omittedEvidenceIds\":[");
    for (size_t i = 0; i < context->evidence.omitted_count; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        buffer_required_string(buffer, context->evidence.omitted_ids[i]);
    }
    buffer_text(buffer, "],\"diagnostics\":[");
    for (size_t i = 0; i < context->diagnostic_count && buffer->status >= 0; ++i) {
        if (i != 0) buffer_char(buffer, ',');
        write_diagnostic(buffer, &context->diagnostics[i]);
    }
    buffer_text(buffer, "]}");
}

int context_write_json(const ReviewContext *context, char *out, size_t out_size)
{
    if (!valid_review_context(context) || (out == NULL && out_size != 0))
        return CHRONOS_INVALID_ARGUMENT;
    PackageBuffer buffer = {0};
    write_review_context(&buffer, context);
    return finish_json(&buffer, out, out_size);
}
