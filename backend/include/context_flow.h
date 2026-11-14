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

/* Deterministic bounded flow discovery. Onboarding walks callees from
 * recognized entry points; task mode walks callers before callees from
 * explicit seeds. Rank uses hop proximity, direction, cross-module transitions
 * and a fan-in penalty. Cycles collapse at the first visited node. */

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

/* Starts zeroed. No resolvable task seed returns CHRONOS_NOT_FOUND. */
int context_discover_flows(const RepositoryIndex *index, const ContextFlowRequest *request,
                           ContextFlowSet *out);
void context_flow_set_free(ContextFlowSet *flows);

/* Chronos bridge: invoke/wrapper -> registered Tauri command -> Rust dispatch
 * -> FFI/C symbol. Each edge has a stable evidence ID and pinned location. */
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
