/*
 * avatar.h - public API of the C backend.
 *
 * src-tauri/build.rs compiles every .c file in backend/src into a static
 * library that is linked into the Tauri app. Rust calls these functions
 * through the hand-written bindings in src-tauri/src/ffi.rs, so any change
 * here must be mirrored there (signatures, struct layout, constants).
 *
 * Conventions
 *   - Functions that can fail return an int: >= 0 on success, or a negative
 *     AVATAR_ERR_* code. avatar_status_message() describes any code.
 *   - Input strings are passed as (pointer, length) pairs of UTF-8 bytes and
 *     need not be NUL-terminated. This matches Rust's &str, so the Rust side
 *     can pass strings without copying them. A pointer may be NULL only when
 *     its length is 0.
 *   - The backend never allocates memory for the caller. Results are written
 *     into caller-provided buffers or structs, so nothing has to be freed
 *     across the FFI boundary.
 *   - Every function is re-entrant and thread-safe (no mutable global state).
 */
#ifndef AVATAR_H
#define AVATAR_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AVATAR_VERSION "0.1.0"

/* Status codes. */
enum {
    AVATAR_OK = 0,
    AVATAR_ERR_NULL_ARG = -1,   /* a required pointer argument was NULL */
    AVATAR_ERR_EMPTY_NAME = -2, /* the name was empty */
    AVATAR_ERR_TOO_LONG = -3    /* the result length would not fit in an int */
};

/* Identicons are square grids, mirrored left to right. */
#define AVATAR_GRID_SIZE 5
#define AVATAR_GRID_CELLS (AVATAR_GRID_SIZE * AVATAR_GRID_SIZE)

typedef struct avatar_identicon {
    uint8_t cells[AVATAR_GRID_CELLS]; /* row-major; 1 = filled, 0 = empty */
    uint16_t hue;                     /* foreground hue in degrees, 0..359 */
} avatar_identicon;

/* Returns AVATAR_VERSION. Static storage; never NULL. */
const char *avatar_version(void);

/* Returns a description of a status code. Static storage; never NULL. */
const char *avatar_status_message(int status);

/*
 * Writes "Hello, <name>! ..." into out, snprintf-style:
 *   - Returns the length of the full greeting in bytes, excluding the NUL
 *     terminator. Pass out = NULL and out_size = 0 to query the length first.
 *   - If out_size is too small the greeting is truncated (possibly in the
 *     middle of a multi-byte UTF-8 sequence) but always NUL-terminated, and
 *     the full length is still returned.
 *   - Errors: AVATAR_ERR_EMPTY_NAME if name_len is 0; AVATAR_ERR_NULL_ARG if
 *     name is NULL, or out is NULL while out_size > 0; AVATAR_ERR_TOO_LONG.
 */
int avatar_greet(const char *name, size_t name_len, char *out, size_t out_size);

/*
 * Derives a deterministic identicon from the bytes of seed (an empty seed is
 * valid). Returns AVATAR_OK, or AVATAR_ERR_NULL_ARG if out is NULL or seed is
 * NULL while seed_len > 0.
 */
int avatar_identicon_generate(const char *seed, size_t seed_len, avatar_identicon *out);

#ifdef __cplusplus
}
#endif

#endif /* AVATAR_H */
