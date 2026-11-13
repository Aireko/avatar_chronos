/* Manual test driver for the Chronos backend. Not part of the Tauri build. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "avatar.h"

static int usage(void)
{
    fprintf(stderr,
        "usage:\n"
        "  chronos_cli version\n"
        "  chronos_cli graph <repo> <out.json> [maxCommits]\n"
        "  chronos_cli run   <repo> \"<git args>\" <out.json>\n"
        "  chronos_cli merge <repo> <sourceBranch> <targetBranch> <out.json>\n");
    return 2;
}

static int report(const char* what, int rc)
{
    if (rc == AVATAR_OK) {
        printf("%s: OK\n", what);
        return 0;
    }
    fprintf(stderr, "%s: FAILED (code %d): %s\n", what, rc, chronos_last_error());
    return 1;
}

int main(int argc, char** argv)
{
    if (argc < 2) return usage();
    if (strcmp(argv[1], "version") == 0) {
        printf("%s\n", chronos_version());
        return 0;
    }
    if (strcmp(argv[1], "graph") == 0 && argc >= 4) {
        return report("graph", chronos_export_graph(argv[2], argv[3], argc >= 5 ? atoi(argv[4]) : 0));
    }
    if (strcmp(argv[1], "run") == 0 && argc >= 5) {
        char* result = chronos_run_git_cmd(argv[2], argv[3], argv[4]);
        if (!result) {
            fprintf(stderr, "run: FAILED: %s\n", chronos_last_error());
            return 1;
        }
        printf("%s\n", result);
        chronos_free_string(result);
        return 0;
    }
    if (strcmp(argv[1], "merge") == 0 && argc >= 6) {
        return report("merge", chronos_analyze_merge(argv[2], argv[3], argv[4], argv[5]));
    }
    return usage();
}