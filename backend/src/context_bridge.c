#include "context_flow.h"
#include "context_compiler.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BRIDGE_MAX_CHAIN 8u

typedef struct {
    ContextBridgeEdge *edges;
    size_t count;
    size_t capacity;
} EdgeList;

static int is_ident_start(unsigned char value)
{
    return isalpha(value) || value == '_' || value == '$';
}

static int is_ident_char(unsigned char value)
{
    return isalnum(value) || value == '_' || value == '$';
}

static char *copy_text(const char *text)
{
    if (text == NULL) return NULL;
    size_t length = strlen(text);
    char *copy = malloc(length + 1);
    if (copy != NULL) memcpy(copy, text, length + 1);
    return copy;
}

static const char *find_bytes(const char *bytes, size_t length, const char *needle)
{
    size_t needle_length = strlen(needle);
    if (needle_length == 0 || needle_length > length) return NULL;
    for (size_t i = 0; i <= length - needle_length; ++i)
        if (memcmp(bytes + i, needle, needle_length) == 0) return bytes + i;
    return NULL;
}

static size_t line_for_offset(const char *bytes, size_t length, size_t offset)
{
    size_t line = 1;
    for (size_t i = 0; i < offset && i < length; ++i)
        if (bytes[i] == '\n') ++line;
    return line;
}

static int callee_base_name(const char *text, char *out, size_t capacity)
{
    if (text == NULL || capacity == 0) return 0;
    const char *start = text;
    for (const char *p = text; *p; ++p) {
        if (p[0] == ':' && p[1] == ':') {
            start = p + 2;
            ++p;
        } else if (p[0] == '-' && p[1] == '>') {
            start = p + 2;
            ++p;
        } else if (p[0] == '.') {
            start = p + 1;
        }
    }
    while (*start == ' ' || *start == '\t' || *start == '&' || *start == '*') ++start;
    size_t length = 0;
    while (is_ident_char((unsigned char)start[length])) ++length;
    if (length == 0) return 0;
    if (length >= capacity) length = capacity - 1;
    memcpy(out, start, length);
    out[length] = '\0';
    return 1;
}

static int extract_string_literal(const char *bytes, size_t length, size_t start, size_t end,
                                  char *out, size_t capacity)
{
    if (bytes == NULL || capacity == 0 || start >= end || end > length) return 0;
    for (size_t i = start; i < end; ++i) {
        char quote = bytes[i];
        if (quote != '"' && quote != '\'') continue;
        size_t used = 0;
        for (size_t j = i + 1; j < end; ++j) {
            char value = bytes[j];
            if (value == quote) {
                out[used] = '\0';
                return used != 0;
            }
            if (value == '\n' || value == '\r') break;
            if (value == '\\' && j + 1 < end) value = bytes[++j];
            if (used + 1 < capacity) out[used++] = value;
        }
        return 0;
    }
    return 0;
}

static int callee_qualifier(const char *text, char *out, size_t capacity)
{
    if (text == NULL || capacity == 0) return 0;
    const char *end = NULL;
    for (const char *p = text; *p; ++p) {
        if (p[0] == ':' && p[1] == ':') end = p;
        else if (p[0] == '.' || (p[0] == '-' && p[1] == '>')) end = p;
    }
    if (end == NULL) return 0;
    const char *start = end;
    while (start > text && is_ident_char((unsigned char)start[-1])) --start;
    size_t length = (size_t)(end - start);
    if (length == 0) return 0;
    if (length >= capacity) length = capacity - 1;
    memcpy(out, start, length);
    out[length] = '\0';
    return 1;
}

static int file_matches_qualifier(const char *path, const char *qualifier)
{
    if (path == NULL || qualifier == NULL) return 0;
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    size_t length = strcspn(base, ".");
    return strlen(qualifier) == length && strncmp(base, qualifier, length) == 0;
}

static const GraphSymbol *find_candidate(const RepositoryIndex *index, size_t current,
                                         const char *language, const char *name,
                                         const char *qualifier, size_t *matches_out,
                                         size_t *scope_out)
{
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    const GraphSymbol *found = NULL;
    size_t found_scope = INDEX_NO_SCOPE;
    size_t matches = 0;
    for (size_t i = 0; i < count; ++i) {
        if (i == current || scopes[i].kind != INDEX_SYMBOL || scopes[i].symbol == NULL)
            continue;
        const GraphSymbol *symbol = scopes[i].symbol;
        if (symbol->form != PARSER_DEFINITION || strcmp(symbol->name, name) != 0) continue;
        if (language != NULL && strcmp(symbol->language, language) != 0) continue;
        if (qualifier != NULL && !file_matches_qualifier(symbol->location.file_path, qualifier))
            continue;
        ++matches;
        if (matches == 1) {
            found = symbol;
            found_scope = i;
        }
    }
    if (matches_out) *matches_out = matches;
    if (matches == 1 && scope_out) *scope_out = found_scope;
    return matches == 1 ? found : NULL;
}

/* Resolve a callee by exact short name, preferring the caller's language.
 * A qualifier such as `ffi::` selects the matching file when short names are
 * repeated (for example, the Tauri command and its FFI wrapper both named
 * export_graph). Cross-language resolution is the FFI bridge. */
static const GraphSymbol *resolve_callee(const RepositoryIndex *index, size_t current,
                                         const char *callee_text, int allow_any,
                                         size_t *scope_out)
{
    char name[128];
    if (!callee_base_name(callee_text, name, sizeof name)) return NULL;
    char qualifier[128];
    int has_qualifier = callee_qualifier(callee_text, qualifier, sizeof qualifier);
    const GraphSymbol *current_symbol = NULL;
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    if (current < count) current_symbol = scopes[current].symbol;
    const char *language = current_symbol ? current_symbol->language : NULL;
    for (int pass = 0; pass < (allow_any ? 2 : 1); ++pass) {
        const char *wanted = pass == 0 ? language : NULL;
        if (has_qualifier) {
            size_t matches = 0;
            const GraphSymbol *found = find_candidate(index, current, wanted, name,
                                                      qualifier, &matches, scope_out);
            if (matches != 0) return found;
        }
        size_t matches = 0;
        const GraphSymbol *found = find_candidate(index, current, wanted, name,
                                                  NULL, &matches, scope_out);
        if (matches != 0) return found;
    }
    return NULL;
}

static int wrapper_scopes(const RepositoryIndex *index, const IndexCallLink *links,
                          size_t link_count, int **out)
{
    size_t scope_count = 0;
    index_scopes(index, &scope_count);
    int *wrappers = calloc(scope_count, sizeof *wrappers);
    if (wrappers == NULL) return CHRONOS_OUT_OF_MEMORY;
    for (size_t i = 0; i < link_count; ++i) {
        if (links[i].caller == INDEX_NO_SCOPE) continue;
        char name[128];
        if (!callee_base_name(links[i].call->callee_text, name, sizeof name)) continue;
        if (strcmp(name, "invoke") == 0) wrappers[links[i].caller] = 1;
    }
    *out = wrappers;
    return CHRONOS_OK;
}

static char *registration_evidence_id(const SymbolVersionRef *command, const char *path,
                                      size_t start, size_t end)
{
    int length = snprintf(NULL, 0, "bridge:v1:register:%zu:%s%zu:%s:%zu:%zu",
                          strlen(command->id), command->id, strlen(path), path, start, end);
    if (length < 0) return NULL;
    char *id = malloc((size_t)length + 1);
    if (id == NULL) return NULL;
    (void)snprintf(id, (size_t)length + 1, "bridge:v1:register:%zu:%s%zu:%s:%zu:%zu",
                   strlen(command->id), command->id, strlen(path), path, start, end);
    return id;
}

static int find_registration(const RepositoryIndex *index, const GraphSymbol *command,
                             SourceLocation *location, char **evidence_id)
{
    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(index, &scope_count);
    for (size_t i = 0; i < scope_count; ++i) {
        if (scopes[i].kind != INDEX_FILE || scopes[i].path == NULL) continue;
        const char *language = parser_language_for_path(scopes[i].path);
        if (language == NULL || strcmp(language, "rust") != 0) continue;
        size_t length = 0;
        const char *bytes = index_file_bytes(index, scopes[i].path, &length);
        if (bytes == NULL) continue;
        const char *cursor = bytes;
        size_t remaining = length;
        while (remaining != 0) {
            const char *hit = find_bytes(cursor, remaining, "generate_handler");
            if (hit == NULL) break;
            size_t offset = (size_t)(hit - bytes);
            if (offset > 0 && is_ident_char((unsigned char)bytes[offset - 1])) {
                cursor = hit + 1;
                remaining = length - (size_t)(cursor - bytes);
                continue;
            }
            const char *p = hit + strlen("generate_handler");
            const char *limit = bytes + length;
            while (p < limit && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
            if (p == limit || *p != '!') {
                cursor = hit + 1;
                remaining = length - (size_t)(cursor - bytes);
                continue;
            }
            ++p;
            while (p < limit && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
            if (p == limit || *p != '[') {
                cursor = hit + 1;
                remaining = length - (size_t)(cursor - bytes);
                continue;
            }
            size_t depth = 1;
            const char *q = p + 1;
            while (q < limit && depth != 0) {
                if (*q == '[') ++depth;
                else if (*q == ']') --depth;
                ++q;
            }
            if (depth != 0) return 0;
            const char *content_end = q - 1;
            for (const char *name = p + 1; name < content_end;) {
                if (!is_ident_start((unsigned char)*name)) {
                    ++name;
                    continue;
                }
                const char *name_end = name + 1;
                while (name_end < content_end && is_ident_char((unsigned char)*name_end)) ++name_end;
                size_t name_length = (size_t)(name_end - name);
                if (name_length == strlen(command->name) &&
                    memcmp(name, command->name, name_length) == 0) {
                    size_t start = (size_t)(name - bytes);
                    size_t end = (size_t)(name_end - bytes);
                    size_t line = line_for_offset(bytes, length, start);
                    *location = (SourceLocation){
                        *index_revision(index), scopes[i].path, {start, end, line, line}
                    };
                    *evidence_id = registration_evidence_id(
                        &command->ref, scopes[i].path, start, end);
                    return *evidence_id == NULL ? -1 : 1;
                }
                name = name_end;
            }
            cursor = hit + 1;
            remaining = length - (size_t)(cursor - bytes);
        }
    }
    return 0;
}

static int find_command_symbol(const RepositoryIndex *index, const char *name,
                               const GraphSymbol **symbol_out, size_t *scope_out,
                               SourceLocation *location_out, char **evidence_out)
{
    *symbol_out = NULL;
    *evidence_out = NULL;
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    const GraphSymbol *strong_symbol = NULL;
    const GraphSymbol *weak_symbol = NULL;
    size_t strong_scope = INDEX_NO_SCOPE, weak_scope = INDEX_NO_SCOPE;
    SourceLocation strong_location = {0}, weak_location = {0};
    char *strong_id = NULL, *weak_id = NULL;
    int strong_ambiguous = 0, weak_ambiguous = 0;
    for (size_t i = 0; i < count; ++i) {
        if (scopes[i].kind != INDEX_SYMBOL || scopes[i].symbol == NULL) continue;
        const GraphSymbol *symbol = scopes[i].symbol;
        if (symbol->form != PARSER_DEFINITION || strcmp(symbol->language, "rust") != 0 ||
            strcmp(symbol->name, name) != 0)
            continue;
        SourceLocation location = {0};
        char *evidence_id = NULL;
        int registered = find_registration(index, symbol, &location, &evidence_id);
        if (registered < 0) {
            free(evidence_id);
            free(strong_id);
            free(weak_id);
            return CHRONOS_OUT_OF_MEMORY;
        }
        if (registered == 0) {
            free(evidence_id);
            continue;
        }
        int same_file = strcmp(symbol->location.file_path, location.file_path) == 0;
        if (same_file) {
            free(weak_id);
            weak_id = NULL;
            weak_symbol = NULL;
            weak_ambiguous = 0;
            if (strong_symbol != NULL) {
                strong_ambiguous = 1;
                free(evidence_id);
                continue;
            }
            strong_symbol = symbol;
            strong_scope = i;
            strong_location = location;
            strong_id = evidence_id;
        } else if (strong_symbol == NULL) {
            if (weak_symbol != NULL) {
                weak_ambiguous = 1;
                free(evidence_id);
                continue;
            }
            weak_symbol = symbol;
            weak_scope = i;
            weak_location = location;
            weak_id = evidence_id;
        } else {
            free(evidence_id);
        }
    }
    if (strong_ambiguous) {
        free(strong_id);
        free(weak_id);
        return CHRONOS_OK;
    }
    if (strong_symbol != NULL) {
        free(weak_id);
        *symbol_out = strong_symbol;
        *scope_out = strong_scope;
        *location_out = strong_location;
        *evidence_out = strong_id;
        return CHRONOS_OK;
    }
    if (weak_ambiguous) {
        free(weak_id);
        return CHRONOS_OK;
    }
    *symbol_out = weak_symbol;
    *scope_out = weak_scope;
    *location_out = weak_location;
    *evidence_out = weak_id;
    return CHRONOS_OK;
}

static int add_edge(EdgeList *list, ContextBridgeKind kind, const SymbolVersionRef *from,
                    const SymbolVersionRef *to, const char *label, char *evidence_id,
                    SourceLocation evidence)
{
    if (evidence_id == NULL) return CHRONOS_OUT_OF_MEMORY;
    for (size_t i = 0; i < list->count; ++i) {
        if (strcmp(list->edges[i].evidence_id, evidence_id) == 0) {
            free(evidence_id);
            return CHRONOS_OK;
        }
    }
    if (list->count == list->capacity) {
        size_t capacity = list->capacity ? list->capacity * 2 : 8;
        ContextBridgeEdge *edges = realloc(list->edges, capacity * sizeof *edges);
        if (edges == NULL) {
            free(evidence_id);
            return CHRONOS_OUT_OF_MEMORY;
        }
        list->edges = edges;
        list->capacity = capacity;
    }
    char *label_copy = copy_text(label);
    if (label_copy == NULL) {
        free(evidence_id);
        return CHRONOS_OUT_OF_MEMORY;
    }
    list->edges[list->count++] = (ContextBridgeEdge){
        kind, from, to, label_copy, evidence_id, evidence
    };
    return CHRONOS_OK;
}

static ChronosCoverage bridge_coverage(const RepositoryIndex *index)
{
    size_t count = 0;
    const IndexScope *scopes = index_scopes(index, &count);
    int relevant = 0;
    for (size_t i = 0; i < count; ++i) {
        if (scopes[i].kind != INDEX_FILE || scopes[i].path == NULL) continue;
        const char *language = parser_language_for_path(scopes[i].path);
        if (language == NULL) continue;
        if (strcmp(language, "rust") != 0 && strcmp(language, "typescript") != 0 &&
            strcmp(language, "tsx") != 0 && strcmp(language, "javascript") != 0)
            continue;
        relevant = 1;
        if (index_file_bytes(index, scopes[i].path, NULL) == NULL)
            return CHRONOS_INCOMPLETE;
    }
    return relevant ? CHRONOS_COMPLETE : CHRONOS_UNAVAILABLE;
}

static int walk_bridge_chain(const RepositoryIndex *index, const IndexScope *scopes,
                             const IndexCallLink *links, size_t link_count,
                             size_t command_scope, EdgeList *edges)
{
    size_t scope_count = 0;
    index_scopes(index, &scope_count);
    int *visited = calloc(scope_count, sizeof *visited);
    size_t *queue = malloc(scope_count * sizeof *queue);
    if (visited == NULL || queue == NULL) {
        free(visited);
        free(queue);
        return CHRONOS_OUT_OF_MEMORY;
    }
    size_t head = 0, tail = 0, walked = 0;
    visited[command_scope] = 1;
    queue[tail++] = command_scope;
    int status = CHRONOS_OK;
    while (head < tail && walked < BRIDGE_MAX_CHAIN) {
        size_t current = queue[head++];
        ++walked;
        const GraphSymbol *current_symbol = scopes[current].symbol;
        if (current_symbol == NULL) continue;
        for (size_t i = 0; i < link_count; ++i) {
            if (links[i].caller != current) continue;
            const GraphCall *call = links[i].call;
            size_t next = links[i].callee;
            char name[128];
            if (!callee_base_name(call->callee_text, name, sizeof name)) continue;
            if (next == INDEX_NO_SCOPE) {
                const GraphSymbol *resolved = resolve_callee(
                    index, current, call->callee_text, 1, &next);
                if (resolved == NULL) continue;
            }
            if (next == INDEX_NO_SCOPE || next >= scope_count || next == current ||
                visited[next] || scopes[next].symbol == NULL) continue;
            const GraphSymbol *next_symbol = scopes[next].symbol;
            ContextBridgeKind kind = strcmp(current_symbol->language, next_symbol->language) == 0
                ? CONTEXT_BRIDGE_DISPATCH : CONTEXT_BRIDGE_FFI;
            char *evidence_id = context_call_evidence_id_alloc(call);
            if (evidence_id == NULL) {
                status = CHRONOS_OUT_OF_MEMORY;
                goto done;
            }
            status = add_edge(edges, kind, &current_symbol->ref, &next_symbol->ref,
                              name, evidence_id, call->call_site);
            if (status < 0) goto done;
            visited[next] = 1;
            if (kind == CONTEXT_BRIDGE_DISPATCH) queue[tail++] = next;
        }
    }
done:
    free(visited);
    free(queue);
    return status;
}

void context_bridge_set_free(ContextBridgeSet *set)
{
    if (set == NULL) return;
    for (size_t i = 0; i < set->count; ++i) {
        free((void *)set->edges[i].label);
        free((void *)set->edges[i].evidence_id);
    }
    free(set->edges);
    *set = (ContextBridgeSet){0};
}

int context_discover_bridges(const RepositoryIndex *index, ContextBridgeSet *out)
{
    if (index == NULL || out == NULL) return CHRONOS_INVALID_ARGUMENT;
    *out = (ContextBridgeSet){0};
    size_t scope_count = 0;
    const IndexScope *scopes = index_scopes(index, &scope_count);
    size_t link_count = 0;
    const IndexCallLink *links = index_call_links(index, &link_count);
    int *wrappers = NULL;
    int status = wrapper_scopes(index, links, link_count, &wrappers);
    if (status < 0) return status;

    EdgeList edges = {0};
    for (size_t i = 0; i < link_count && status >= 0; ++i) {
        const IndexCallLink *link = &links[i];
        if (link->caller == INDEX_NO_SCOPE) continue;
        const GraphCall *call = link->call;
        char base[128];
        if (!callee_base_name(call->callee_text, base, sizeof base)) continue;
        int invoke = strcmp(base, "invoke") == 0;
        if (!invoke && link->callee != INDEX_NO_SCOPE && wrappers[link->callee]) invoke = 1;
        if (!invoke && link->callee == INDEX_NO_SCOPE) {
            size_t wrapper_scope = INDEX_NO_SCOPE;
            const GraphSymbol *wrapper = resolve_callee(
                index, link->caller, call->callee_text, 0, &wrapper_scope);
            if (wrapper != NULL && wrapper_scope < scope_count && wrappers[wrapper_scope])
                invoke = 1;
        }
        if (!invoke) continue;

        size_t file_length = 0;
        const char *bytes = index_file_bytes(index, call->call_site.file_path, &file_length);
        if (bytes == NULL) continue;
        char command[256];
        if (!extract_string_literal(bytes, file_length, call->call_site.range.start_byte,
                                    call->call_site.range.end_byte, command, sizeof command))
            continue;
        size_t command_scope = INDEX_NO_SCOPE;
        const GraphSymbol *command_symbol = NULL;
        SourceLocation registration_location = {0};
        char *registration_id = NULL;
        status = find_command_symbol(index, command, &command_symbol, &command_scope,
                                     &registration_location, &registration_id);
        if (status < 0) break;
        if (command_symbol == NULL) continue;

        char *call_id = context_call_evidence_id_alloc(call);
        if (call_id == NULL) {
            free(registration_id);
            status = CHRONOS_OUT_OF_MEMORY;
            break;
        }
        status = add_edge(&edges, CONTEXT_BRIDGE_INVOKE, &call->caller, &command_symbol->ref,
                          command, call_id, call->call_site);
        if (status < 0) {
            free(registration_id);
            break;
        }
        status = add_edge(&edges, CONTEXT_BRIDGE_REGISTRATION, &command_symbol->ref, NULL,
                          command, registration_id, registration_location);
        if (status < 0) break;
        status = walk_bridge_chain(index, scopes, links, link_count, command_scope, &edges);
    }

    free(wrappers);
    if (status < 0) {
        ContextBridgeSet failed = {edges.edges, edges.count, CHRONOS_COMPLETE};
        context_bridge_set_free(&failed);
        return status;
    }
    ChronosCoverage coverage = bridge_coverage(index);
    *out = (ContextBridgeSet){edges.edges, edges.count, coverage};
    return coverage == CHRONOS_COMPLETE ? CHRONOS_OK : CHRONOS_PARTIAL;
}

