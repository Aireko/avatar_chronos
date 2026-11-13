#include "git_history.h"
#include "git_process.h"
#include "avatar.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *text_copy(const char *text, size_t length)
{
    if (length == SIZE_MAX) return NULL;
    char *copy = malloc(length + 1);
    if (copy != NULL) {
        memcpy(copy, text, length);
        copy[length] = '\0';
    }
    return copy;
}

static int valid_repo(const GitRepository *repo)
{
    return repo && repo->id && *repo->id && repo->local_path && *repo->local_path;
}

static int oid_valid(const char *oid)
{
    if (oid == NULL) return 0;
    size_t length = strlen(oid);
    return (length == 40 || length == 64) && strspn(oid, "0123456789abcdef") == length;
}

static int valid_revision(const GitRepository *repo, const RevisionRef *revision)
{
    return valid_repo(repo) && revision && revision->repository_id &&
           strcmp(repo->id, revision->repository_id) == 0 && oid_valid(revision->commit_sha);
}

static int copy_revision(RevisionRef *out, const char *repo, const char *oid)
{
    out->repository_id = text_copy(repo, strlen(repo));
    out->commit_sha = text_copy(oid, strlen(oid));
    return out->repository_id && out->commit_sha;
}

void git_revision_free(RevisionRef *revision)
{
    if (!revision) return;
    free((void *)revision->repository_id);
    free((void *)revision->commit_sha);
    *revision = (RevisionRef){0};
}

static int capture(const GitRepository *repo, const char *const *args, size_t count,
                   char **out, int *exit_code)
{
    size_t length;
    int status = chronos_git_capture(repo->local_path, args, count, out, &length, exit_code);
    if (status < 0) return status == AVATAR_ERR_NOMEM ? CHRONOS_OUT_OF_MEMORY : CHRONOS_IO_ERROR;
    if (*out == NULL) *out = text_copy("", 0);
    return *out != NULL ? CHRONOS_OK : CHRONOS_OUT_OF_MEMORY;
}

int git_resolve_revision(const GitRepository *repo, const char *selector, RevisionRef *out)
{
    if (!valid_repo(repo) || !selector || !*selector || !out) return CHRONOS_INVALID_ARGUMENT;
    size_t length = strlen(selector);
    if (length > SIZE_MAX - sizeof "^{commit}") return CHRONOS_TOO_LARGE;
    char *spec = malloc(length + sizeof "^{commit}");
    if (!spec) return CHRONOS_OUT_OF_MEMORY;
    memcpy(spec, selector, length);
    memcpy(spec + length, "^{commit}", sizeof "^{commit}");
    const char *args[] = {"rev-parse", "--verify", "-q", "--end-of-options", spec};
    char *oid = NULL;
    int exit_code;
    int status = capture(repo, args, 5, &oid, &exit_code);
    free(spec);
    if (status < 0) return status;
    oid[strcspn(oid, "\r\n")] = '\0';
    status = exit_code == 1 ? CHRONOS_NOT_FOUND : CHRONOS_IO_ERROR;
    if (exit_code == 0 && oid_valid(oid))
        status = copy_revision(out, repo->id, oid) ? CHRONOS_OK : CHRONOS_OUT_OF_MEMORY;
    free(oid);
    if (status < 0) git_revision_free(out);
    return status;
}

void git_revision_files_free(GitRevisionFiles *files)
{
    if (!files) return;
    for (size_t i = 0; i < files->path_count; ++i) free((void *)files->paths[i]);
    free((void *)files->paths);
    git_revision_free(&files->revision);
    *files = (GitRevisionFiles){0};
}

int git_list_revision_files(const GitRepository *repo, const RevisionRef *revision,
                            GitRevisionFiles *out)
{
    if (!valid_revision(repo, revision) || !out) return CHRONOS_INVALID_ARGUMENT;
    const char *args[] = {"ls-tree", "-r", "-z", "--full-tree", revision->commit_sha};
    char *bytes = NULL;
    size_t length;
    int code;
    int rc = chronos_git_capture(repo->local_path, args, 5, &bytes, &length, &code);
    if (rc != AVATAR_OK) return rc == AVATAR_ERR_NOMEM ? CHRONOS_OUT_OF_MEMORY : CHRONOS_IO_ERROR;
    int status = CHRONOS_IO_ERROR;
    if (code != 0) goto done;

    size_t count = 0;
    for (size_t i = 0; i < length; ++i) if (bytes[i] == '\0') ++count;
    const char **paths = count ? calloc(count, sizeof *paths) : NULL;
    out->paths = paths;
    status = CHRONOS_OUT_OF_MEMORY;
    if ((count && !paths) || !copy_revision(&out->revision, repo->id, revision->commit_sha)) goto done;
    for (size_t i = 0; i < length; i += strlen(bytes + i) + 1) {
        const char *record = bytes + i;
        const char *tab = strchr(record, '\t');
        if (!tab || tab == record || !tab[1]) {
            status = CHRONOS_IO_ERROR;
            goto done;
        }
        /* Include tracked regular files. A symlink's blob contains a path. */
        if (strncmp(record, "100", 3) != 0) continue;
        paths[out->path_count] = text_copy(tab + 1, strlen(tab + 1));
        if (!paths[out->path_count]) goto done;
        ++out->path_count;
    }
    status = CHRONOS_OK;
done:
    free(bytes);
    if (status < 0) git_revision_files_free(out);
    return status;
}

void git_blob_free(GitBlob *blob)
{
    if (!blob) return;
    git_revision_free(&blob->revision);
    free((void *)blob->file_path);
    free((void *)blob->bytes);
    *blob = (GitBlob){0};
}

int git_read_blob(const GitRepository *repo, const RevisionRef *revision,
                  const char *file_path, GitBlob *out)
{
    if (!valid_revision(repo, revision) || !file_path || !*file_path || !out)
        return CHRONOS_INVALID_ARGUMENT;
    size_t path_length = strlen(file_path);
    size_t prefix = strlen(revision->commit_sha) + 1;
    if (path_length >= SIZE_MAX - prefix) return CHRONOS_TOO_LARGE;
    char *spec = malloc(prefix + path_length + 1);
    if (!spec) return CHRONOS_OUT_OF_MEMORY;
    memcpy(spec, revision->commit_sha, prefix - 1);
    spec[prefix - 1] = ':';
    memcpy(spec + prefix, file_path, path_length + 1);
    const char *args[] = {"cat-file", "blob", spec};
    char *bytes = NULL;
    size_t length;
    int code;
    int status = chronos_git_capture(repo->local_path, args, 3, &bytes, &length, &code);
    free(spec);
    if (status != AVATAR_OK) return status == AVATAR_ERR_NOMEM ? CHRONOS_OUT_OF_MEMORY : CHRONOS_IO_ERROR;
    if (code != 0) {
        free(bytes);
        GitRevisionFiles inventory = {0};
        status = git_list_revision_files(repo, revision, &inventory);
        if (status < 0) return status;
        status = CHRONOS_NOT_FOUND;
        for (size_t i = 0; i < inventory.path_count; ++i)
            if (strcmp(inventory.paths[i], file_path) == 0) status = CHRONOS_IO_ERROR;
        git_revision_files_free(&inventory);
        return status;
    }

    out->bytes = (unsigned char *)bytes;
    out->byte_count = length;
    out->file_path = text_copy(file_path, path_length);
    if (!out->file_path || !copy_revision(&out->revision, repo->id, revision->commit_sha)) {
        git_blob_free(out);
        return CHRONOS_OUT_OF_MEMORY;
    }
    return CHRONOS_OK;
}

void git_changed_files_free(GitChangedFiles *changes)
{
    if (!changes) return;
    for (size_t i = 0; i < changes->file_count; ++i) {
        free((void *)changes->files[i].file_path);
        free((void *)changes->files[i].old_path);
    }
    free((void *)changes->files);
    git_revision_free(&changes->base);
    git_revision_free(&changes->head);
    *changes = (GitChangedFiles){0};
}

int git_list_changed_files(const GitRepository *repo, const RevisionRef *base,
                           const RevisionRef *head, GitChangedFiles *out)
{
    if (!valid_revision(repo, base) || !valid_revision(repo, head) || !out)
        return CHRONOS_INVALID_ARGUMENT;
    const char *args[] = {"diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv",
                          base->commit_sha, head->commit_sha, "--"};
    char *bytes = NULL;
    size_t length;
    int code;
    int rc = chronos_git_capture(repo->local_path, args, 9, &bytes, &length, &code);
    if (rc != AVATAR_OK) return rc == AVATAR_ERR_NOMEM ? CHRONOS_OUT_OF_MEMORY : CHRONOS_IO_ERROR;
    int status = CHRONOS_IO_ERROR;
    if (code != 0) goto done;

    size_t fields = 0;
    for (size_t i = 0; i < length; ++i) if (bytes[i] == '\0') ++fields;
    GitFileChange *files = fields ? calloc(fields / 2, sizeof *files) : NULL;
    out->files = files;
    status = CHRONOS_OUT_OF_MEMORY;
    if ((fields >= 2 && !files) || !copy_revision(&out->base, repo->id, base->commit_sha) ||
        !copy_revision(&out->head, repo->id, head->commit_sha)) goto done;

    for (size_t i = 0; i < length;) {
        const char *kind = bytes + i;
        i += strlen(kind) + 1;
        if (i >= length) { status = CHRONOS_IO_ERROR; goto done; }
        const char *path = bytes + i;
        i += strlen(path) + 1;
        GitFileChange *file = &files[out->file_count++];
        file->kind = GIT_FILE_MODIFIED;
        switch (*kind) {
        case 'A': file->kind = GIT_FILE_ADDED; break;
        case 'D': file->kind = GIT_FILE_DELETED; break;
        case 'R':
            if (i >= length) { status = CHRONOS_IO_ERROR; goto done; }
            file->kind = GIT_FILE_RENAMED;
            file->old_path = text_copy(path, strlen(path));
            if (!file->old_path) goto done;
            path = bytes + i;
            i += strlen(path) + 1;
            break;
        default: break;
        }
        file->file_path = text_copy(path, strlen(path));
        if (!file->file_path) goto done;
    }
    status = CHRONOS_OK;
done:
    free(bytes);
    if (status < 0) git_changed_files_free(out);
    return status;
}

static void free_commit(GitCommit *commit)
{
    git_revision_free(&commit->revision);
    free((void *)commit->author_name);
    free((void *)commit->authored_at);
    free((void *)commit->summary);
}

void git_file_history_free(GitFileHistory *history)
{
    if (!history) return;
    GitFileHistoryRecord *records = (GitFileHistoryRecord *)history->records;
    for (size_t i = 0; i < history->record_count; ++i) {
        free_commit(&records[i].commit);
        free((void *)records[i].change.file_path);
        free((void *)records[i].change.old_path);
    }
    free(records);
    *history = (GitFileHistory){0};
}

/* First-parent history for this exact path. Disable rename detection so
 * changes to another path cannot silently change the path being queried. */
int git_file_history(const GitRepository *repo, const RevisionRef *from,
                     const char *path, size_t limit, GitFileHistory *out)
{
    if (!valid_revision(repo, from) || !path || !*path || !out) return CHRONOS_INVALID_ARGUMENT;
    char max_count[sizeof(size_t) * 3 + sizeof "--max-count="];
    const char *args[] = {"--literal-pathspecs", "log", "--first-parent", "--diff-merges=first-parent",
                          "--no-renames", "--no-ext-diff", "--no-textconv",
                          "--name-status", "-z", "--format=%H%x00%an%x00%aI%x00%s",
                          NULL, NULL, NULL, NULL};
    size_t argc = 10;
    if (limit && limit != SIZE_MAX) {
        (void)snprintf(max_count, sizeof max_count, "--max-count=%zu", limit + 1);
        args[argc++] = max_count;
    }
    args[argc++] = from->commit_sha;
    args[argc++] = "--";
    args[argc++] = path;
    char *bytes = NULL;
    size_t length;
    int code;
    int rc = chronos_git_capture(repo->local_path, args, argc, &bytes, &length, &code);
    if (rc != AVATAR_OK) return rc == AVATAR_ERR_NOMEM ? CHRONOS_OUT_OF_MEMORY : CHRONOS_IO_ERROR;
    if (code != 0) { free(bytes); return CHRONOS_IO_ERROR; }

    GitFileHistoryRecord *records = NULL;
    size_t capacity = 0;
    int status = CHRONOS_OK;
    for (size_t offset = 0; offset < length;) {
        if (limit && out->record_count == limit) {
            out->coverage = CHRONOS_INCOMPLETE;
            status = CHRONOS_PARTIAL;
            break;
        }
        const char *fields[6];
        for (size_t i = 0; i < 6; ++i) {
            if (offset >= length) { status = CHRONOS_IO_ERROR; break; }
            fields[i] = bytes + offset;
            offset += strlen(fields[i]) + 1;
        }
        if (status < 0) break;
        if (!oid_valid(fields[0]) || strcmp(fields[5], path) != 0) {
            status = CHRONOS_IO_ERROR;
            break;
        }
        if (out->record_count == capacity) {
            size_t next = capacity ? capacity * 2 : 16;
            if (next < capacity || next > SIZE_MAX / sizeof *records) {
                status = CHRONOS_TOO_LARGE;
                break;
            }
            GitFileHistoryRecord *grown = realloc(records, next * sizeof *records);
            if (!grown) { status = CHRONOS_OUT_OF_MEMORY; break; }
            records = grown;
            out->records = records;
            capacity = next;
        }
        GitFileHistoryRecord *record = &records[out->record_count++];
        *record = (GitFileHistoryRecord){0};
        GitCommit *commit = &record->commit;
        commit->author_name = text_copy(fields[1], strlen(fields[1]));
        commit->authored_at = text_copy(fields[2], strlen(fields[2]));
        commit->summary = text_copy(fields[3], strlen(fields[3]));
        record->change.file_path = text_copy(path, strlen(path));
        const char *kind = fields[4] + strspn(fields[4], "\r\n");
        record->change.kind = *kind == 'A' ? GIT_FILE_ADDED :
                              *kind == 'D' ? GIT_FILE_DELETED : GIT_FILE_MODIFIED;
        if (!commit->author_name || !commit->authored_at || !commit->summary ||
            !record->change.file_path || !copy_revision(&commit->revision, repo->id, fields[0])) {
            status = CHRONOS_OUT_OF_MEMORY;
            break;
        }
    }
    free(bytes);
    if (status < 0) git_file_history_free(out);
    return status;
}