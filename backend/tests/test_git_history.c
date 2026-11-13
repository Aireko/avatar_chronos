#ifndef _XOPEN_SOURCE
#define _XOPEN_SOURCE 700
#endif

#include "git_history.h"
#include "git_process.h"

#include <assert.h>
#include <ftw.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char fixture[] = "/tmp/chronos-git-history-XXXXXX";

static int remove_entry(const char *path, const struct stat *info, int type, struct FTW *walk)
{
    (void)info;
    (void)type;
    (void)walk;
    return remove(path);
}

static void clean_fixture(void)
{
    if (nftw(fixture, remove_entry, 16, FTW_DEPTH | FTW_PHYS) != 0)
        perror(fixture);
}

static void git(const char *const *args, size_t count)
{
    char *bytes = NULL;
    size_t length = 0;
    int exit_code = -1;
    int status = chronos_git_capture(fixture, args, count, &bytes, &length, &exit_code);
    free(bytes);
    if (status != 0 || exit_code != 0)
        fprintf(stderr, "fixture git %s failed (status %d, exit %d)\n", args[0], status, exit_code);
    assert(status == 0 && exit_code == 0);
}

static void write_file(const char *name, const void *bytes, size_t length)
{
    char path[256];
    int used = snprintf(path, sizeof path, "%s/%s", fixture, name);
    assert(used > 0 && (size_t)used < sizeof path);
    FILE *file = fopen(path, "wb");
    assert(file != NULL);
    assert(fwrite(bytes, 1, length, file) == length);
    assert(fclose(file) == 0);
}

static int has_path(const GitRevisionFiles *inventory, const char *path)
{
    for (size_t i = 0; i < inventory->path_count; ++i)
        if (strcmp(inventory->paths[i], path) == 0) return 1;
    return 0;
}

static void assert_change(const GitChangedFiles *changes, const char *path, GitFileChangeKind kind,
                          const char *old_path)
{
    for (size_t i = 0; i < changes->file_count; ++i) {
        const GitFileChange *change = &changes->files[i];
        if (strcmp(change->file_path, path) != 0) continue;
        assert(change->kind == kind);
        if (old_path) assert(change->old_path && strcmp(change->old_path, old_path) == 0);
        else assert(change->old_path == NULL);
        return;
    }
    fprintf(stderr, "missing change for %s\n", path);
    assert(0);
}

int main(void)
{
    assert(mkdtemp(fixture) != NULL);
    assert(atexit(clean_fixture) == 0);
    const GitRepository repo = {"history-fixture", fixture};
    const char target[] = "data [1].bin";
    const unsigned char base_bytes[] = {0x00, 0xff, '\r', '\n'};
    const unsigned char head_bytes[] = {0x00, 0xfe, '\n', 0x00};
    const char *init[] = {"init", "-q", "-b", "main"};
    const char *name[] = {"config", "user.name", "History Fixture"};
    const char *email[] = {"config", "user.email", "history@example.invalid"};
    const char *add[] = {"add", "--all"};
    const char *base_commit[] = {"-c", "commit.gpgsign=false", "commit", "-qm", "initial files"};
    const char *tag[] = {"tag", "fixture-base"};
    git(init, 4);
    git(name, 3);
    git(email, 3);
    write_file(".gitattributes", "*.bin -text\n", sizeof "*.bin -text\n" - 1);
    write_file(target, base_bytes, sizeof base_bytes);
    write_file("data 1.bin", "decoy", 5);
    write_file("old name.txt", "identical contents\n", 19);
    write_file("removed.txt", "remove me\n", 10);
    git(add, 2);
    git(base_commit, 5);
    git(tag, 2);

    const char *branch[] = {"switch", "-qc", "side"};
    const char *side_commit[] = {"-c", "commit.gpgsign=false", "commit", "-qm", "side-only file"};
    const char *main_branch[] = {"switch", "-q", "main"};
    git(branch, 3);
    write_file("side.txt", "side\n", 5);
    git(add, 2);
    git(side_commit, 5);
    git(main_branch, 3);

    write_file(target, head_bytes, sizeof head_bytes);
    write_file("added.txt", "add me\n", 7);
    const char *rename_file[] = {"mv", "--", "old name.txt", "new name.txt"};
    const char *remove_file[] = {"rm", "-q", "--", "removed.txt"};
    const char *head_commit[] = {"-c", "commit.gpgsign=false", "commit", "-qm", "update files"};
    git(rename_file, 4);
    git(remove_file, 4);
    git(add, 2);
    git(head_commit, 5);
    const char *merge[] = {"-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "--no-edit", "side"};
    git(merge, 7);
    write_file(target, "dirty worktree", 14);
    write_file("untracked.txt", "untracked\n", 10);

    RevisionRef base = {0}, head = {0}, exact = {0}, missing = {0};
    assert(git_resolve_revision(&repo, "fixture-base", &base) == CHRONOS_OK);
    assert(git_resolve_revision(&repo, "main", &head) == CHRONOS_OK);
    assert(strcmp(base.repository_id, repo.id) == 0 && strcmp(base.commit_sha, head.commit_sha) != 0);
    assert(git_resolve_revision(&repo, head.commit_sha, &exact) == CHRONOS_OK);
    assert(strcmp(exact.commit_sha, head.commit_sha) == 0);
    assert(git_resolve_revision(&repo, "no-such-revision", &missing) == CHRONOS_NOT_FOUND);
    assert(!missing.repository_id && !missing.commit_sha);
    git_revision_free(&exact);

    GitRevisionFiles inventory = {0};
    assert(git_list_revision_files(&repo, &head, &inventory) == CHRONOS_OK);
    assert(inventory.coverage == CHRONOS_COMPLETE && inventory.path_count == 6);
    assert(strcmp(inventory.revision.commit_sha, head.commit_sha) == 0);
    assert(has_path(&inventory, target) && has_path(&inventory, "new name.txt"));
    assert(has_path(&inventory, "added.txt") && has_path(&inventory, "side.txt"));
    assert(!has_path(&inventory, "removed.txt") && !has_path(&inventory, "untracked.txt"));
    git_revision_files_free(&inventory);

    GitBlob blob = {0};
    assert(git_read_blob(&repo, &base, target, &blob) == CHRONOS_OK);
    assert(blob.byte_count == sizeof base_bytes && memcmp(blob.bytes, base_bytes, sizeof base_bytes) == 0);
    git_blob_free(&blob);
    assert(git_read_blob(&repo, &head, target, &blob) == CHRONOS_OK);
    assert(blob.byte_count == sizeof head_bytes && memcmp(blob.bytes, head_bytes, sizeof head_bytes) == 0);
    git_blob_free(&blob);
    assert(git_read_blob(&repo, &head, "removed.txt", &blob) == CHRONOS_NOT_FOUND);
    assert(!blob.bytes && blob.byte_count == 0);

    GitChangedFiles changes = {0};
    assert(git_list_changed_files(&repo, &base, &head, &changes) == CHRONOS_OK);
    assert(changes.coverage == CHRONOS_COMPLETE && changes.file_count == 5);
    assert_change(&changes, target, GIT_FILE_MODIFIED, NULL);
    assert_change(&changes, "added.txt", GIT_FILE_ADDED, NULL);
    assert_change(&changes, "side.txt", GIT_FILE_ADDED, NULL);
    assert_change(&changes, "removed.txt", GIT_FILE_DELETED, NULL);
    assert_change(&changes, "new name.txt", GIT_FILE_RENAMED, "old name.txt");
    git_changed_files_free(&changes);

    GitFileHistory history = {0};
    assert(git_file_history(&repo, &head, target, 1, &history) == CHRONOS_PARTIAL);
    assert(history.coverage == CHRONOS_INCOMPLETE && history.record_count == 1);
    assert(history.records[0].change.kind == GIT_FILE_MODIFIED);
    assert(strcmp(history.records[0].commit.summary, "update files") == 0);
    git_file_history_free(&history);
    assert(git_file_history(&repo, &head, target, 0, &history) == CHRONOS_OK);
    assert(history.coverage == CHRONOS_COMPLETE && history.record_count == 2);
    assert(history.records[1].change.kind == GIT_FILE_ADDED);
    assert(strcmp(history.records[1].commit.revision.commit_sha, base.commit_sha) == 0);
    assert(strcmp(history.records[1].commit.author_name, "History Fixture") == 0);
    git_file_history_free(&history);
    assert(git_file_history(&repo, &head, "side.txt", 0, &history) == CHRONOS_OK);
    assert(history.record_count == 1 && history.records[0].change.kind == GIT_FILE_ADDED);
    assert(strcmp(history.records[0].commit.revision.commit_sha, head.commit_sha) == 0);
    git_file_history_free(&history);
    assert(git_file_history(&repo, &head, "untracked.txt", 0, &history) == CHRONOS_OK);
    assert(history.coverage == CHRONOS_COMPLETE && history.record_count == 0);
    git_file_history_free(&history);

    git_revision_free(&base);
    git_revision_free(&head);
    puts("Git history tests passed");
    return 0;
}
