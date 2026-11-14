#ifndef CHRONOS_AVATAR_H
#define CHRONOS_AVATAR_H

#include <stddef.h>
#include <stdint.h>

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
 * backend/include/parser.h, whose ChronosStatus enum defines CHRONOS_OK.
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

/* Compiles the agent brief and UI graph for one revision. mode is
 * "onboarding" or "task" (review is accepted as a task alias). Task mode
 * requires path and qualified_name. The result is a heap JSON object with
 * brief and graph documents; free it with chronos_free_string(). Returns
 * AVATAR_OK, a nonnegative partial status, or a negative AVATAR_* code. On
 * error *out_json is NULL. max_items/max_source_bytes of zero use defaults. */
CHRONOS_API int chronos_compile_views(const char* repo_path,
                                      const char* revision,
                                      const char* mode,
                                      const char* path,
                                      const char* qualified_name,
                                      size_t max_items,
                                      size_t max_source_bytes,
                                      char** out_json);

/* Multi-target variant of chronos_compile_views(). Task mode compiles 1..64
 * path/qualified targets into one combined brief and graph with one evidence
 * catalog and one global budget. Onboarding ignores the target arrays. */
CHRONOS_API int chronos_compile_multi_views(const char* repo_path,
                                            const char* revision,
                                            const char* mode,
                                            const char* const* paths,
                                            const char* const* qualified_names,
                                            size_t target_count,
                                            size_t max_items,
                                            size_t max_source_bytes,
                                            char** out_json);

/* Opaque app session: compile once, then fetch the brief, pages and evidence
 * source lazily. Handles are process-local and must be closed. Calls are
 * serialized by the existing Rust backend lock. */
CHRONOS_API int chronos_views_open(const char* repo_path,
                                   const char* revision,
                                   const char* mode,
                                   const char* const* paths,
                                   const char* const* qualified_names,
                                   size_t target_count,
                                   size_t max_items,
                                   size_t max_source_bytes,
                                   uint64_t* out_handle);
CHRONOS_API int chronos_views_brief(uint64_t handle, char** out_json);
CHRONOS_API int chronos_views_page(uint64_t handle,
                                   int kind,
                                   const char* parent_scope_id,
                                   size_t node_offset,
                                   size_t edge_offset,
                                   size_t evidence_offset,
                                   size_t max_nodes,
                                   size_t max_edges,
                                   size_t max_evidence,
                                   char** out_json);
CHRONOS_API int chronos_views_source(uint64_t handle, const char* evidence_id,
                                     char** out_json);
CHRONOS_API void chronos_views_close(uint64_t handle);

/* Bounded call neighborhood of one function at a pinned revision (revision may
 * be empty for HEAD). `name` is a qualified name (Class::method) or a short
 * name; `path` is the repository-relative file. Append "#<line>" to the name to
 * pick the definition that starts on that line. The result is a heap JSON
 * object (free it with chronos_free_string()):
 *   { schemaVersion, status: "ok" | "ambiguous" | "not_found", revision,
 *     candidates: [...]                       (ambiguous / not_found only)
 *     maxDepth, maxNodes, truncated, coverage, root: "n0",
 *     nodes: [{ id, side: root|caller|callee, depth, parent, hasMore, symbol,
 *               name, qualifiedName, kind, filePath, startLine, endLine,
 *               startByte, endByte }],
 *     edges: [{ id, from, to, side, state: resolved|ambiguous|unresolved,
 *               calleeText, callCount, callSites, candidateCount, candidates }] }
 * Edges run from caller to callee; `to` is null for unresolved and ambiguous
 * calls. max_depth 0 means 2 (cap 6); max_nodes 0 means 48 (cap 256). The index
 * is cached for the last repository and commit, so repeated calls are cheap.
 * "ambiguous" and "not_found" are successful results, not errors. */
CHRONOS_API int chronos_call_tree(const char* repo_path,
                                  const char* revision,
                                  const char* path,
                                  const char* name,
                                  size_t max_depth,
                                  size_t max_nodes,
                                  char** out_json);

/* Reads pinned source bytes for start_byte..end_byte and returns a heap JSON
 * object with repository, revision, path, range and source. revision may be
 * empty for HEAD. Free the result with chronos_free_string(). */
CHRONOS_API int chronos_read_source(const char* repo_path,
                                    const char* revision,
                                    const char* file_path,
                                    size_t start_byte,
                                    size_t end_byte,
                                    char** out_json);

/* Who wrote each line of one file at `revision` (NULL or "" means HEAD), from
 * `git blame --porcelain -w -M`. `file_path` is relative to the repository
 * root. On success sets *out_json to a heap-allocated JSON string (free it with
 * chronos_free_string()):
 *   { repoPath, path, revision, totalLines,
 *     authors:  [{ name, email, lines, commits, lastTime, lastCommit, lastSummary }],  most lines first
 *     commits:  [{ hash, author, email, time, summary, lines }],                       newest first
 *     ranges:   [{ start, end, commit }],     consecutive lines last changed by one commit
 *     symbols:  [{ name, kind, startLine, endLine }] }   functions/classes detected in the file
 * Authors are grouped by email (case-insensitive), or by name when there is no
 * email. Lines are 1-based and inclusive. */
CHRONOS_API int chronos_blame(const char* repo_path,
                              const char* file_path,
                              const char* revision,
                              char** out_json);

/* Thread-local description of the last failure ("" if none). */
CHRONOS_API const char* chronos_last_error(void);

CHRONOS_API void chronos_free_string(char* s);

CHRONOS_API const char* chronos_version(void);

#ifdef __cplusplus
}
#endif

#endif /* CHRONOS_AVATAR_H */