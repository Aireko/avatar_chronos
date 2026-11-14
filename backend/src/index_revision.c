#include "index.h"
#include "index_internal.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    GitBlob blob;
    ParsedFile parsed;
    ChronosDiagnostic diagnostic;
    SourceLocation location;
} RevisionFile;

static int known_source_extension(const char *path)
{
    static const char *const extensions[] = {
        ".go", ".java", ".kt", ".kts",
        ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx",
        ".cs", ".rb", ".php", ".swift", ".scala", ".m", ".mm",
        ".lua", ".sh", ".bash", ".zsh", ".sql", ".dart",
        ".ex", ".exs", ".erl", ".hrl", ".fs", ".fsx", ".jl",
        ".pl", ".pm", ".r", ".R", ".clj", ".cljs", ".hs", ".lhs",
        ".ml", ".mli", ".nim", ".zig", ".sol", ".asm", ".s", ".S",
        ".vue", ".svelte", NULL
    };
    const char *suffix = strrchr(path, '.');
    if (suffix == NULL) return 0;
    for (size_t i = 0; extensions[i] != NULL; ++i)
        if (strcmp(suffix, extensions[i]) == 0) return 1;
    return 0;
}

static void add_source_coverage(IndexCoverage *coverage, int supported, size_t bytes)
{
    ++coverage->source_files;
    coverage->source_bytes += bytes;
    if (supported) {
        ++coverage->supported_files;
        coverage->supported_bytes += bytes;
    } else {
        ++coverage->unsupported_files;
        coverage->unsupported_bytes += bytes;
    }
}

int index_build_revision(const GitRepository *repo, const char *selector, RepositoryIndex **out)
{
    if (!out) return CHRONOS_INVALID_ARGUMENT;
    *out = NULL;
    RevisionRef revision = {0};
    GitRevisionFiles inventory = {0};
    int status = git_resolve_revision(repo, selector, &revision);
    if (status < 0) return status;
    status = git_list_revision_files(repo, &revision, &inventory);
    if (status < 0) goto done;
    IndexCoverage coverage = {0};
    for (size_t i = 0; i < inventory.path_count; ++i) {
        const char *path = inventory.paths[i];
        int supported = parser_language_for_path(path) != NULL;
        if (!supported && !known_source_extension(path)) continue;
        size_t bytes = inventory.byte_counts ? inventory.byte_counts[i] : 0;
        add_source_coverage(&coverage, supported, bytes);
    }
    size_t count = coverage.supported_files;

    RevisionFile *files = count ? calloc(count, sizeof *files) : NULL;
    IndexFileInput *inputs = count ? calloc(count, sizeof *inputs) : NULL;
    if (count && (!files || !inputs)) {
        free(files);
        free(inputs);
        status = CHRONOS_OUT_OF_MEMORY;
        goto done;
    }
    static const ChronosDiagnostic unavailable = {
        "source-unavailable", DIAGNOSTIC_WARNING, "Source could not be read or parsed", NULL
    };
    size_t next = 0;
    for (size_t i = 0; i < inventory.path_count; ++i) {
        const char *path = inventory.paths[i];
        const char *language = parser_language_for_path(path);
        if (!language) continue;
        RevisionFile *file = &files[next];
        status = git_read_blob(repo, &revision, path, &file->blob);
        if (status >= 0) {
            status = parser_parse(path, &revision, (const char *)file->blob.bytes,
                                  file->blob.byte_count, &file->parsed);
        }
        if (status == CHRONOS_OUT_OF_MEMORY) break;
        if (status < 0) {
            file->location = (SourceLocation){revision, path, {0, 0, 1, 1}};
            file->diagnostic = unavailable;
            file->diagnostic.location = &file->location;
            /* Borrow the inventory entry until index_build copies it. */
            file->parsed = (ParsedFile){.revision = revision, .file_path = path, .language = language,
                                      .coverage = CHRONOS_UNAVAILABLE, .diagnostics = &file->diagnostic,
                                      .diagnostic_count = 1};
        }
        inputs[next++] = (IndexFileInput){&file->parsed, status >= 0 ? &file->blob : NULL};
    }
    if (next == count) {
        status = index_build(&revision, inputs, count, inventory.coverage, out);
        if (status >= 0) {
            int coverage_status = index_set_coverage(*out, &coverage);
            if (coverage_status < 0) {
                index_free(*out);
                *out = NULL;
                status = coverage_status;
            }
        }
    }
    for (size_t i = 0; i < count; ++i) {
        if (files[i].parsed.coverage != CHRONOS_UNAVAILABLE) parser_free(&files[i].parsed);
        git_blob_free(&files[i].blob);
    }
    free(inputs);
    free(files);
done:
    git_revision_files_free(&inventory);
    git_revision_free(&revision);
    return status;
}