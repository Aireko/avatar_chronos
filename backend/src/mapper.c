#include "mapper.h"
#include "mapper_internal.h"
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *name;
    const GraphSymbol *symbol;
} NameEntry;

struct MapperLookup {
    const RepositoryGraph *graph;
    NameEntry *refs;
    NameEntry *short_names;
    NameEntry *qualified_names;
    size_t callable_count;
};

static int compare_entries(const void *a, const void *b)
{
    const NameEntry *left = a;
    const NameEntry *right = b;
    int order = strcmp(left->name, right->name);
    if (order != 0) return order;
    return (left->symbol > right->symbol) - (left->symbol < right->symbol);
}

static size_t find_name(const NameEntry *entries, size_t count, const char *name)
{
    size_t first = 0;
    while (first < count) {
        size_t middle = first + (count - first) / 2;
        if (strcmp(entries[middle].name, name) < 0) first = middle + 1;
        else count = middle;
    }
    return first;
}

void mapper_lookup_free(MapperLookup *lookup)
{
    if (!lookup) return;
    free(lookup->refs);
    free(lookup->short_names);
    free(lookup->qualified_names);
    free(lookup);
}

int mapper_lookup_build(const RepositoryGraph *graph, MapperLookup **out)
{
    MapperLookup *lookup = calloc(1, sizeof *lookup);
    if (!lookup) return CHRONOS_OUT_OF_MEMORY;
    lookup->graph = graph;
    size_t count = graph->node_count;
    if (count) {
        lookup->refs = calloc(count, sizeof *lookup->refs);
        lookup->short_names = calloc(count, sizeof *lookup->short_names);
        lookup->qualified_names = calloc(count, sizeof *lookup->qualified_names);
        if (!lookup->refs || !lookup->short_names || !lookup->qualified_names) {
            mapper_lookup_free(lookup);
            return CHRONOS_OUT_OF_MEMORY;
        }
        for (size_t i = 0; i < count; ++i) {
            const GraphSymbol *node = &graph->nodes[i];
            lookup->refs[i] = (NameEntry){node->ref.id, node};
            if (node->kind != PARSER_CLASS && node->form == PARSER_DEFINITION) {
                size_t j = lookup->callable_count++;
                lookup->short_names[j] = (NameEntry){node->name, node};
                lookup->qualified_names[j] = (NameEntry){node->qualified_name, node};
            }
        }
        qsort(lookup->refs, count, sizeof *lookup->refs, compare_entries);
        qsort(lookup->short_names, lookup->callable_count, sizeof *lookup->short_names, compare_entries);
        qsort(lookup->qualified_names, lookup->callable_count, sizeof *lookup->qualified_names, compare_entries);
    }
    *out = lookup;
    return CHRONOS_OK;
}

const GraphSymbol *mapper_lookup_ref(const MapperLookup *lookup, const SymbolVersionRef *ref)
{
    if (!ref || !ref->id || !ref->revision.repository_id || !ref->revision.commit_sha ||
        strcmp(lookup->graph->revision.repository_id, ref->revision.repository_id) != 0 ||
        strcmp(lookup->graph->revision.commit_sha, ref->revision.commit_sha) != 0) return NULL;
    size_t i = find_name(lookup->refs, lookup->graph->node_count, ref->id);
    return i < lookup->graph->node_count && strcmp(lookup->refs[i].name, ref->id) == 0
               ? lookup->refs[i].symbol : NULL;
}

static int identifier_byte(unsigned char byte, int first)
{
    return (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
           byte == '_' || byte >= 0x80 || (!first && byte >= '0' && byte <= '9');
}

static int direct_name(const char *text)
{
    const unsigned char *p = (const unsigned char *)text;
    if (p[0] == ':' && p[1] == ':') p += 2;
    for (;;) {
        if (!identifier_byte(*p++, 1)) return 0;
        while (identifier_byte(*p, 0)) ++p;
        if (*p == '\0') return 1;
        if (p[0] != ':' || p[1] != ':') return 0;
        p += 2;
    }
}

int mapper_resolve_call(const MapperLookup *lookup, GraphCall *call, const GraphSymbol *caller)
{
    const char *name = call->callee_text;
    if (!direct_name(name)) return CHRONOS_OK;
    int absolute = name[0] == ':' && name[1] == ':';
    if (absolute) name += 2;
    const NameEntry *names = absolute || strstr(name, "::") ? lookup->qualified_names
                                                           : lookup->short_names;
    size_t first = find_name(names, lookup->callable_count, name);
    size_t last = first;
    size_t count = 0;
    const GraphSymbol *target = NULL;
    while (last < lookup->callable_count && strcmp(names[last].name, name) == 0) {
        const GraphSymbol *node = names[last++].symbol;
        if (strcmp(caller->language, node->language) == 0) {
            ++count;
            target = node;
        }
    }
    /* A unique indexed candidate is usable even with partial inventory.
     * The graph reports incomplete edge coverage in that case. */
    if (count == 1) {
        call->resolution = CALL_RESOLVED;
        call->callee = &target->ref;
    } else if (count > 1) {
        SymbolVersionRef *candidates = calloc(count, sizeof *candidates);
        if (!candidates) return CHRONOS_OUT_OF_MEMORY;
        call->resolution = CALL_AMBIGUOUS;
        call->candidates = candidates;
        call->candidate_count = count;
        size_t next = 0;
        for (size_t i = first; i < last; ++i) {
            if (strcmp(caller->language, names[i].symbol->language) == 0)
                candidates[next++] = names[i].symbol->ref;
        }
    }
    return CHRONOS_OK;
}

typedef struct {
    char *output;
    size_t length;
    int status;
} JsonWriter;

static void write_bytes(JsonWriter *writer, const char *bytes, size_t length)
{
    if (writer->status < 0) {
        return;
    }
    if (length > (size_t)INT_MAX - writer->length) {
        writer->status = CHRONOS_TOO_LARGE;
        return;
    }
    if (writer->output != NULL) {
        memcpy(writer->output + writer->length, bytes, length);
    }
    writer->length += length;
}

static void write_text(JsonWriter *writer, const char *text)
{
    write_bytes(writer, text, strlen(text));
}

static void write_string(JsonWriter *writer, const char *value)
{
    static const char hex[] = "0123456789abcdef";
    const unsigned char *cursor = (const unsigned char *)value;

    if (value == NULL) {
        write_text(writer, "null");
        return;
    }

    write_text(writer, "\"");
    const unsigned char *end = cursor + strlen(value);
    while (cursor < end && writer->status >= 0) {
        const unsigned char *start = cursor;
        while (cursor < end && *cursor >= 0x20 && *cursor != '"' && *cursor != '\\') {
            ++cursor;
        }
        write_bytes(writer, (const char *)start, (size_t)(cursor - start));
        if (cursor == end) break;
        switch (*cursor) {
        case '"': write_text(writer, "\\\""); break;
        case '\\': write_text(writer, "\\\\"); break;
        case '\b': write_text(writer, "\\b"); break;
        case '\f': write_text(writer, "\\f"); break;
        case '\n': write_text(writer, "\\n"); break;
        case '\r': write_text(writer, "\\r"); break;
        case '\t': write_text(writer, "\\t"); break;
        default: {
            char escape[] = {'\\', 'u', '0', '0', hex[*cursor >> 4], hex[*cursor & 15]};
            write_bytes(writer, escape, sizeof escape);
            break;
        }
        }
        ++cursor;
    }
    write_text(writer, "\"");
}

static void write_integer(JsonWriter *writer, size_t value)
{
    char digits[sizeof(size_t) * CHAR_BIT + 1];

    if ((uintmax_t)value > UINTMAX_C(9007199254740991)) {
        writer->status = CHRONOS_TOO_LARGE;
        return;
    }
    (void)snprintf(digits, sizeof digits, "%zu", value);
    write_text(writer, digits);
}

static void write_required_string(JsonWriter *writer, const char *value)
{
    if (value == NULL) {
        writer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    write_string(writer, value);
}

static void write_enum(JsonWriter *writer, unsigned int value, size_t count,
                       const char *const *names)
{
    if (value >= count) {
        writer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    write_string(writer, names[value]);
}

static void write_revision(JsonWriter *writer, const RevisionRef *revision)
{
    write_text(writer, "{\"repositoryId\":");
    write_required_string(writer, revision->repository_id);
    write_text(writer, ",\"commitSha\":");
    write_required_string(writer, revision->commit_sha);
    write_text(writer, "}");
}

static void write_ref(JsonWriter *writer, const SymbolVersionRef *ref)
{
    if (ref == NULL) {
        write_text(writer, "null");
        return;
    }
    write_text(writer, "{\"revision\":");
    write_revision(writer, &ref->revision);
    write_text(writer, ",\"id\":");
    write_required_string(writer, ref->id);
    write_text(writer, "}");
}

static void write_location(JsonWriter *writer, const SourceLocation *location)
{
    const SourceRange *range;

    if (location == NULL) {
        write_text(writer, "null");
        return;
    }
    range = &location->range;
    if (range->start_byte > range->end_byte || range->start_line == 0 ||
        range->start_line > range->end_line ||
        (range->start_byte == range->end_byte && range->start_line != range->end_line)) {
        writer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    write_text(writer, "{\"revision\":");
    write_revision(writer, &location->revision);
    write_text(writer, ",\"filePath\":");
    write_required_string(writer, location->file_path);
    write_text(writer, ",\"range\":{\"startByte\":");
    write_integer(writer, range->start_byte);
    write_text(writer, ",\"endByte\":");
    write_integer(writer, range->end_byte);
    write_text(writer, ",\"startLine\":");
    write_integer(writer, range->start_line);
    write_text(writer, ",\"endLine\":");
    write_integer(writer, range->end_line);
    write_text(writer, "}}");
}

static void write_symbol(JsonWriter *writer, const GraphSymbol *symbol)
{
    static const char *const kinds[] = {"function", "class", "method"};
    static const char *const forms[] = {"declaration", "definition"};
    static const char *const changes[] = {"added", "modified", "deleted", "unchanged"};

    write_text(writer, "{\"ref\":");
    write_ref(writer, &symbol->ref);
    write_text(writer, ",\"logicalId\":");
    write_string(writer, symbol->logical_id);
    write_text(writer, ",\"name\":");
    write_required_string(writer, symbol->name);
    write_text(writer, ",\"qualifiedName\":");
    write_required_string(writer, symbol->qualified_name);
    write_text(writer, ",\"signature\":");
    write_string(writer, symbol->signature);
    write_text(writer, ",\"language\":");
    write_required_string(writer, symbol->language);
    write_text(writer, ",\"kind\":");
    write_enum(writer, symbol->kind, sizeof kinds / sizeof kinds[0], kinds);
    write_text(writer, ",\"form\":");
    write_enum(writer, symbol->form, sizeof forms / sizeof forms[0], forms);
    write_text(writer, ",\"parent\":");
    write_ref(writer, symbol->parent);
    write_text(writer, ",\"location\":");
    write_location(writer, &symbol->location);
    write_text(writer, ",\"sourceSha256\":");
    write_string(writer, symbol->source_sha256);
    write_text(writer, ",\"change\":");
    if (symbol->change == NULL) {
        write_text(writer, "null");
    } else {
        write_enum(writer, *symbol->change, sizeof changes / sizeof changes[0], changes);
    }
    write_text(writer, "}");
}

static void write_call(JsonWriter *writer, const GraphCall *call)
{
    static const char *const resolutions[] = {"resolved", "unresolved", "ambiguous"};

    if ((call->resolution == CALL_RESOLVED) != (call->callee != NULL) ||
        (call->resolution == CALL_AMBIGUOUS
            ? call->candidate_count < 2 || call->candidates == NULL
            : call->candidate_count != 0)) {
        writer->status = CHRONOS_INVALID_ARGUMENT;
        return;
    }
    write_text(writer, "{\"caller\":");
    write_ref(writer, &call->caller);
    write_text(writer, ",\"calleeText\":");
    write_required_string(writer, call->callee_text);
    write_text(writer, ",\"callSite\":");
    write_location(writer, &call->call_site);
    write_text(writer, ",\"resolution\":");
    write_enum(writer, call->resolution, sizeof resolutions / sizeof resolutions[0], resolutions);
    write_text(writer, ",\"callee\":");
    write_ref(writer, call->callee);
    write_text(writer, ",\"candidates\":[");
    for (size_t i = 0; i < call->candidate_count && writer->status >= 0; ++i) {
        if (i != 0) {
            write_text(writer, ",");
        }
        write_ref(writer, &call->candidates[i]);
    }
    write_text(writer, "]}");
}

static void write_diagnostic(JsonWriter *writer, const ChronosDiagnostic *diagnostic)
{
    static const char *const severities[] = {"info", "warning", "error"};

    write_text(writer, "{\"code\":");
    write_required_string(writer, diagnostic->code);
    write_text(writer, ",\"severity\":");
    write_enum(writer, diagnostic->severity, sizeof severities / sizeof severities[0], severities);
    write_text(writer, ",\"message\":");
    write_required_string(writer, diagnostic->message);
    write_text(writer, ",\"location\":");
    write_location(writer, diagnostic->location);
    write_text(writer, "}");
}

static void begin_collection(JsonWriter *writer, ChronosCoverage coverage)
{
    static const char *const names[] = {"complete", "incomplete", "unavailable"};

    write_text(writer, "{\"status\":");
    write_enum(writer, coverage, sizeof names / sizeof names[0], names);
    write_text(writer, coverage == CHRONOS_UNAVAILABLE ? ",\"items\":null" : ",\"items\":[");
}

static void end_collection(JsonWriter *writer, ChronosCoverage coverage)
{
    write_text(writer, coverage == CHRONOS_UNAVAILABLE ? "}" : "]}");
}

static void write_graph(JsonWriter *writer, const RepositoryGraph *graph)
{
    write_text(writer, "{\"schemaVersion\":");
    write_integer(writer, CHRONOS_GRAPH_SCHEMA_VERSION);
    write_text(writer, ",\"repositoryId\":");
    write_required_string(writer, graph->revision.repository_id);
    write_text(writer, ",\"revision\":");
    write_revision(writer, &graph->revision);
    write_text(writer, ",\"comparison\":");
    if (graph->comparison == NULL) {
        write_text(writer, "null");
    } else {
        write_text(writer, "{\"base\":");
        write_revision(writer, &graph->comparison->base);
        write_text(writer, ",\"head\":");
        write_revision(writer, &graph->comparison->head);
        write_text(writer, "}");
    }

    write_text(writer, ",\"nodes\":");
    begin_collection(writer, graph->node_coverage);
    for (size_t i = 0; i < graph->node_count && writer->status >= 0; ++i) {
        if (i != 0) {
            write_text(writer, ",");
        }
        write_symbol(writer, &graph->nodes[i]);
    }
    end_collection(writer, graph->node_coverage);

    write_text(writer, ",\"edges\":");
    begin_collection(writer, graph->edge_coverage);
    for (size_t i = 0; i < graph->edge_count && writer->status >= 0; ++i) {
        if (i != 0) {
            write_text(writer, ",");
        }
        write_call(writer, &graph->edges[i]);
    }
    end_collection(writer, graph->edge_coverage);

    write_text(writer, ",\"diagnostics\":[");
    for (size_t i = 0; i < graph->diagnostic_count && writer->status >= 0; ++i) {
        if (i != 0) {
            write_text(writer, ",");
        }
        write_diagnostic(writer, &graph->diagnostics[i]);
    }
    write_text(writer, "]}");
}

int graph_write_json(const RepositoryGraph *graph, char *out, size_t out_size)
{
    JsonWriter writer = {0};

    if (graph == NULL || (out == NULL && out_size != 0) ||
        (graph->node_count != 0 && (graph->nodes == NULL || graph->node_coverage == CHRONOS_UNAVAILABLE)) ||
        (graph->edge_count != 0 && (graph->edges == NULL || graph->edge_coverage == CHRONOS_UNAVAILABLE)) ||
        (graph->diagnostic_count != 0 && graph->diagnostics == NULL)) {
        return CHRONOS_INVALID_ARGUMENT;
    }
    write_graph(&writer, graph);
    if (writer.status < 0) {
        return writer.status;
    }
    if (out_size > writer.length) {
        writer.output = out;
        writer.length = 0;
        write_graph(&writer, graph);
        out[writer.length] = '\0';
    }
    return (int)writer.length;
}
```