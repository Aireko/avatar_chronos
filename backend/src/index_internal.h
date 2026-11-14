#ifndef CHRONOS_INDEX_INTERNAL_H
#define CHRONOS_INDEX_INTERNAL_H

#include "index.h"

/* Attach repository inventory coverage and append the language-coverage
 * diagnostic. Called once by index_build_revision. */
int index_set_coverage(RepositoryIndex *index, const IndexCoverage *coverage);

#endif
