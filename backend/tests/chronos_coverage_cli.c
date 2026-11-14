/*
 * Language-coverage diagnostic CLI.
 *
 * Usage:
 *   chronos_coverage <repo> <selector>
 *
 * Prints the source inventory coverage and every diagnostic attached to the
 * index. Exits 1 when the revision has no supported source files so CI can
 * reject context compilation that would produce an empty graph.
 */
#include "index.h"

#include <stdio.h>
#include <string.h>

static void json_string(const char *text)
{
    putchar('"');
    if (text != NULL) {
        for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
            switch (*p) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\b': fputs("\\b", stdout); break;
            case '\f': fputs("\\f", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (*p < 0x20) printf("\\u%04x", (unsigned)*p);
                else putchar(*p);
                break;
            }
        }
    }
    putchar('"');
}

static int usage(void)
{
    fprintf(stderr, "usage: chronos_coverage <repo> <selector>\n");
    return 2;
}

int main(int argc, char **argv)
{
    if (argc != 3) return usage();
    const GitRepository repo = {argv[1], argv[1]};
    RepositoryIndex *index = NULL;
    int status = index_build_revision(&repo, argv[2], &index);
    if (status < 0) {
        fprintf(stderr, "chronos_coverage: index failed with status %d\n", status);
        return 1;
    }
    const RevisionRef *revision = index_revision(index);
    const IndexCoverage *coverage = index_coverage(index);
    if (revision == NULL || coverage == NULL) {
        fprintf(stderr, "chronos_coverage: index has no coverage metadata\n");
        index_free(index);
        return 1;
    }

    size_t diagnostic_count = 0;
    const ChronosDiagnostic *diagnostics = index_diagnostics(index, &diagnostic_count);
    static const char *const severities[] = {"info", "warning", "error"};

    fputs("{\"schemaVersion\":1,\"revision\":{\"repositoryId\":", stdout);
    json_string(revision->repository_id);
    fputs(",\"commitSha\":", stdout);
    json_string(revision->commit_sha);
    fputs("},\"coverage\":{\"sourceFiles\":", stdout);
    printf("%zu,\"supportedFiles\":%zu,\"unsupportedFiles\":%zu,"
           "\"sourceBytes\":%zu,\"supportedBytes\":%zu,\"unsupportedBytes\":%zu}",
           coverage->source_files, coverage->supported_files, coverage->unsupported_files,
           coverage->source_bytes, coverage->supported_bytes, coverage->unsupported_bytes);
    fputs(",\"diagnostics\":[", stdout);
    for (size_t i = 0; i < diagnostic_count; ++i) {
        const ChronosDiagnostic *item = &diagnostics[i];
        if (i != 0) putchar(',');
        fputs("{\"code\":", stdout);
        json_string(item->code);
        fputs(",\"severity\":", stdout);
        json_string((unsigned)item->severity < sizeof severities / sizeof severities[0]
                        ? severities[item->severity] : "error");
        fputs(",\"message\":", stdout);
        json_string(item->message);
        putchar('}');
    }
    fputs("]}\n", stdout);

    int result = coverage->supported_files == 0 ? 1 : 0;
    index_free(index);
    return result;
}
