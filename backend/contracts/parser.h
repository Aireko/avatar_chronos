#ifndef CHRONOS_PARSER_H
#define CHRONOS_PARSER_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Internal C module statuses. Nonnegative results may carry diagnostics. */
typedef enum {
    CHRONOS_OK = 0,
    CHRONOS_PARTIAL = 1,
    CHRONOS_INVALID_ARGUMENT = -1,
    CHRONOS_NOT_FOUND = -2,
    CHRONOS_IO_ERROR = -3,
    CHRONOS_OUT_OF_MEMORY = -4,
    CHRONOS_NOT_IMPLEMENTED = -5,
    CHRONOS_TOO_LARGE = -6
} ChronosStatus;

/* A complete empty collection proves absence. Partial items are a subset.
 * An unavailable collection has a NULL pointer and zero count. */
typedef enum {
    CHRONOS_COMPLETE,
    CHRONOS_INCOMPLETE,
    CHRONOS_UNAVAILABLE
} ChronosCoverage;

/* Offsets into the original UTF-8 bytes, including original line endings.
 * Offsets are zero-based and end-exclusive. Lines are one-based, inclusive;
 * end_line is the line of the last included byte (the cursor if empty). */
typedef struct {
    size_t start_byte;
    size_t end_byte;
    size_t start_line;
    size_t end_line;
} SourceRange;

typedef struct {
    const char *repository_id;
    const char *commit_sha; /* Full lowercase Git object ID. */
} RevisionRef;

typedef struct {
    RevisionRef revision;
    const char *file_path; /* Exact repository-relative Git path. */
    SourceRange range;
} SourceLocation;

typedef enum {
    DIAGNOSTIC_INFO,
    DIAGNOSTIC_WARNING,
    DIAGNOSTIC_ERROR
} DiagnosticSeverity;

typedef struct {
    const char *code;
    DiagnosticSeverity severity;
    const char *message;
    const SourceLocation *location; /* NULL when unavailable. */
} ChronosDiagnostic;

/* Shared C ownership: inputs are borrowed for a call. Output structs are
 * caller-allocated and must start zeroed. Each output owns its nested data,
 * including copies of retained inputs, unless documented as a borrowed view.
 * Free outputs with their module's cleanup, which accepts NULL and resets
 * caller-owned structs. On failure outputs are empty and safe to clean up.
 * Strings are NUL-terminated UTF-8 unless supplied with a byte length.
 * Arrays use pointer/count pairs and are read-only to consumers. */

/* Native view of the supplied parser JSON. Field names map to the original
 * camelCase wire keys from the supplied json.txt. Existing wire keys and
 * values are preserved. Pointer/count fields represent JSON arrays. */
typedef struct {
    const char *name;
    const char *commit_hash;
    int is_head;
} ParserBranch;

typedef struct {
    const char *name;
    const char *kind;
    const char *change_type;
    size_t start_line;
    size_t end_line;
} ParserTouchedSymbol;

typedef struct {
    const char *path;
    const char *old_path;
    const char *status;
    size_t additions;
    size_t deletions;
    const ParserTouchedSymbol *symbols_touched;
    size_t symbol_count;
} ParserChangedFile;

typedef struct {
    const char *hash;
    const char *short_hash;
    const char *const *parents;
    size_t parent_count;
    const char *author;
    double timestamp;
    const char *message;
    const char *const *refs;
    size_t ref_count;
    const ParserChangedFile *files_changed;
    size_t file_count;
} ParserCommit;

typedef struct {
    const char *file_path;
    const char *symbol_name;
    const char *resolution_status;
    size_t ours_range[2];
    size_t theirs_range[2];
    const char *base_snippet;
    const char *ours_snippet;
    const char *theirs_snippet;
} ParserMergeConflict;

typedef struct {
    int active;
    const char *source_branch;
    const char *target_branch;
    const char *merge_base;
    int can_auto_merge;
    const ParserMergeConflict *conflicts;
    size_t conflict_count;
} ParserMergeAnalysis;

typedef struct {
    const char *repo_path;
    const char *head;
    double generated_at;
    const ParserBranch *branches;
    size_t branch_count;
    const ParserCommit *commits;
    size_t commit_count;
    ParserMergeAnalysis merge_analysis;
} ParserReport;

int parser_read_report(const char *json, size_t json_length, ParserReport *out);
void parser_report_free(ParserReport *report);

/* Proposed companion data for the indexer. The supplied JSON only lists
 * touched symbols. Indexing needs all parsed files at each revision,
 * including unchanged files, qualified names, byte ranges, parent and
 * caller IDs, raw calls, test candidates, coverage and diagnostics.
 * The Git analyzer supplies the stable repository ID, comparison pair,
 * and pinned source bytes. Confirm the existing report timestamp units,
 * line indexing and merge-commit diff semantics with the parser team. */
typedef size_t ParserSymbolId; /* Nonzero, unique within one ParsedFile. Zero means none. */

typedef enum {
    PARSER_FUNCTION,
    PARSER_CLASS,
    PARSER_METHOD
} ParserSymbolKind;

typedef enum {
    PARSER_DECLARATION,
    PARSER_DEFINITION
} ParserSymbolForm;

typedef struct {
    ParserSymbolId id;
    ParserSymbolId parent_id;
    ParserSymbolKind kind;
    ParserSymbolForm form;
    const char *name;
    const char *qualified_name;
    const char *signature; /* NULL when unavailable. */
    SourceRange range;
} ParsedSymbol;

typedef struct {
    ParserSymbolId enclosing_symbol_id; /* Zero at file scope. */
    const char *callee_text; /* Syntactic spelling of the callee expression. */
    SourceRange range; /* Entire call expression. */
} ParsedCall;

typedef struct {
    ParserSymbolId symbol_id;
    const char *reason; /* E.g. a naming convention or annotation. */
} ParsedTestCandidate;

typedef struct {
    RevisionRef revision;
    const char *file_path;
    const char *language;
    const char *source_sha256; /* NULL when unavailable. */
    size_t source_length;
    const ParsedSymbol *symbols;
    size_t symbol_count;
    const ParsedCall *calls;
    size_t call_count;
    const ParsedTestCandidate *test_candidates;
    size_t test_candidate_count;
    ChronosCoverage coverage;
    const ChronosDiagnostic *diagnostics;
    size_t diagnostic_count;
} ParsedFile;

/* Parses borrowed bytes. Partial syntax results may include diagnostics.
 * Calls and test candidates are syntactic observations only. */
int parser_parse(const char *file_path, const RevisionRef *revision,
                 const char *source, size_t source_length, ParsedFile *out);
void parser_free(ParsedFile *file);

#ifdef __cplusplus
}
#endif
#endif
