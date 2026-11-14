#include "context_flow.h"
#include "parser.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FIXTURE_ROOT "tests/fixtures/context_flow/chronos_bridge"

typedef struct {
    char *bytes;
    size_t length;
    const char *path;
    ParsedFile parsed;
    GitBlob blob;
} FixtureFile;

static char *read_file(const char *relative, size_t *length)
{
    char path[512];
    (void)snprintf(path, sizeof path, "%s/%s.txt", FIXTURE_ROOT, relative);
    FILE *file = fopen(path, "rb");
    assert(file != NULL);
    assert(fseek(file, 0, SEEK_END) == 0);
    long size = ftell(file);
    assert(size >= 0);
    assert(fseek(file, 0, SEEK_SET) == 0);
    char *bytes = malloc((size_t)size + 1);
    assert(bytes != NULL);
    assert(fread(bytes, 1, (size_t)size, file) == (size_t)size);
    bytes[size] = '\0';
    fclose(file);
    *length = (size_t)size;
    return bytes;
}

static const ContextBridgeEdge *find_edge(const ContextBridgeSet *set,
                                          ContextBridgeKind kind, const char *label)
{
    for (size_t i = 0; i < set->count; ++i)
        if (set->edges[i].kind == kind && strcmp(set->edges[i].label, label) == 0)
            return &set->edges[i];
    return NULL;
}

static const char *ref_name(const RepositoryIndex *index, const SymbolVersionRef *ref)
{
    size_t scope = index_find_symbol(index, ref);
    if (scope == INDEX_NO_SCOPE) return NULL;
    const IndexScope *scopes = index_scopes(index, NULL);
    return scopes[scope].symbol->name;
}

static void assert_evidence_contains(const RepositoryIndex *index,
                                     const ContextBridgeEdge *edge, const char *needle)
{
    assert(edge->evidence_id != NULL && *edge->evidence_id != '\0');
    size_t length = 0;
    const char *bytes = index_file_bytes(index, edge->evidence.file_path, &length);
    assert(bytes != NULL);
    size_t start = edge->evidence.range.start_byte;
    size_t end = edge->evidence.range.end_byte;
    assert(start < end && end <= length);
    size_t needle_length = strlen(needle);
    assert(needle_length <= end - start);
    int found = 0;
    for (size_t i = start; i + needle_length <= end; ++i) {
        if (memcmp(bytes + i, needle, needle_length) == 0) {
            found = 1;
            break;
        }
    }
    assert(found);
}

int main(void)
{
    const RevisionRef revision = {
        "chronos/bridge-fixture", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    };
    const char *paths[] = {
        "src/backend.ts",
        "src-tauri/src/lib.rs",
        "src-tauri/src/ffi.rs",
        "backend/src/avatar.c"
    };
    FixtureFile files[4] = {0};
    IndexFileInput inputs[4] = {0};
    for (size_t i = 0; i < 4; ++i) {
        files[i].path = paths[i];
        files[i].bytes = read_file(paths[i], &files[i].length);
        assert(parser_parse(paths[i], &revision, files[i].bytes, files[i].length,
                            &files[i].parsed) >= 0);
        files[i].blob = (GitBlob){
            revision, paths[i], (const unsigned char *)files[i].bytes, files[i].length
        };
        inputs[i] = (IndexFileInput){&files[i].parsed, &files[i].blob};
    }

    RepositoryIndex *index = NULL;
    assert(index_build(&revision, inputs, 4, CHRONOS_COMPLETE, &index) >= 0);

    ContextBridgeSet bridges = {0};
    assert(context_discover_bridges(index, &bridges) == CHRONOS_OK);
    assert(bridges.count >= 9);
    for (size_t i = 0; i < bridges.count; ++i) {
        for (size_t j = i + 1; j < bridges.count; ++j)
            assert(strcmp(bridges.edges[i].evidence_id,
                          bridges.edges[j].evidence_id) != 0);
    }

    const ContextBridgeEdge *invoke = find_edge(&bridges, CONTEXT_BRIDGE_INVOKE,
                                                "backend_version");
    const ContextBridgeEdge *registration = find_edge(&bridges, CONTEXT_BRIDGE_REGISTRATION,
                                                      "backend_version");
    const ContextBridgeEdge *dispatch = find_edge(&bridges, CONTEXT_BRIDGE_DISPATCH, "version");
    const ContextBridgeEdge *ffi = find_edge(&bridges, CONTEXT_BRIDGE_FFI, "chronos_version");
    assert(invoke != NULL && registration != NULL && dispatch != NULL && ffi != NULL);

    assert(strcmp(ref_name(index, invoke->from), "backendVersion") == 0);
    assert(strcmp(ref_name(index, invoke->to), "backend_version") == 0);
    assert(strncmp(invoke->evidence_id, "call:v1:", 8) == 0);
    assert_evidence_contains(index, invoke, "\"backend_version\"");

    const ContextBridgeEdge *direct = NULL;
    for (size_t i = 0; i < bridges.count; ++i) {
        if (bridges.edges[i].kind == CONTEXT_BRIDGE_INVOKE &&
            strcmp(ref_name(index, bridges.edges[i].from), "directVersion") == 0)
            direct = &bridges.edges[i];
    }
    assert(direct != NULL);
    assert(strcmp(direct->label, "backend_version") == 0);
    assert_evidence_contains(index, direct, "\"backend_version\"");

    assert(strcmp(ref_name(index, registration->from), "backend_version") == 0);
    assert(registration->to == NULL);
    assert(strncmp(registration->evidence_id, "bridge:v1:register:", 19) == 0);
    assert_evidence_contains(index, registration, "backend_version");

    assert(strcmp(ref_name(index, dispatch->from), "backend_version") == 0);
    assert(strcmp(ref_name(index, dispatch->to), "version") == 0);
    assert(strncmp(dispatch->evidence_id, "call:v1:", 8) == 0);
    assert_evidence_contains(index, dispatch, "ffi::version");

    assert(strcmp(ref_name(index, ffi->from), "version") == 0);
    assert(strcmp(ref_name(index, ffi->to), "chronos_version") == 0);
    assert(strncmp(ffi->evidence_id, "call:v1:", 8) == 0);
    assert_evidence_contains(index, ffi, "chronos_version");

    const ContextBridgeEdge *invoke_export = find_edge(&bridges, CONTEXT_BRIDGE_INVOKE,
                                                       "export_graph");
    const ContextBridgeEdge *dispatch_export = find_edge(&bridges, CONTEXT_BRIDGE_DISPATCH,
                                                         "export_graph");
    const ContextBridgeEdge *ffi_export = find_edge(&bridges, CONTEXT_BRIDGE_FFI,
                                                    "chronos_export_graph");
    assert(invoke_export != NULL && dispatch_export != NULL && ffi_export != NULL);
    assert(strcmp(ref_name(index, invoke_export->from), "exportGraph") == 0);
    assert(strcmp(ref_name(index, invoke_export->to), "export_graph") == 0);
    assert_evidence_contains(index, invoke_export, "\"export_graph\"");
    /* The command and its FFI wrapper share a short name. The dispatch edge
     * must leave the registered command and arrive at the ffi.rs wrapper. */
    assert(strcmp(dispatch_export->from->id, invoke_export->to->id) == 0);
    assert(strcmp(dispatch_export->from->id, dispatch_export->to->id) != 0);
    assert_evidence_contains(index, dispatch_export, "ffi::export_graph");
    assert(strcmp(ref_name(index, ffi_export->to), "chronos_export_graph") == 0);
    assert_evidence_contains(index, ffi_export, "chronos_export_graph");

    context_bridge_set_free(&bridges);
    assert(bridges.edges == NULL && bridges.count == 0);

    index_free(index);
    for (size_t i = 0; i < 4; ++i) {
        parser_free(&files[i].parsed);
        free(files[i].bytes);
    }
    puts("Chronos invoke-registration-FFI bridge tests passed");
    return 0;
}
