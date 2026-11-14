#include "index.h"
#include "index_internal.h"
#include "context_compiler.h"
#include "mapper_internal.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const unsigned char *bytes;
    size_t byte_count;
    size_t scope;
    size_t first_symbol;
    size_t symbol_count;
} IndexedFile;

struct RepositoryIndex {
    RepositoryGraph graph;
    MapperLookup *lookup;
    IndexScope *scopes;
    size_t scope_count;
    size_t scope_capacity;
    IndexedFile *files;
    size_t file_count;
    ChronosCoverage file_coverage;
    IndexCoverage coverage;
    int coverage_known;
    size_t *symbol_scopes;
    IndexCallLink *links;
    size_t *outgoing_offsets;
    size_t *incoming_offsets;
    size_t *outgoing;
    size_t *incoming;
};

static void *array_new(size_t count, size_t size)
{
    return count != 0 && count <= SIZE_MAX / size ? calloc(count, size) : NULL;
}

static int copy_text(const char **out, const char *text)
{
    if (text != NULL) {
        size_t size = strlen(text) + 1;
        char *copy = malloc(size);
        if (copy == NULL) return 0;
        memcpy(copy, text, size);
        *out = copy;
    }
    return 1;
}

static int same_text(const char *left, const char *right)
{
    return left != NULL && right != NULL && strcmp(left, right) == 0;
}

static int valid_revision(const RevisionRef *ref)
{
    return ref != NULL && ref->repository_id != NULL && *ref->repository_id != '\0' &&
           ref->commit_sha != NULL && *ref->commit_sha != '\0';
}

static int same_revision(const RevisionRef *left, const RevisionRef *right)
{
    return same_text(left->repository_id, right->repository_id) &&
           same_text(left->commit_sha, right->commit_sha);
}

static int copy_revision(RevisionRef *out, const RevisionRef *ref)
{
    return copy_text(&out->repository_id, ref->repository_id) &&
           copy_text(&out->commit_sha, ref->commit_sha);
}

static void free_revision(RevisionRef ref)
{
    free((void *)ref.repository_id);
    free((void *)ref.commit_sha);
}

static void free_diagnostics(const ChronosDiagnostic *items, size_t count)
{
    for (size_t i = 0; i < count; ++i) {
        free((void *)items[i].code);
        free((void *)items[i].message);
        if (items[i].location != NULL) {
            free_revision(items[i].location->revision);
            free((void *)items[i].location->file_path);
            free((void *)items[i].location);
        }
    }
    free((void *)items);
}

static int copy_diagnostic(ChronosDiagnostic *out, const ChronosDiagnostic *source)
{
    out->severity = source->severity;
    if (!copy_text(&out->code, source->code) || !copy_text(&out->message, source->message)) return 0;
    if (source->location != NULL) {
        SourceLocation *location = calloc(1, sizeof *location);
        if (location == NULL) return 0;
        out->location = location;
        location->range = source->location->range;
        return copy_revision(&location->revision, &source->location->revision) &&
               copy_text(&location->file_path, source->location->file_path);
    }
    return 1;
}

static int valid_range(SourceRange range)
{
    return range.start_byte <= range.end_byte && range.start_line != 0 &&
           range.start_line <= range.end_line &&
           (range.start_byte != range.end_byte || range.start_line == range.end_line) &&
           (uintmax_t)range.end_byte <= UINTMAX_C(9007199254740991) &&
           (uintmax_t)range.end_line <= UINTMAX_C(9007199254740991);
}

static int valid_diagnostic(const ChronosDiagnostic *item)
{
    return item->code != NULL && item->message != NULL &&
           (unsigned)item->severity <= DIAGNOSTIC_ERROR &&
           (item->location == NULL ||
            (valid_revision(&item->location->revision) && item->location->file_path != NULL &&
             valid_range(item->location->range)));
}

void index_graph_free(RepositoryGraph *graph)
{
    if (graph == NULL) return;
    for (size_t i = 0; i < graph->node_count; ++i) {
        const GraphSymbol *node = &graph->nodes[i];
        free((void *)node->ref.id);
        free((void *)node->logical_id);
        free((void *)node->name);
        free((void *)node->qualified_name);
        free((void *)node->signature);
        free((void *)node->language);
        free((void *)node->location.file_path);
        free((void *)node->source_sha256);
        free((void *)node->change);
    }
    for (size_t i = 0; i < graph->edge_count; ++i) {
        free((void *)graph->edges[i].callee_text);
        free((void *)graph->edges[i].candidates);
    }
    free((void *)graph->nodes);
    free((void *)graph->edges);
    if (graph->comparison) {
        free_revision(graph->comparison->base);
        free_revision(graph->comparison->head);
        free((void *)graph->comparison);
    }
    free_diagnostics(graph->diagnostics, graph->diagnostic_count);
    free_revision(graph->revision);
    *graph = (RepositoryGraph){0};
}

void index_free(RepositoryIndex *index)
{
    if (index == NULL) return;
    for (size_t i = 0; i < index->scope_count; ++i)
        if (index->scopes[i].kind != INDEX_SYMBOL) free((void *)index->scopes[i].path);
    for (size_t i = 0; i < index->file_count; ++i) free((void *)index->files[i].bytes);
    free(index->scopes);
    free(index->files);
    free(index->symbol_scopes);
    free(index->links);
    free(index->outgoing_offsets);
    free(index->incoming_offsets);
    free(index->outgoing);
    free(index->incoming);
    mapper_lookup_free(index->lookup);
    index_graph_free(&index->graph);
    free(index);
}

static int valid_coverage(ChronosCoverage coverage)
{
    return (unsigned)coverage <= CHRONOS_UNAVAILABLE;
}

static int valid_file(const RevisionRef *revision, const IndexFileInput *input)
{
    const ParsedFile *file = input->parsed;
    const GitBlob *blob = input->blob;
    if (file && file->import_count && !file->imports) return 0;
    if (file) {
        for (size_t i = 0; i < file->import_count; ++i)
            if (!file->imports[i].name || !*file->imports[i].name) return 0;
    }
    if (file == NULL || !same_revision(revision, &file->revision) ||
        file->file_path == NULL || *file->file_path == '\0' || file->language == NULL ||
        !valid_coverage(file->coverage) ||
        (file->coverage == CHRONOS_UNAVAILABLE && (file->symbol_count || file->call_count)) ||
        (file->symbol_count && file->symbols == NULL) ||
        (file->call_count && file->calls == NULL) ||
        (file->diagnostic_count && file->diagnostics == NULL)) return 0;
    return blob == NULL ||
           (same_revision(revision, &blob->revision) && same_text(file->file_path, blob->file_path) &&
            blob->byte_count == file->source_length && (blob->byte_count == 0 || blob->bytes != NULL));
}

/* Encode the same string escapes as JSON.stringify to keep IDs portable. */
static char *quote(char *out, const char *text)
{
    static const char hex[] = "0123456789abcdef";
    *out++ = '"';
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
        switch (*p) {
        case '"': case '\\': *out++ = '\\'; *out++ = (char)*p; break;
        case '\b': *out++ = '\\'; *out++ = 'b'; break;
        case '\f': *out++ = '\\'; *out++ = 'f'; break;
        case '\n': *out++ = '\\'; *out++ = 'n'; break;
        case '\r': *out++ = '\\'; *out++ = 'r'; break;
        case '\t': *out++ = '\\'; *out++ = 't'; break;
        default:
            if (*p < 0x20) {
                memcpy(out, "\\u00", 4);
                out += 4;
                *out++ = hex[*p >> 4];
                *out++ = hex[*p & 15];
            } else {
                *out++ = (char)*p;
            }
        }
    }
    *out++ = '"';
    return out;
}

static char *symbol_id(const char *path, const ParsedSymbol *symbol, int logical)
{
    static const char *const kinds[] = {"function", "class", "method"};
    static const char *const forms[] = {"declaration", "definition"};
    size_t path_len = strlen(path);
    size_t name_len = strlen(symbol->qualified_name);
    size_t suffix = 64 + 6 * sizeof(size_t);
    size_t max_text = (SIZE_MAX - suffix) / 6;
    if (path_len > max_text || name_len > max_text - path_len) return NULL;
    size_t capacity = 6 * (path_len + name_len) + suffix;
    char *id = malloc(capacity);
    if (id == NULL) return NULL;

    char *p = id;
    *p++ = '[';
    p = quote(p, path);
    *p++ = ',';
    p = quote(p, symbol->qualified_name);
    if (logical) {
        *p++ = ']';
        *p = '\0';
    } else {
        (void)snprintf(p, capacity - (size_t)(p - id), ",\"%s\",\"%s\",%zu,%zu]",
                       kinds[symbol->kind], forms[symbol->form],
                       symbol->range.start_byte, symbol->range.end_byte);
    }
    return id;
}

static int same_key(const GraphSymbol *left, const GraphSymbol *right)
{
    return same_text(left->location.file_path, right->location.file_path) &&
           same_text(left->qualified_name, right->qualified_name);
}

static int same_tuple(const GraphSymbol *node, const ParsedSymbol *symbol)
{
    return node->kind == symbol->kind && node->form == symbol->form &&
           node->location.range.start_byte == symbol->range.start_byte &&
           node->location.range.end_byte == symbol->range.end_byte &&
           same_text(node->qualified_name, symbol->qualified_name);
}

static size_t find_local(const ParsedFile *file, ParserSymbolId id)
{
    for (size_t i = 0; i < file->symbol_count; ++i) {
        if (file->symbols[i].id == id) return i;
    }
    return SIZE_MAX;
}

static int populate_nodes(RepositoryGraph *graph, GraphSymbol *nodes, const ParsedFile *file,
                          size_t *local_nodes, ChronosCoverage *coverage)
{
    size_t first = graph->node_count;
    for (size_t i = 0; i < file->symbol_count; ++i) {
        const ParsedSymbol *symbol = &file->symbols[i];
        if (symbol->id == 0 || find_local(file, symbol->id) != i ||
            symbol->name == NULL || symbol->qualified_name == NULL ||
            (unsigned)symbol->kind > PARSER_METHOD || (unsigned)symbol->form > PARSER_DEFINITION ||
            !valid_range(symbol->range) || symbol->range.end_byte > file->source_length) {
            return CHRONOS_INVALID_ARGUMENT;
        }

        size_t j = first;
        while (j < graph->node_count && !same_tuple(&nodes[j], symbol)) ++j;
        local_nodes[i] = j;
        if (j < graph->node_count) continue;

        GraphSymbol *node = &nodes[graph->node_count++];
        node->ref.revision = graph->revision;
        node->ref.id = symbol_id(file->file_path, symbol, 0);
        node->location.revision = graph->revision;
        node->location.range = symbol->range;
        node->kind = symbol->kind;
        node->form = symbol->form;
        if (node->ref.id == NULL || !copy_text(&node->name, symbol->name) ||
            !copy_text(&node->qualified_name, symbol->qualified_name) ||
            !copy_text(&node->signature, symbol->signature) ||
            !copy_text(&node->language, file->language) ||
            !copy_text(&node->location.file_path, file->file_path)) return CHRONOS_OUT_OF_MEMORY;
    }

    for (size_t i = 0; i < file->symbol_count; ++i) {
        const ParsedSymbol *symbol = &file->symbols[i];
        GraphSymbol *node = &nodes[local_nodes[i]];
        if (symbol->parent_id == 0) continue;
        size_t parent = find_local(file, symbol->parent_id);
        if (parent == SIZE_MAX) {
            if (file->coverage == CHRONOS_COMPLETE) return CHRONOS_INVALID_ARGUMENT;
            *coverage = CHRONOS_INCOMPLETE;
            continue;
        }
        const SymbolVersionRef *ref = &nodes[local_nodes[parent]].ref;
        if (ref == &node->ref || (node->parent != NULL && node->parent != ref)) {
            return CHRONOS_INVALID_ARGUMENT;
        }
        node->parent = ref;
    }

    if (file->coverage == CHRONOS_COMPLETE) {
        for (size_t i = first; i < graph->node_count; ++i) {
            size_t same = 0;
            for (size_t j = first; j < graph->node_count; ++j) {
                if (same_key(&nodes[i], &nodes[j])) ++same;
            }
            if (same != 1) continue;

            /* Names and ranges are the only fields used to build a logical ID. */
            ParsedSymbol key = {.qualified_name = nodes[i].qualified_name};
            nodes[i].logical_id = symbol_id(file->file_path, &key, 1);
            if (nodes[i].logical_id == NULL) return CHRONOS_OUT_OF_MEMORY;
        }
    }
    return CHRONOS_OK;
}

static int populate_calls(RepositoryGraph *graph, GraphCall *edges, const ParsedFile *file,
                          const size_t *local_nodes, const MapperLookup *lookup)
{
    for (size_t i = 0; i < file->call_count; ++i) {
        const ParsedCall *call = &file->calls[i];
        if (call->callee_text == NULL || !valid_range(call->range) ||
            call->range.end_byte > file->source_length) return CHRONOS_INVALID_ARGUMENT;
        if (call->enclosing_symbol_id == 0) continue;
        size_t local = find_local(file, call->enclosing_symbol_id);
        if (local == SIZE_MAX) {
            if (file->coverage == CHRONOS_COMPLETE) return CHRONOS_INVALID_ARGUMENT;
            graph->edge_coverage = CHRONOS_INCOMPLETE;
            continue;
        }
        const GraphSymbol *caller = &graph->nodes[local_nodes[local]];
        if (call->range.start_byte < caller->location.range.start_byte ||
            call->range.end_byte > caller->location.range.end_byte)
            return CHRONOS_INVALID_ARGUMENT;
        GraphCall *edge = &edges[graph->edge_count++];
        edge->caller = caller->ref;
        edge->call_site = (SourceLocation){graph->revision, caller->location.file_path, call->range};
        edge->resolution = CALL_UNRESOLVED;
        if (!copy_text(&edge->callee_text, call->callee_text)) return CHRONOS_OUT_OF_MEMORY;
        int status = mapper_resolve_call(lookup, edge, caller, file);
        if (status < 0) return status;
    }
    return CHRONOS_OK;
}

static int add_count(size_t *total, size_t count)
{
    if (count > SIZE_MAX - *total) return 0;
    *total += count;
    return 1;
}

static ChronosCoverage graph_coverage(ChronosCoverage inventory, size_t files, size_t available)
{
    if (available == 0 && (inventory == CHRONOS_UNAVAILABLE || files != 0)) {
        return CHRONOS_UNAVAILABLE;
    }
    return CHRONOS_INCOMPLETE;
}

static int add_scope(RepositoryIndex *index, IndexScope scope, size_t *id)
{
    if (index->scope_count == index->scope_capacity) {
        size_t capacity = index->scope_capacity ? index->scope_capacity * 2 : 32;
        if (capacity < index->scope_capacity || capacity > SIZE_MAX / sizeof scope)
            return CHRONOS_TOO_LARGE;
        IndexScope *scopes = realloc(index->scopes, capacity * sizeof scope);
        if (!scopes) return CHRONOS_OUT_OF_MEMORY;
        index->scopes = scopes;
        index->scope_capacity = capacity;
    }
    *id = index->scope_count++;
    index->scopes[*id] = scope;
    return CHRONOS_OK;
}

static int add_file_scope(RepositoryIndex *index, const ParsedFile *file, size_t *id)
{
    size_t parent = 0;
    const char *path = file->file_path;
    for (const char *p = strchr(path, '/'); p; p = strchr(p + 1, '/')) {
        size_t length = (size_t)(p - path);
        if (length == 0 || p[-1] == '/' || p[1] == '\0') return CHRONOS_INVALID_ARGUMENT;
        size_t found = 1;
        while (found < index->scope_count) {
            const IndexScope *scope = &index->scopes[found];
            if (scope->kind == INDEX_MODULE && scope->parent == parent &&
                strlen(scope->path) == length && memcmp(scope->path, path, length) == 0) break;
            ++found;
        }
        if (found == index->scope_count) {
            char *module = malloc(length + 1);
            if (!module) return CHRONOS_OUT_OF_MEMORY;
            memcpy(module, path, length);
            module[length] = '\0';
            int status = add_scope(index, (IndexScope){INDEX_MODULE, parent, module, NULL,
                                                       index->file_coverage}, &found);
            if (status < 0) { free(module); return status; }
        }
        if (file->coverage != CHRONOS_COMPLETE) index->scopes[found].coverage = CHRONOS_INCOMPLETE;
        parent = found;
    }

    const char *copy = NULL;
    if (!copy_text(&copy, path)) return CHRONOS_OUT_OF_MEMORY;
    int status = add_scope(index, (IndexScope){INDEX_FILE, parent, copy, NULL, file->coverage}, id);
    if (status < 0) free((void *)copy);
    return status;
}

static int build_scopes(RepositoryIndex *index, const IndexFileInput *inputs, size_t file_count)
{
    const RepositoryGraph *graph = &index->graph;
    size_t root;
    int status = add_scope(index, (IndexScope){INDEX_PROJECT, INDEX_NO_SCOPE, NULL, NULL,
                                               graph->node_coverage}, &root);
    if (status < 0) return status;
    index->symbol_scopes = array_new(graph->node_count, sizeof *index->symbol_scopes);
    if (graph->node_count && !index->symbol_scopes) return CHRONOS_OUT_OF_MEMORY;

    for (size_t i = 0; i < file_count; ++i) {
        IndexedFile *file = &index->files[i];
        status = add_file_scope(index, inputs[i].parsed, &file->scope);
        if (status < 0) return status;
        const GitBlob *blob = inputs[i].blob;
        if (blob) {
            unsigned char *bytes = malloc(blob->byte_count ? blob->byte_count : 1);
            if (!bytes) return CHRONOS_OUT_OF_MEMORY;
            if (blob->byte_count) memcpy(bytes, blob->bytes, blob->byte_count);
            file->bytes = bytes;
            file->byte_count = blob->byte_count;
        }
        for (size_t j = file->first_symbol; j < file->first_symbol + file->symbol_count; ++j) {
            const GraphSymbol *symbol = &graph->nodes[j];
            status = add_scope(index, (IndexScope){INDEX_SYMBOL, file->scope, symbol->location.file_path,
                                                   symbol, inputs[i].parsed->coverage},
                               &index->symbol_scopes[j]);
            if (status < 0) return status;
        }
    }
    for (size_t i = 0; i < graph->node_count; ++i) {
        const SymbolVersionRef *parent = graph->nodes[i].parent;
        if (!parent) continue;
        const GraphSymbol *symbol = mapper_lookup_ref(index->lookup, parent);
        index->scopes[index->symbol_scopes[i]].parent = index->symbol_scopes[symbol - graph->nodes];
    }
    /* Parser inputs may be synthetic. Reject a cycle before exposing traversal. */
    for (size_t i = 0; i < graph->node_count; ++i) {
        size_t scope = index->symbol_scopes[i];
        size_t depth = 0;
        while (index->scopes[scope].kind == INDEX_SYMBOL) {
            if (++depth > graph->node_count) return CHRONOS_INVALID_ARGUMENT;
            scope = index->scopes[scope].parent;
        }
    }
    return CHRONOS_OK;
}

const IndexScope *index_scopes(const RepositoryIndex *index, size_t *count)
{
    if (count) *count = index ? index->scope_count : 0;
    return index ? index->scopes : NULL;
}

size_t index_find_symbol(const RepositoryIndex *index, const SymbolVersionRef *ref)
{
    if (!index) return INDEX_NO_SCOPE;
    const GraphSymbol *symbol = mapper_lookup_ref(index->lookup, ref);
    return symbol ? index->symbol_scopes[symbol - index->graph.nodes] : INDEX_NO_SCOPE;
}

static int build_call_links(RepositoryIndex *index)
{
    const RepositoryGraph *graph = &index->graph;
    size_t n = index->scope_count + 1;
    index->links = array_new(graph->edge_count, sizeof *index->links);
    index->outgoing_offsets = array_new(n, sizeof *index->outgoing_offsets);
    index->incoming_offsets = array_new(n, sizeof *index->incoming_offsets);
    index->outgoing = array_new(graph->edge_count, sizeof *index->outgoing);
    index->incoming = array_new(graph->edge_count, sizeof *index->incoming);
    if (!index->outgoing_offsets || !index->incoming_offsets ||
        (graph->edge_count && (!index->links || !index->outgoing || !index->incoming)))
        return CHRONOS_OUT_OF_MEMORY;

    for (size_t i = 0; i < graph->edge_count; ++i) {
        const GraphCall *call = &graph->edges[i];
        size_t caller = index_find_symbol(index, &call->caller);
        size_t callee = index_find_symbol(index, call->callee);
        index->links[i] = (IndexCallLink){call, caller, callee};
        ++index->outgoing_offsets[caller];
        if (callee != INDEX_NO_SCOPE) ++index->incoming_offsets[callee];
    }
    for (size_t i = 1; i < n; ++i) {
        index->outgoing_offsets[i] += index->outgoing_offsets[i - 1];
        index->incoming_offsets[i] += index->incoming_offsets[i - 1];
    }
    /* Filling each list in reverse restores the original graph edge order. */
    for (size_t i = graph->edge_count; i > 0; --i) {
        const IndexCallLink *link = &index->links[i - 1];
        index->outgoing[--index->outgoing_offsets[link->caller]] = i - 1;
        if (link->callee != INDEX_NO_SCOPE)
            index->incoming[--index->incoming_offsets[link->callee]] = i - 1;
    }
    return CHRONOS_OK;
}

static int scope_contains(const RepositoryIndex *index, size_t scope, size_t subject)
{
    if (scope == INDEX_NO_SCOPE) return 1;
    while (subject != INDEX_NO_SCOPE) {
        if (subject == scope) return 1;
        subject = index->scopes[subject].parent;
    }
    return 0;
}

void index_call_map_free(IndexCallMap *map)
{
    if (!map) return;
    free((void *)map->links);
    *map = (IndexCallMap){0};
}

int index_map_calls(const RepositoryIndex *index, size_t from, size_t to, IndexCallMap *out)
{
    if (!index || !out || (from != INDEX_NO_SCOPE && from >= index->scope_count) ||
        (to != INDEX_NO_SCOPE && to >= index->scope_count)) return CHRONOS_INVALID_ARGUMENT;
    size_t count = 0;
    for (size_t i = 0; i < index->graph.edge_count; ++i) {
        const IndexCallLink *link = &index->links[i];
        if (scope_contains(index, from, link->caller) && scope_contains(index, to, link->callee))
            ++count;
    }
    IndexCallLink *links = array_new(count, sizeof *links);
    if (count && !links) return CHRONOS_OUT_OF_MEMORY;
    size_t next = 0;
    for (size_t i = 0; i < index->graph.edge_count; ++i) {
        const IndexCallLink *link = &index->links[i];
        if (scope_contains(index, from, link->caller) && scope_contains(index, to, link->callee))
            links[next++] = *link;
    }
    *out = (IndexCallMap){links, count, index->graph.edge_coverage};
    return out->coverage == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;
}

const IndexCallLink *index_call_links(const RepositoryIndex *index, size_t *count)
{
    if (count) *count = index ? index->graph.edge_count : 0;
    return index ? index->links : NULL;
}

ChronosCoverage index_call_coverage(const RepositoryIndex *index)
{
    return index ? index->graph.edge_coverage : CHRONOS_UNAVAILABLE;
}

const char *index_file_bytes(const RepositoryIndex *index, const char *path, size_t *length)
{
    if (length) *length = 0;
    if (!index || !path) return NULL;
    for (size_t i = 0; i < index->file_count; ++i) {
        const IndexedFile *file = &index->files[i];
        const IndexScope *scope = &index->scopes[file->scope];
        if (!same_text(scope->path, path)) continue;
        if (!file->bytes) return NULL;
        if (length) *length = file->byte_count;
        return (const char *)file->bytes;
    }
    return NULL;
}


static int populate_index(RepositoryIndex *index, const IndexFileInput *files, size_t file_count,

                          ChronosCoverage file_coverage)
{
    RepositoryGraph *graph = &index->graph;
    size_t node_capacity = 0, edge_capacity = 0, diagnostic_capacity = 0, symbol_capacity = 0;
    size_t available = 0;
    int all_complete = file_coverage == CHRONOS_COMPLETE;
    for (size_t i = 0; i < file_count; ++i) {
        if (!valid_file(&graph->revision, &files[i])) return CHRONOS_INVALID_ARGUMENT;
        const ParsedFile *file = files[i].parsed;
        for (size_t j = 0; j < i; ++j) {
            if (same_text(file->file_path, files[j].parsed->file_path)) return CHRONOS_INVALID_ARGUMENT;
        }
        if (!add_count(&node_capacity, file->symbol_count) ||
            !add_count(&edge_capacity, file->call_count) ||
            !add_count(&diagnostic_capacity, file->diagnostic_count)) return CHRONOS_OUT_OF_MEMORY;
        if (file->symbol_count > symbol_capacity) symbol_capacity = file->symbol_count;
        if (file->coverage != CHRONOS_UNAVAILABLE) ++available;
        if (file->coverage != CHRONOS_COMPLETE) all_complete = 0;
    }

    graph->node_coverage = all_complete ? CHRONOS_COMPLETE :
                           graph_coverage(file_coverage, file_count, available);
    graph->edge_coverage = graph->node_coverage;
    index->file_coverage = file_coverage;
    index->files = array_new(file_count, sizeof *index->files);
    if (file_count && !index->files) return CHRONOS_OUT_OF_MEMORY;
    index->file_count = file_count;
    GraphSymbol *nodes = array_new(node_capacity, sizeof *nodes);
    GraphCall *edges = array_new(edge_capacity, sizeof *edges);
    ChronosDiagnostic *diagnostics = array_new(diagnostic_capacity, sizeof *diagnostics);
    size_t *local_nodes = array_new(symbol_capacity, sizeof *local_nodes);
    graph->nodes = nodes;
    graph->edges = edges;
    graph->diagnostics = diagnostics;
    int status = CHRONOS_OUT_OF_MEMORY;
    if ((node_capacity && nodes == NULL) || (edge_capacity && edges == NULL) ||
        (diagnostic_capacity && diagnostics == NULL) || (symbol_capacity && local_nodes == NULL)) goto done;

    for (size_t i = 0; i < file_count; ++i) {
        const ParsedFile *file = files[i].parsed;
        status = CHRONOS_OUT_OF_MEMORY;
        for (size_t j = 0; j < file->diagnostic_count; ++j) {
            if (!valid_diagnostic(&file->diagnostics[j])) {
                status = CHRONOS_INVALID_ARGUMENT;
                goto done;
            }
            if (!copy_diagnostic(&diagnostics[graph->diagnostic_count++], &file->diagnostics[j])) goto done;
        }
        index->files[i].first_symbol = graph->node_count;
        status = populate_nodes(graph, nodes, file, local_nodes, &graph->node_coverage);
        if (status < 0) goto done;
        index->files[i].symbol_count = graph->node_count - index->files[i].first_symbol;
    }

    status = mapper_lookup_build(graph, &index->lookup);
    if (status < 0) goto done;
    graph->edge_coverage = graph->node_coverage;
    status = build_scopes(index, files, file_count);
    if (status < 0) goto done;

    /* All nodes must be present before looking up cross-file calls. */
    for (size_t i = 0, next = 0; i < file_count; ++i) {
        const ParsedFile *file = files[i].parsed;
        size_t first = next;
        for (size_t j = 0; j < file->symbol_count; ++j) {
            size_t node = first;
            while (node < next && !same_tuple(&nodes[node], &file->symbols[j])) ++node;
            local_nodes[j] = node;
            if (node == next) ++next;
        }
        status = populate_calls(graph, edges, file, local_nodes, index->lookup);
        if (status < 0) goto done;
    }
    status = build_call_links(index);
    if (status < 0) goto done;
    status = graph->node_coverage == CHRONOS_COMPLETE && graph->edge_coverage == CHRONOS_COMPLETE
                 ? CHRONOS_OK : CHRONOS_PARTIAL;
done:
    free(local_nodes);
    return status;
}

int index_build(const RevisionRef *revision, const IndexFileInput *files, size_t file_count,
                ChronosCoverage file_coverage, RepositoryIndex **out)
{
    if (out == NULL) return CHRONOS_INVALID_ARGUMENT;
    *out = NULL;
    if (!valid_revision(revision) || !valid_coverage(file_coverage) ||
        (file_count && (files == NULL || file_coverage == CHRONOS_UNAVAILABLE))) {
        return CHRONOS_INVALID_ARGUMENT;
    }
    RepositoryIndex *index = calloc(1, sizeof *index);
    if (index == NULL) return CHRONOS_OUT_OF_MEMORY;
    int status = copy_revision(&index->graph.revision, revision)
                     ? populate_index(index, files, file_count, file_coverage) : CHRONOS_OUT_OF_MEMORY;
    if (status < 0) {
        index_free(index);
        return status;
    }
    *out = index;
    return status;
}

static const IndexedFile *symbol_file(const RepositoryIndex *index, size_t scope)
{
    while (index->scopes[scope].kind == INDEX_SYMBOL) scope = index->scopes[scope].parent;
    for (size_t i = 0; i < index->file_count; ++i)
        if (index->files[i].scope == scope) return &index->files[i];
    return NULL;
}

static ContextSource symbol_source(const RepositoryIndex *index, size_t scope)
{
    const IndexedFile *file = symbol_file(index, scope);
    if (!file || !file->bytes) return (ContextSource){.status = CONTEXT_SOURCE_UNAVAILABLE};
    const SourceLocation *location = &index->scopes[scope].symbol->location;
    return (ContextSource){CONTEXT_SOURCE_PRESENT, location,
                           (const char *)file->bytes + location->range.start_byte,
                           location->range.end_byte - location->range.start_byte};
}

const RevisionRef *index_revision(const RepositoryIndex *index)
{
    return index ? &index->graph.revision : NULL;
}

const ChronosDiagnostic *index_diagnostics(const RepositoryIndex *index, size_t *count)
{
    if (count) *count = index ? index->graph.diagnostic_count : 0;
    return index ? index->graph.diagnostics : NULL;
}

const IndexCoverage *index_coverage(const RepositoryIndex *index)
{
    return index != NULL && index->coverage_known ? &index->coverage : NULL;
}

static unsigned percent_tenths(size_t part, size_t total)
{
    if (total == 0) return 0;
    if (part > SIZE_MAX / 1000) return 1000;
    return (unsigned)((part * 1000 + total / 2) / total);
}

int index_set_coverage(RepositoryIndex *index, const IndexCoverage *coverage)
{
    if (index == NULL || coverage == NULL ||
        coverage->supported_files > coverage->source_files ||
        coverage->unsupported_files != coverage->source_files - coverage->supported_files ||
        coverage->supported_bytes > coverage->source_bytes ||
        coverage->unsupported_bytes != coverage->source_bytes - coverage->supported_bytes)
        return CHRONOS_INVALID_ARGUMENT;
    if (index->coverage_known) return CHRONOS_INVALID_ARGUMENT;
    index->coverage = *coverage;
    index->coverage_known = 1;

    char message[512];
    if (coverage->source_files == 0) {
        snprintf(message, sizeof message,
                 "No source files were found in the revision.");
    } else if (coverage->supported_files == 0) {
        snprintf(message, sizeof message,
                 "No supported source files were indexed (%zu source files are unsupported).",
                 coverage->unsupported_files);
    } else {
        unsigned file_tenths = percent_tenths(coverage->supported_files, coverage->source_files);
        unsigned byte_tenths = percent_tenths(coverage->supported_bytes, coverage->source_bytes);
        snprintf(message, sizeof message,
                 "Indexed %zu of %zu source files (%u.%u%%); %zu unsupported. "
                 "Supported bytes: %zu of %zu (%u.%u%%).",
                 coverage->supported_files, coverage->source_files,
                 file_tenths / 10, file_tenths % 10, coverage->unsupported_files,
                 coverage->supported_bytes, coverage->source_bytes,
                 byte_tenths / 10, byte_tenths % 10);
    }

    size_t count = index->graph.diagnostic_count;
    ChronosDiagnostic *items = realloc((void *)index->graph.diagnostics,
                                       (count + 1) * sizeof *items);
    if (items == NULL) return CHRONOS_OUT_OF_MEMORY;
    index->graph.diagnostics = items;
    items[count] = (ChronosDiagnostic){0};
    ChronosDiagnostic source = {
        "language-coverage",
        coverage->supported_files == 0 ? DIAGNOSTIC_WARNING : DIAGNOSTIC_INFO,
        message,
        NULL
    };
    if (!copy_diagnostic(&items[count], &source)) {
        free((void *)items[count].code);
        free((void *)items[count].message);
        return CHRONOS_OUT_OF_MEMORY;
    }
    index->graph.diagnostic_count = count + 1;
    return CHRONOS_OK;
}

int index_symbol_source(const RepositoryIndex *index, const SymbolVersionRef *ref, ContextSource *out)
{
    if (!index || !ref || !out) return CHRONOS_INVALID_ARGUMENT;
    size_t scope = index_find_symbol(index, ref);
    if (scope == INDEX_NO_SCOPE) return CHRONOS_NOT_FOUND;
    *out = symbol_source(index, scope);
    return out->status == CONTEXT_SOURCE_PRESENT ? CHRONOS_OK : CHRONOS_PARTIAL;
}

static void free_ref(const SymbolVersionRef *ref)
{
    if (!ref) return;
    free_revision(ref->revision);
    free((void *)ref->id);
}

static int copy_ref(SymbolVersionRef *out, const SymbolVersionRef *ref)
{
    return copy_revision(&out->revision, &ref->revision) && copy_text(&out->id, ref->id);
}

void index_change_set_free(IndexChangeSet *changes)
{
    if (!changes) return;
    for (size_t i = 0; i < changes->count; ++i) {
        const IndexSymbolChange *item = &changes->items[i];
        free_ref(item->before);
        free_ref(item->after);
        free((void *)item->before);
        free((void *)item->after);
        for (size_t j = 0; j < item->candidate_count; ++j) free_ref(&item->candidates[j]);
        free((void *)item->candidates);
    }
    free((void *)changes->items);
    free_revision(changes->revisions.base);
    free_revision(changes->revisions.head);
    free_diagnostics(changes->diagnostics, changes->diagnostic_count);
    *changes = (IndexChangeSet){0};
}

static int own_ref(const SymbolVersionRef **out, const GraphSymbol *symbol)
{
    if (!symbol) return 1;
    SymbolVersionRef *ref = calloc(1, sizeof *ref);
    if (!ref) return 0;
    *out = ref;
    return copy_ref(ref, &symbol->ref);
}

static ChronosCoverage path_coverage(const RepositoryIndex *index, const char *path)
{
    for (size_t i = 0; i < index->file_count; ++i) {
        const IndexScope *file = &index->scopes[index->files[i].scope];
        if (same_text(file->path, path)) return file->coverage;
    }
    return index->file_coverage;
}

static size_t count_matches(const RepositoryIndex *index, const GraphSymbol *anchor,
                            const GraphSymbol **first)
{
    size_t count = 0;
    for (size_t i = 0; i < index->graph.node_count; ++i) {
        const GraphSymbol *node = &index->graph.nodes[i];
        if (same_key(node, anchor)) {
            if (count == 0) *first = node;
            ++count;
        }
    }
    return count;
}

static int compare_side(const RepositoryIndex *side, const RepositoryIndex *other, int is_head,
                        IndexChangeSet *result, IndexSymbolChange *items)
{
    static const SymbolChangeKind added = SYMBOL_ADDED, deleted = SYMBOL_DELETED;
    static const SymbolChangeKind modified = SYMBOL_MODIFIED, unchanged = SYMBOL_UNCHANGED;
    for (size_t i = 0; i < side->graph.node_count; ++i) {
        const GraphSymbol *anchor = &side->graph.nodes[i];
        const GraphSymbol *match = NULL, *ignored = NULL;
        const char *path = anchor->location.file_path;
        size_t same = count_matches(side, anchor, &ignored);
        size_t count = count_matches(other, anchor, &match);
        int complete = path_coverage(side, path) == CHRONOS_COMPLETE &&
                       path_coverage(other, path) == CHRONOS_COMPLETE;
        /* The base pass owns each confirmed pair. */
        if (is_head && complete && same == 1 && count == 1) continue;
        IndexSymbolChange *item = &items[result->count++];
        const SymbolVersionRef **own = is_head ? &item->after : &item->before;
        const SymbolVersionRef **opposite = is_head ? &item->before : &item->after;
        if (!own_ref(own, anchor)) return CHRONOS_OUT_OF_MEMORY;

        if (same > 1 || count > 1) {
            item->match = INDEX_AMBIGUOUS;
            SymbolVersionRef *refs = array_new(count, sizeof *refs);
            if (count && !refs) return CHRONOS_OUT_OF_MEMORY;
            item->candidates = refs;
            for (size_t j = 0; j < other->graph.node_count; ++j) {
                const GraphSymbol *candidate = &other->graph.nodes[j];
                if (same_key(candidate, anchor) &&
                    !copy_ref(&refs[item->candidate_count++], &candidate->ref))
                    return CHRONOS_OUT_OF_MEMORY;
            }
        } else if (!complete) {
            item->match = INDEX_MATCH_UNAVAILABLE;
        } else if (count == 0) {
            item->match = INDEX_NO_MATCH;
            item->kind = is_head ? &added : &deleted;
        } else {
            item->match = INDEX_MATCHED;
            if (!own_ref(opposite, match)) return CHRONOS_OUT_OF_MEMORY;
            ContextSource before = symbol_source(side, side->symbol_scopes[i]);
            ContextSource after = symbol_source(other, index_find_symbol(other, &match->ref));
            if (before.status == CONTEXT_SOURCE_PRESENT && after.status == CONTEXT_SOURCE_PRESENT) {
                item->kind = before.byte_count == after.byte_count &&
                             memcmp(before.bytes, after.bytes, before.byte_count) == 0
                                 ? &unchanged : &modified;
            }
        }
        if (!item->kind) result->coverage = CHRONOS_INCOMPLETE;
    }
    return CHRONOS_OK;
}

int index_compare_revisions(const RepositoryIndex *base, const RepositoryIndex *head,
                            const GitChangedFiles *changes, IndexChangeSet *out)
{
    if (!base || !head || !out ||
        !same_text(base->graph.revision.repository_id, head->graph.revision.repository_id) ||
        (changes && (!same_revision(&changes->base, &base->graph.revision) ||
                     !same_revision(&changes->head, &head->graph.revision) ||
                     (changes->diagnostic_count && !changes->diagnostics))))
        return CHRONOS_INVALID_ARGUMENT;
    size_t capacity = base->graph.node_count;
    if (!add_count(&capacity, head->graph.node_count)) return CHRONOS_TOO_LARGE;
    IndexSymbolChange *items = array_new(capacity, sizeof *items);
    IndexChangeSet result = {.items = items};
    int status = CHRONOS_OUT_OF_MEMORY;
    if ((capacity && !items) || !copy_revision(&result.revisions.base, &base->graph.revision) ||
        !copy_revision(&result.revisions.head, &head->graph.revision)) goto fail;
    if (base->graph.node_coverage == CHRONOS_UNAVAILABLE &&
        head->graph.node_coverage == CHRONOS_UNAVAILABLE) result.coverage = CHRONOS_UNAVAILABLE;
    else if (base->graph.node_coverage != CHRONOS_COMPLETE ||
             head->graph.node_coverage != CHRONOS_COMPLETE) result.coverage = CHRONOS_INCOMPLETE;
    if (changes && changes->diagnostic_count) {
        ChronosDiagnostic *diagnostics = array_new(changes->diagnostic_count, sizeof *diagnostics);
        if (!diagnostics) goto fail;
        result.diagnostics = diagnostics;
        for (size_t i = 0; i < changes->diagnostic_count; ++i) {
            if (!valid_diagnostic(&changes->diagnostics[i])) { status = CHRONOS_INVALID_ARGUMENT; goto fail; }
            if (!copy_diagnostic(&diagnostics[result.diagnostic_count++], &changes->diagnostics[i])) goto fail;
        }
    }
    status = compare_side(base, head, 0, &result, items);
    if (status >= 0) status = compare_side(head, base, 1, &result, items);
    if (status < 0) goto fail;
    *out = result;
    return result.coverage == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;
fail:
    index_change_set_free(&result);
    return status;
}


/* References inside a graph borrow the graph's own node IDs and revision. */
static const GraphSymbol *copied_node(const RepositoryIndex *index, const GraphSymbol *nodes,
                                     const SymbolVersionRef *ref)
{
    const GraphSymbol *symbol = mapper_lookup_ref(index->lookup, ref);
    return symbol ? &nodes[symbol - index->graph.nodes] : NULL;
}

static int copy_node(GraphSymbol *out, const GraphSymbol *node, RevisionRef revision)
{
    out->ref.revision = revision;
    out->location.revision = revision;
    out->location.range = node->location.range;
    out->kind = node->kind;
    out->form = node->form;
    return copy_text(&out->ref.id, node->ref.id) &&
           copy_text(&out->logical_id, node->logical_id) &&
           copy_text(&out->name, node->name) &&
           copy_text(&out->qualified_name, node->qualified_name) &&
           copy_text(&out->signature, node->signature) &&
           copy_text(&out->language, node->language) &&
           copy_text(&out->location.file_path, node->location.file_path) &&
           copy_text(&out->source_sha256, node->source_sha256);
}

static int copy_edge(GraphCall *out, const GraphCall *edge, const RepositoryIndex *index,
                     const GraphSymbol *nodes)
{
    const GraphSymbol *caller = copied_node(index, nodes, &edge->caller);
    out->caller = caller->ref;
    out->call_site = (SourceLocation){out->caller.revision, caller->location.file_path,
                                     edge->call_site.range};
    out->resolution = edge->resolution;
    if (edge->callee != NULL) out->callee = &copied_node(index, nodes, edge->callee)->ref;
    if (edge->candidate_count != 0) {
        SymbolVersionRef *candidates = array_new(edge->candidate_count, sizeof *candidates);
        if (candidates == NULL) return 0;
        out->candidates = candidates;
        out->candidate_count = edge->candidate_count;
        for (size_t i = 0; i < edge->candidate_count; ++i) {
            candidates[i] = copied_node(index, nodes, &edge->candidates[i])->ref;
        }
    }
    return copy_text(&out->callee_text, edge->callee_text);
}

int index_export_graph(const RepositoryIndex *index, const IndexChangeSet *comparison,
                       RepositoryGraph *out)
{
    if (index == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    const RepositoryGraph *source = &index->graph;
    if (comparison && (!valid_revision(&comparison->revisions.base) ||
                       !valid_revision(&comparison->revisions.head) ||
                       !same_text(comparison->revisions.base.repository_id,
                                  comparison->revisions.head.repository_id) ||
                       (!same_revision(&source->revision, &comparison->revisions.base) &&
                        !same_revision(&source->revision, &comparison->revisions.head)) ||
                       (comparison->count && !comparison->items))) return CHRONOS_INVALID_ARGUMENT;

    RepositoryGraph result = {0};
    result.node_coverage = source->node_coverage;
    result.edge_coverage = source->edge_coverage;
    size_t diagnostic_count = source->diagnostic_count;
    GraphSymbol *nodes = array_new(source->node_count, sizeof *nodes);
    GraphCall *edges = array_new(source->edge_count, sizeof *edges);
    ChronosDiagnostic *diagnostics = array_new(diagnostic_count, sizeof *diagnostics);
    result.nodes = nodes;
    result.edges = edges;
    result.diagnostics = diagnostics;
    int status = CHRONOS_OUT_OF_MEMORY;
    if ((source->node_count && nodes == NULL) || (source->edge_count && edges == NULL) ||
        (diagnostic_count && diagnostics == NULL) ||
        !copy_revision(&result.revision, &source->revision)) goto fail;
    if (comparison) {
        GraphComparison *pair = calloc(1, sizeof *pair);
        result.comparison = pair;
        if (!pair || !copy_revision(&pair->base, &comparison->revisions.base) ||
            !copy_revision(&pair->head, &comparison->revisions.head)) goto fail;
    }

    for (size_t i = 0; i < source->node_count; ++i) {
        const GraphSymbol *node = &source->nodes[i];
        ++result.node_count;
        if (!copy_node(&nodes[i], node, result.revision)) goto fail;
        if (node->parent != NULL) nodes[i].parent = &copied_node(index, nodes, node->parent)->ref;
    }
    for (size_t i = 0; i < source->edge_count; ++i) {
        ++result.edge_count;
        if (!copy_edge(&edges[i], &source->edges[i], index, nodes)) goto fail;
    }
    if (comparison) {
        int head = same_revision(&source->revision, &comparison->revisions.head);
        for (size_t i = 0; i < comparison->count; ++i) {
            const IndexSymbolChange *item = &comparison->items[i];
            if (!item->kind) continue;
            const GraphSymbol *symbol = mapper_lookup_ref(index->lookup, head ? item->after : item->before);
            if (!symbol) continue;
            SymbolChangeKind *kind = malloc(sizeof *kind);
            if (!kind) goto fail;
            *kind = *item->kind;
            GraphSymbol *node = &nodes[symbol - source->nodes];
            free((void *)node->change);
            node->change = kind;
        }
    }
    for (size_t i = 0; i < diagnostic_count; ++i) {
        if (!copy_diagnostic(&diagnostics[result.diagnostic_count++], &source->diagnostics[i])) goto fail;
    }

    *out = result;
    return result.node_coverage == CHRONOS_COMPLETE && result.edge_coverage == CHRONOS_COMPLETE
               ? CHRONOS_OK : CHRONOS_PARTIAL;
fail:
    index_graph_free(&result);
    return status;
}

void index_context_free(IndexContext *context)
{
    if (!context) return;
    for (size_t i = 0; i < context->candidates.count; ++i)
        free((void *)context->candidates.items[i].id);
    free((void *)context->candidates.items);
    *context = (IndexContext){0};
}

static int collect_candidate(const RepositoryIndex *index, const IndexCallLink *link,
                             ContextCallDirection direction, ContextCandidate *item)
{
    const GraphCall *call = link->call;
    char *id = context_call_evidence_id_alloc(call);
    if (id == NULL) return CHRONOS_OUT_OF_MEMORY;
    size_t neighbor = direction == CONTEXT_INCOMING_CALL ? link->caller : link->callee;
    ContextSource source = {.status = CONTEXT_SOURCE_UNAVAILABLE};
    if (neighbor != INDEX_NO_SCOPE) source = symbol_source(index, neighbor);
    *item = (ContextCandidate){id, direction, call, source};
    return CHRONOS_OK;
}

static int snippets_overlap(const ContextSource *left, const ContextSource *right)
{
    if (left->status != CONTEXT_SOURCE_PRESENT || right->status != CONTEXT_SOURCE_PRESENT)
        return 0;
    const SourceLocation *a = left->location;
    const SourceLocation *b = right->location;
    if (!same_revision(&a->revision, &b->revision) ||
        !same_text(a->file_path, b->file_path)) return 0;
    size_t a_start = a->range.start_byte, a_end = a->range.end_byte;
    size_t b_start = b->range.start_byte, b_end = b->range.end_byte;
    if (a_start == a_end || b_start == b_end) return a_start == b_start;
    return a_start < b_end && b_start < a_end;
}

/* Keep one representative for overlapping, same-direction snippets. The
 * candidate order is the deterministic callsite order from the index. */
static void deduplicate_candidates(ContextCandidate *items, size_t *count)
{
    size_t kept = 0;
    for (size_t i = 0; i < *count; ++i) {
        int duplicate = 0;
        for (size_t j = 0; j < kept; ++j) {
            if (items[i].direction == items[j].direction &&
                snippets_overlap(&items[i].snippet, &items[j].snippet)) {
                duplicate = 1;
                break;
            }
        }
        if (duplicate) {
            free((void *)items[i].id);
            continue;
        }
        if (kept != i) items[kept] = items[i];
        ++kept;
    }
    *count = kept;
}

int index_collect_context(const RepositoryIndex *index, const SymbolVersionRef *target,
                         IndexContext *out)
{
    if (!index || !target || !out) return CHRONOS_INVALID_ARGUMENT;
    size_t scope = index_find_symbol(index, target);
    if (scope == INDEX_NO_SCOPE) return CHRONOS_NOT_FOUND;

    size_t out_start = index->outgoing_offsets[scope], out_end = index->outgoing_offsets[scope + 1];
    size_t in_start = index->incoming_offsets[scope], in_end = index->incoming_offsets[scope + 1];
    size_t capacity = out_end - out_start;
    if (!add_count(&capacity, in_end - in_start)) return CHRONOS_TOO_LARGE;
    ContextCandidate *items = array_new(capacity, sizeof *items);
    if (capacity && !items) return CHRONOS_OUT_OF_MEMORY;
    IndexContext result = {.target_source = symbol_source(index, scope),
                           .candidates = {items, 0, index->graph.edge_coverage}};
    int status = CHRONOS_OK;
    for (size_t i = out_start; i < out_end && status >= 0; ++i) {
        status = collect_candidate(index, &index->links[index->outgoing[i]],
                                   CONTEXT_OUTGOING_CALL, &items[result.candidates.count]);
        if (status >= 0) ++result.candidates.count;
    }
    for (size_t i = in_start; i < in_end && status >= 0; ++i) {
        const IndexCallLink *link = &index->links[index->incoming[i]];
        if (link->caller == scope) continue;
        status = collect_candidate(index, link, CONTEXT_INCOMING_CALL, &items[result.candidates.count]);
        if (status >= 0) ++result.candidates.count;
    }
    if (status < 0) index_context_free(&result);
    else {
        deduplicate_candidates(items, &result.candidates.count);
        *out = result;
        if (result.candidates.coverage != CHRONOS_COMPLETE) status = CHRONOS_PARTIAL;
    }
    return status;
}
