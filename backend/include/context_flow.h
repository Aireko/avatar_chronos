#ifndef CHRONOS_CONTEXT_FLOW_H
#define CHRONOS_CONTEXT_FLOW_H

#include "index.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CHRONOS_FLOW_DEFAULT_MAX_HOPS 3u
#define CHRONOS_FLOW_MAX_HOPS 32u
#define CHRONOS_FLOW_DEFAULT_MAX_FLOWS 8u
#define CHRONOS_FLOW_MAX_FLOWS 256u
#define CHRONOS_FLOW_DEFAULT_MAX_NODES 8u
#define CHRONOS_FLOW_MAX_NODES 64u

/*
 * Deterministic flow discovery, schema version 1.
 *
 * Onboarding seeds are recognized entry points: `main`, `run`, `start`,
 * `serve`, `init`, `handle_*`, `on_*`, and symbols in conventional entry
 * files such as main.*, app.*, index.*, server.*, and cli.*.
 * Task seeds are explicit symbols, explicit file paths, or changed symbols
 * supplied by the caller. Seeds are deduplicated.
 *
 * The walk is breadth-first and bounded by max_hops. Onboarding follows
 * callees downstream from entry points. Task mode visits callers before
 * callees so a changed symbol's directly affected callers outrank incidental
 * callees. Unresolved and ambiguous calls are not followed; they remain
 * direct-call evidence in ReviewContext.
 *
 * Rank is finite and in [0, 1]:
 *   proximity = max(0.1, 1.0 - 0.2 * hop)
 *   direction = 1.0 for a caller hop, 0.85 for a callee hop
 *   cross-module transition adds 0.12
 *   fan-in above 4 subtracts min(0.45, 0.09 * (fan_in - 4))
 *
 * A high-fan-in helper is therefore not promoted by fan-in alone, and a
 * non-seed high-fan-in node does not expand its incoming callers. Cycles are
 * collapsed by BFS visitation; set.collapsed_cycles counts back-edges to an
 * ancestor. Flow IDs are derived from the seed and target symbol IDs, never
 * from array position. Ties sort by ascending flow ID.
 */

typedef enum {
    CONTEXT_FLOW_ONBOARDING,
    CONTEXT_FLOW_TASK
} ContextFlowMode;

typedef enum {
    CONTEXT_FLOW_SEED_SYMBOL,
    CONTEXT_FLOW_SEED_PATH,
    CONTEXT_FLOW_SEED_CHANGED_SYMBOL
} ContextFlowSeedKind;

typedef struct {
    ContextFlowSeedKind kind;
    const SymbolVersionRef *symbol; /* SYMBOL and CHANGED_SYMBOL. */
    const char *path;               /* PATH: exact repository-relative path. */
} ContextFlowSeed;

typedef struct {
    ContextFlowMode mode;
    const ContextFlowSeed *seeds;
    size_t seed_count;
    size_t max_hops;  /* Zero uses CHRONOS_FLOW_DEFAULT_MAX_HOPS. */
    size_t max_flows; /* Zero uses CHRONOS_FLOW_DEFAULT_MAX_FLOWS. */
    size_t max_nodes; /* Zero uses CHRONOS_FLOW_DEFAULT_MAX_NODES. */
} ContextFlowRequest;

typedef struct {
    const GraphSymbol *symbol; /* Borrows the index. */
    size_t scope;              /* Index scope ID. */
    size_t hop;                /* Seed is zero. */
    double relevance;
    size_t fan_in;
    int is_seed;
    int via_incoming;   /* Reached by a caller edge. */
    int crossed_module; /* This hop crossed a module boundary. */
} ContextFlowNode;

typedef struct {
    const GraphCall *call;     /* Borrows the index. */
    const char *evidence_id;   /* Owned by the flow set. */
    size_t from;               /* Node index in path order. */
    size_t to;
    int forward;               /* 1 when call->caller is nodes[from]. */
} ContextFlowEdge;

typedef struct {
    const char *id;            /* Owned by the flow set. */
    const GraphSymbol *seed;   /* Borrows the index. */
    double relevance;
    const ContextFlowNode *nodes;
    size_t node_count;
    const ContextFlowEdge *edges;
    size_t edge_count;
} ContextFlow;

typedef struct {
    ContextFlow *flows;          /* Owns flows and their nested arrays. */
    size_t count;
    const GraphSymbol **seeds;   /* Borrows the index. Deduplicated. */
    size_t seed_count;
    size_t collapsed_cycles;
    ChronosCoverage coverage;    /* Resolved call discovery coverage. */
} ContextFlowSet;

/* Start out zeroed. A request with no resolvable task seed returns
 * CHRONOS_NOT_FOUND. Onboarding with no entry points returns an empty set.
 * Output is deterministic for the same index and request. */
int context_discover_flows(const RepositoryIndex *index, const ContextFlowRequest *request,
                           ContextFlowSet *out);
void context_flow_set_free(ContextFlowSet *flows);

/*
 * One evidence-backed bridge pattern: Tauri `invoke`/wrapper string ->
 * registered Rust command -> Rust dispatch -> FFI/C symbol.
 *
 * The detector accepts a direct `invoke("command")` call or a call to a
 * frontend wrapper function whose body calls `invoke` with a string literal
 * at the callsite. A command must appear in a `generate_handler![...]`
 * registration. Rust calls are followed by exact or last-segment name; a
 * call that leaves Rust for a C symbol becomes a `CONTEXT_BRIDGE_FFI` edge.
 *
 * Every edge carries a stable evidence ID and the pinned source location of
 * the matching callsite or registration identifier. The index must outlive
 * the bridge set because symbols and calls are borrowed.
 */
typedef enum {
    CONTEXT_BRIDGE_INVOKE,      /* frontend callsite -> Rust command */
    CONTEXT_BRIDGE_REGISTRATION,/* command identifier in generate_handler! */
    CONTEXT_BRIDGE_DISPATCH,    /* Rust command -> Rust helper */
    CONTEXT_BRIDGE_FFI          /* Rust helper -> C symbol */
} ContextBridgeKind;

typedef struct {
    ContextBridgeKind kind;
    const SymbolVersionRef *from; /* Borrows the index. */
    const SymbolVersionRef *to;   /* NULL for a registration edge. */
    const char *label;            /* Owned by the bridge set. */
    const char *evidence_id;      /* Owned by the bridge set. */
    SourceLocation evidence;      /* Pinned callsite or identifier range. */
} ContextBridgeEdge;

typedef struct {
    ContextBridgeEdge *edges;
    size_t count;
    ChronosCoverage coverage; /* COMPLETE when every relevant file was readable. */
} ContextBridgeSet;

int context_discover_bridges(const RepositoryIndex *index, ContextBridgeSet *out);
void context_bridge_set_free(ContextBridgeSet *set);

#ifdef __cplusplus
}
#endif
#endif /* CHRONOS_CONTEXT_FLOW_H */
