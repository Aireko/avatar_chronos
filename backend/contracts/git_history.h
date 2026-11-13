#ifndef CHRONOS_GIT_HISTORY_H
#define CHRONOS_GIT_HISTORY_H

#include "parser.h" /* Shared revision, coverage and diagnostic types. */

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const char *id;
    const char *local_path;
} GitRepository;

typedef enum {
    GIT_FILE_ADDED,
    GIT_FILE_MODIFIED,
    GIT_FILE_DELETED,
    GIT_FILE_RENAMED
} GitFileChangeKind;

typedef struct {
    const char *file_path; /* Head path for a rename, base path for a deletion. */
    const char *old_path; /* Base path for a rename, otherwise NULL. */
    GitFileChangeKind kind;
} GitFileChange;

typedef struct {
    RevisionRef base;
    RevisionRef head;
    const GitFileChange *files;
    size_t file_count;
    ChronosCoverage coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} GitChangedFiles;

typedef struct {
    RevisionRef revision;
    const char *file_path;
    const unsigned char *bytes; /* May contain NUL or non-UTF-8 bytes. */
    size_t byte_count;
} GitBlob;

typedef struct {
    RevisionRef revision;
    const char *const *paths; /* Tracked blob paths at this commit. */
    size_t path_count;
    ChronosCoverage coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} GitRevisionFiles;

typedef struct {
    RevisionRef revision;
    const char *author_name;
    const char *authored_at; /* ISO 8601 with time zone. */
    const char *summary;
} GitCommit;

typedef struct {
    GitCommit commit;
    GitFileChange change;
} GitFileHistoryRecord;

typedef struct {
    const GitFileHistoryRecord *records;
    size_t record_count;
    ChronosCoverage coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} GitFileHistory;

/* A selector can be a branch, tag, or SHA. All other APIs take resolved
 * revisions from this repository. Paths are exact, case-sensitive Git paths
 * relative to the repository root, with '/' separators.
 * History is newest first along first parents and includes 'from'.
 * limit > 0 caps records, with INCOMPLETE coverage if truncated. */
int git_resolve_revision(const GitRepository *repo, const char *selector, RevisionRef *out);
int git_list_revision_files(const GitRepository *repo, const RevisionRef *revision,
                            GitRevisionFiles *out);
int git_list_changed_files(const GitRepository *repo, const RevisionRef *base,
                           const RevisionRef *head, GitChangedFiles *out);
/* CHRONOS_NOT_FOUND means absent at this revision; I/O errors are separate. */
int git_read_blob(const GitRepository *repo, const RevisionRef *revision,
                  const char *file_path, GitBlob *out);
int git_file_history(const GitRepository *repo, const RevisionRef *from,
                     const char *file_path, size_t limit, GitFileHistory *out);
void git_revision_free(RevisionRef *revision);
void git_revision_files_free(GitRevisionFiles *files);
void git_changed_files_free(GitChangedFiles *changes);
void git_blob_free(GitBlob *blob);
void git_file_history_free(GitFileHistory *history);

#ifdef __cplusplus
}
#endif
#endif
