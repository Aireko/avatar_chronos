#ifndef CHRONOS_MAPPER_INTERNAL_H
#define CHRONOS_MAPPER_INTERNAL_H

#include "mapper.h"

typedef struct MapperLookup MapperLookup;

int mapper_lookup_build(const RepositoryGraph *graph, MapperLookup **out);
void mapper_lookup_free(MapperLookup *lookup);
const GraphSymbol *mapper_lookup_ref(const MapperLookup *lookup, const SymbolVersionRef *ref);
int mapper_resolve_call(const MapperLookup *lookup, GraphCall *call, const GraphSymbol *caller);

#endif