#ifndef CHRONOS_AVATAR_H
#define CHRONOS_AVATAR_H

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && defined(CHRONOS_SHARED_BUILD)
#  define CHRONOS_API __declspec(dllexport)
#elif defined(_WIN32) && defined(CHRONOS_SHARED_IMPORT)
#  define CHRONOS_API __declspec(dllimport)
#else
#  define CHRONOS_API
#endif

/*
 * Status codes returned by the int-returning API functions.
 * Prefixed AVATAR_ so this header can share a translation unit with
 * backend/contracts/parser.h, whose ChronosStatus enum defines CHRONOS_OK.
 */
#define AVATAR_OK              0
#define AVATAR_ERR_ARGS       -1
#define AVATAR_ERR_GIT        -2
#define AVATAR_ERR_IO         -3
#define AVATAR_ERR_NOMEM      -4
#define AVATAR_ERR_FORBIDDEN  -5
#define AVATAR_ERR_SPAWN      -6

#define AVATAR_DEFAULT_MAX_COMMITS 500

/* Extracts commits, branches, file changes and touched symbols, and atomically
 * writes chronos_graph.json. max_commits <= 0 uses AVATAR_DEFAULT_MAX_COMMITS. */
CHRONOS_API int chronos_export_graph(const char* repo_path,
                                     const char* output_json_path,
                                     int max_commits);

/* Runs one whitelisted git command, then refreshes the graph JSON.
 * Returns a heap-allocated JSON string; free it with chronos_free_string().
 * Returns NULL only on out-of-memory. */
CHRONOS_API char* chronos_run_git_cmd(const char* repo_path,
                                      const char* git_args,
                                      const char* output_json_path);

/* Non-destructive merge analysis; writes the graph with mergeAnalysis.active. */
CHRONOS_API int chronos_analyze_merge(const char* repo_path,
                                      const char* source_branch,
                                      const char* target_branch,
                                      const char* output_json_path);

/* Thread-local description of the last failure ("" if none). */
CHRONOS_API const char* chronos_last_error(void);

CHRONOS_API void chronos_free_string(char* s);

CHRONOS_API const char* chronos_version(void);

#ifdef __cplusplus
}
#endif

#endif /* CHRONOS_AVATAR_H */