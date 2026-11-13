#include "avatar.h"

#include <limits.h>
#include <string.h>

/* The cell bits must fit in the low 32 bits of the hash; the hue uses the rest. */
typedef char avatar_cell_bits_fit_in_32[(AVATAR_GRID_SIZE * ((AVATAR_GRID_SIZE + 1) / 2) <= 32) ? 1 : -1];

static const char GREETING_PREFIX[] = "Hello, ";
static const char GREETING_SUFFIX[] = "! You've been greeted from C.";

const char *avatar_version(void)
{
    return AVATAR_VERSION;
}

const char *avatar_status_message(int status)
{
    switch (status) {
    case AVATAR_OK:
        return "ok";
    case AVATAR_ERR_NULL_ARG:
        return "a required argument was NULL";
    case AVATAR_ERR_EMPTY_NAME:
        return "name must not be empty";
    case AVATAR_ERR_TOO_LONG:
        return "input is too long";
    default:
        return "unknown status code";
    }
}

/* Copies up to len bytes of src to out + *pos, always leaving room for the NUL
 * terminator. Requires out_size > 0 and *pos < out_size. */
static void append_truncated(char *out, size_t out_size, size_t *pos, const char *src, size_t len)
{
    size_t room = out_size - 1 - *pos;
    size_t n = len < room ? len : room;

    memcpy(out + *pos, src, n);
    *pos += n;
}

int avatar_greet(const char *name, size_t name_len, char *out, size_t out_size)
{
    const size_t prefix_len = sizeof GREETING_PREFIX - 1;
    const size_t suffix_len = sizeof GREETING_SUFFIX - 1;
    size_t total;

    if (name_len == 0) {
        return AVATAR_ERR_EMPTY_NAME;
    }
    if (name == NULL || (out == NULL && out_size > 0)) {
        return AVATAR_ERR_NULL_ARG;
    }
    if (name_len > (size_t)INT_MAX - prefix_len - suffix_len) {
        return AVATAR_ERR_TOO_LONG;
    }
    total = prefix_len + name_len + suffix_len;

    if (out_size > 0) {
        size_t pos = 0;
        append_truncated(out, out_size, &pos, GREETING_PREFIX, prefix_len);
        append_truncated(out, out_size, &pos, name, name_len);
        append_truncated(out, out_size, &pos, GREETING_SUFFIX, suffix_len);
        out[pos] = '\0';
    }
    return (int)total;
}

/* 64-bit FNV-1a hash. */
static uint64_t fnv1a64(const unsigned char *data, size_t len)
{
    uint64_t hash = UINT64_C(0xcbf29ce484222325);
    size_t i;

    for (i = 0; i < len; i++) {
        hash ^= data[i];
        hash *= UINT64_C(0x100000001b3);
    }
    return hash;
}

/* SplitMix64 finalizer. FNV-1a's low bits are weak for short, similar inputs,
 * so mix every input bit into every output bit before slicing the hash up. */
static uint64_t mix64(uint64_t z)
{
    z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
    return z ^ (z >> 31);
}

int avatar_identicon_generate(const char *seed, size_t seed_len, avatar_identicon *out)
{
    const int half = (AVATAR_GRID_SIZE + 1) / 2; /* columns that are not mirror images */
    uint64_t bits;
    int row, col;

    if (out == NULL || (seed == NULL && seed_len > 0)) {
        return AVATAR_ERR_NULL_ARG;
    }
    bits = mix64(fnv1a64((const unsigned char *)seed, seed_len));

    /* One bit per cell in the left half (and middle column), mirrored to the right. */
    for (row = 0; row < AVATAR_GRID_SIZE; row++) {
        for (col = 0; col < half; col++) {
            uint8_t filled = (uint8_t)((bits >> (row * half + col)) & 1u);
            out->cells[row * AVATAR_GRID_SIZE + col] = filled;
            out->cells[row * AVATAR_GRID_SIZE + (AVATAR_GRID_SIZE - 1 - col)] = filled;
        }
    }
    out->hue = (uint16_t)((bits >> 32) % 360u);
    return AVATAR_OK;
}
