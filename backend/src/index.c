#include "index.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* First milestone: build one graph from parser records supplied by the caller. */
struct RepositoryIndex {
    RepositoryGraph graph;
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
    free_diagnostics(graph->diagnostics, graph->diagnostic_count);
    free_revision(graph->revision);
    *graph = (RepositoryGraph){0};
}

void index_free(RepositoryIndex *index)
{
    if (index == NULL) return;
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

/* A starter resolver for direct names. Only a unique same-language
 * definition in a complete graph is enough to mark a call resolved. */
static int call_matches(const GraphSymbol *node, const GraphSymbol *caller, const char *name)
{
    int absolute = name[0] == ':' && name[1] == ':';
    if (absolute) name += 2;
    return node->kind != PARSER_CLASS && node->form == PARSER_DEFINITION &&
           same_text(node->language, caller->language) &&
           (absolute || strstr(name, "::") != NULL ? same_text(node->qualified_name, name) :
                                                      same_text(node->name, name));
}

static int resolve_call(const RepositoryGraph *graph, GraphCall *edge, const GraphSymbol *caller)
{
    if (!direct_name(edge->callee_text)) return 1;
    const char *name = edge->callee_text;
    size_t count = 0;
    const GraphSymbol *target = NULL;
    for (size_t i = 0; i < graph->node_count; ++i) {
        const GraphSymbol *node = &graph->nodes[i];
        if (call_matches(node, caller, name)) {
            ++count;
            target = node;
        }
    }
    if (count == 1 && graph->node_coverage == CHRONOS_COMPLETE) {
        edge->resolution = CALL_RESOLVED;
        edge->callee = &target->ref;
    } else if (count > 1) {
        SymbolVersionRef *candidates = array_new(count, sizeof *candidates);
        if (candidates == NULL) return 0;
        edge->resolution = CALL_AMBIGUOUS;
        edge->candidates = candidates;
        edge->candidate_count = count;
        size_t next = 0;
        for (size_t i = 0; i < graph->node_count; ++i) {
            const GraphSymbol *node = &graph->nodes[i];
            if (call_matches(node, caller, name)) candidates[next++] = node->ref;
        }
    }
    return 1;
}

static int populate_calls(RepositoryGraph *graph, GraphCall *edges, const ParsedFile *file,
                          const size_t *local_nodes)
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
        GraphCall *edge = &edges[graph->edge_count++];
        edge->caller = caller->ref;
        edge->call_site = (SourceLocation){graph->revision, caller->location.file_path, call->range};
        edge->resolution = CALL_UNRESOLVED;
        if (!copy_text(&edge->callee_text, call->callee_text) ||
            !resolve_call(graph, edge, caller)) return CHRONOS_OUT_OF_MEMORY;
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
        status = populate_nodes(graph, nodes, file, local_nodes, &graph->node_coverage);
        if (status < 0) goto done;
    }

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
        status = populate_calls(graph, edges, file, local_nodes);
        if (status < 0) goto done;
    }
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

void index_change_set_free(IndexChangeSet *changes)
{
    /* This milestone produces no change sets. */
    if (changes != NULL) *changes = (IndexChangeSet){0};
}

int index_compare_revisions(const RepositoryIndex *base, const RepositoryIndex *head,
                            const GitChangedFiles *changes, IndexChangeSet *out)
{
    (void)changes;
    if (base == NULL || head == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    /* Revision comparison is deferred. Optional blobs are validated at
     * build time and can be retained here when comparison is implemented. */
    return CHRONOS_NOT_IMPLEMENTED;
}

/* References inside a graph borrow the graph's own node IDs and revision. */
static const GraphSymbol *copied_node(const RepositoryGraph *source, const GraphSymbol *nodes,
                                       const SymbolVersionRef *ref)
{
    for (size_t i = 0; i < source->node_count; ++i) {
        if (source->nodes[i].ref.id == ref->id) return &nodes[i];
    }
    return NULL;
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

static int copy_edge(GraphCall *out, const GraphCall *edge, const RepositoryGraph *source,
                     const GraphSymbol *nodes)
{
    const GraphSymbol *caller = copied_node(source, nodes, &edge->caller);
    out->caller = caller->ref;
    out->call_site = (SourceLocation){out->caller.revision, caller->location.file_path,
                                     edge->call_site.range};
    out->resolution = edge->resolution;
    if (edge->callee != NULL) out->callee = &copied_node(source, nodes, edge->callee)->ref;
    if (edge->candidate_count != 0) {
        SymbolVersionRef *candidates = array_new(edge->candidate_count, sizeof *candidates);
        if (candidates == NULL) return 0;
        out->candidates = candidates;
        out->candidate_count = edge->candidate_count;
        for (size_t i = 0; i < edge->candidate_count; ++i) {
            candidates[i] = copied_node(source, nodes, &edge->candidates[i])->ref;
        }
    }
    return copy_text(&out->callee_text, edge->callee_text);
}

int index_export_graph(const RepositoryIndex *index, const IndexChangeSet *comparison,
                       RepositoryGraph *out)
{
    if (index == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    const RepositoryGraph *source = &index->graph;
    if (comparison != NULL) return CHRONOS_NOT_IMPLEMENTED;

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

    for (size_t i = 0; i < source->node_count; ++i) {
        const GraphSymbol *node = &source->nodes[i];
        ++result.node_count;
        if (!copy_node(&nodes[i], node, result.revision)) goto fail;
        if (node->parent != NULL) nodes[i].parent = &copied_node(source, nodes, node->parent)->ref;
    }
    for (size_t i = 0; i < source->edge_count; ++i) {
        ++result.edge_count;
        if (!copy_edge(&edges[i], &source->edges[i], source, nodes)) goto fail;
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
