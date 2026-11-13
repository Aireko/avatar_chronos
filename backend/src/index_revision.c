#include "index.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    GitBlob blob;
    ParsedFile parsed;
    ChronosDiagnostic diagnostic;
    SourceLocation location;
} RevisionFile;

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
    size_t count = 0;
    for (size_t i = 0; i < inventory.path_count; ++i)
        if (parser_language_for_path(inventory.paths[i])) ++count;

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
    if (next == count)
        status = index_build(&revision, inputs, count, inventory.coverage, out);
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