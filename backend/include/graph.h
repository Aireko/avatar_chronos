#ifndef CHRONOS_GRAPH_H
#define CHRONOS_GRAPH_H

#include "parser.h" /* Shared source and symbol types. */

#ifdef __cplusplus
extern "C" {
#endif

#define CHRONOS_GRAPH_SCHEMA_VERSION 1

/* Full identity: (repository_id, commit_sha, id). id is the compact JSON
 * array string [filePath, qualifiedName, kind, form, startByte, endByte],
 * using JSON.stringify escaping. Coalesce identical tuples. */
typedef struct {
    RevisionRef revision;
    const char *id;
} SymbolVersionRef;

typedef enum {
    SYMBOL_ADDED,
    SYMBOL_MODIFIED,
    SYMBOL_DELETED,
    SYMBOL_UNCHANGED
} SymbolChangeKind;

typedef struct {
    SymbolVersionRef ref;
    const char *logical_id; /* Compact JSON array [filePath, qualifiedName], scoped to repo. */
    const char *name;
    const char *qualified_name;
    const char *signature; /* NULL if unavailable. */
    const char *language;
    ParserSymbolKind kind;
    ParserSymbolForm form;
    const SymbolVersionRef *parent;
    SourceLocation location;
    const char *source_sha256; /* Hash of the symbol bytes, or NULL. */
    const SymbolChangeKind *change;
} GraphSymbol;

typedef enum {
    CALL_RESOLVED,
    CALL_UNRESOLVED,
    CALL_AMBIGUOUS
} CallResolution;

typedef struct {
    SymbolVersionRef caller;
    const char *callee_text;
    SourceLocation call_site;
    CallResolution resolution;
    const SymbolVersionRef *callee; /* Present only for resolved calls. */
    const SymbolVersionRef *candidates; /* At least two for ambiguous calls. */
    size_t candidate_count; /* Zero for resolved and unresolved calls. */
} GraphCall;

typedef struct {
    RevisionRef base;
    RevisionRef head;
} GraphComparison;

/* One revision per graph. Every referenced version resolves in its nodes.
 * Omit file-scope calls. Compare exact paths and qualified names across
 * revisions, then compare symbol bytes for a unique pair. A NULL logical_id
 * means uncertain identity. A NULL change means no comparison or insufficient
 * evidence. Only complete evidence establishes additions or deletions.
 * Annotate added symbols on the head graph and deleted symbols on the base. */
typedef struct {
    RevisionRef revision;
    const GraphComparison *comparison;
    const GraphSymbol *nodes;
    size_t node_count;
    ChronosCoverage node_coverage;
    const GraphCall *edges;
    size_t edge_count;
    ChronosCoverage edge_coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} RepositoryGraph;

/* graph.json v1: schemaVersion, repositoryId (from revision), revision,
 * comparison, nodes, edges, diagnostics. Map other fields to camelCase.
 * Nodes and edges serialize as {status, items}; status is "complete",
 * "incomplete", or "unavailable". Use null items only for unavailable data.
 * Serialize nullable values as null, known-empty lists as [], and enums as
 * lowercase strings ("function", "declaration", "resolved", "modified", etc.).
 * Rust/Tauri passes UTF-8 JSON to the frontend through the existing boundary. */

/* CHRONOS_TOO_LARGE is a graph serialization error for lengths above
 * INT_MAX or source coordinates outside JSON's safe-integer range. */
#define CHRONOS_TOO_LARGE (-6)

/* Serialize a graph in its supplied order. The graph must satisfy the
 * reference rules above and contain valid UTF-8 strings. It is borrowed
 * for the call, must remain unchanged, and cannot overlap out.
 * Returns byte length excluding NUL. Query with NULL, 0. A short buffer
 * returns the required length and is untouched. A sufficient buffer is
 * NUL-terminated. On error, return a negative code and leave out untouched. */
int graph_write_json(const RepositoryGraph *graph, char *out, size_t out_size);

#ifdef __cplusplus
}
#endif
#endif
