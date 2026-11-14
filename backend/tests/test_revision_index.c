#include "index.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const GraphSymbol *find(const RepositoryGraph *graph, const char *name)
{
    for (size_t i = 0; i < graph->node_count; ++i)
        if (strcmp(graph->nodes[i].qualified_name, name) == 0) return &graph->nodes[i];
    return NULL;
}

static void assert_change(const RepositoryGraph *graph, const char *name, SymbolChangeKind kind)
{
    const GraphSymbol *node = find(graph, name);
    assert(node && node->change && *node->change == kind);
}

/* The repository fixture contains two commits. The worktree may be dirty. */
int main(int argc, char **argv)
{
    assert(argc == 2);
    const GitRepository repo = {"test/repo", argv[1]};
    RepositoryIndex *base = NULL, *head = NULL;
    assert(index_build_revision(&repo, "HEAD^", &base) == CHRONOS_OK);
    assert(index_build_revision(&repo, "HEAD", &head) == CHRONOS_OK);
    const IndexCoverage *coverage = index_coverage(head);
    assert(coverage != NULL && coverage->source_files == 6 &&
           coverage->supported_files == 6 && coverage->unsupported_files == 0 &&
           coverage->source_bytes > 0 && coverage->supported_bytes == coverage->source_bytes);
    size_t diagnostic_count = 0;
    const ChronosDiagnostic *diagnostics = index_diagnostics(head, &diagnostic_count);
    int found_coverage = 0;
    for (size_t i = 0; i < diagnostic_count; ++i) {
        if (strcmp(diagnostics[i].code, "language-coverage") != 0) continue;
        assert(diagnostics[i].severity == DIAGNOSTIC_INFO);
        assert(strstr(diagnostics[i].message, "Indexed 6 of 6 source files") != NULL);
        found_coverage = 1;
    }
    assert(found_coverage);
    GitChangedFiles files = {0};
    assert(git_list_changed_files(&repo, index_revision(base), index_revision(head), &files) == CHRONOS_OK);
    assert(files.file_count == 1 && files.files[0].kind == GIT_FILE_MODIFIED);
    assert(strcmp(files.files[0].file_path, "shared/x [1].c") == 0);

    GitFileHistory history = {0};
    assert(git_file_history(&repo, index_revision(head), files.files[0].file_path, 1, &history) == CHRONOS_PARTIAL);
    assert(history.coverage == CHRONOS_INCOMPLETE && history.record_count == 1);
    assert(history.records[0].change.kind == GIT_FILE_MODIFIED);
    git_file_history_free(&history);
    assert(git_file_history(&repo, index_revision(head), files.files[0].file_path, 0, &history) == CHRONOS_OK);
    assert(history.record_count == 2 && history.records[1].change.kind == GIT_FILE_ADDED);
    git_file_history_free(&history);

    IndexChangeSet changes = {0};
    RepositoryGraph current = {0}, previous = {0};
    assert(index_compare_revisions(base, head, &files, &changes) == CHRONOS_OK);
    assert(index_export_graph(head, &changes, &current) == CHRONOS_OK);
    assert(index_export_graph(base, &changes, &previous) == CHRONOS_OK);
    index_change_set_free(&changes);
    git_changed_files_free(&files);
    assert_change(&current, "work", SYMBOL_UNCHANGED);
    assert_change(&current, "helper", SYMBOL_MODIFIED);
    assert_change(&current, "added", SYMBOL_ADDED);
    assert_change(&previous, "removed", SYMBOL_DELETED);

    const GraphSymbol *work = find(&current, "work");
    IndexContext context = {0};
    assert(index_collect_context(head, &work->ref, &context) == CHRONOS_OK);
    assert(context.candidates.count == 1);
    const ContextCandidate *candidate = &context.candidates.items[0];
    assert(candidate->direction == CONTEXT_OUTGOING_CALL);
    assert(strncmp(candidate->id, "call:v1:", 8) == 0);
    assert(candidate->call->resolution == CALL_RESOLVED);
    assert(candidate->snippet.status == CONTEXT_SOURCE_PRESENT);
    const char source[] = "int helper(void) { return 2; }";
    assert(candidate->snippet.byte_count == sizeof source - 1);
    assert(memcmp(candidate->snippet.bytes, source, sizeof source - 1) == 0);
    index_context_free(&context);

    const GraphSymbol *method = find(&current, "Service::run");
    assert(method && method->parent && method->kind == PARSER_METHOD);
    assert(find(&current, "App") && find(&current, "rust_helper") && find(&current, "page"));
    index_free(base);
    index_free(head);
    index_graph_free(&previous);
    index_graph_free(&current);
    puts("pinned revision, history, and index context passed");
    return 0;
}
