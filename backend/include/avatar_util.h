#ifndef CHRONOS_AVATAR_UTIL_H
#define CHRONOS_AVATAR_UTIL_H

/* Private helpers shared by the Git backend and its diff parser. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char*  data;
    size_t len;
    size_t cap;
    int    oom;
} sbuf_t;

static inline int sb_reserve(sbuf_t* b, size_t extra)
{
    size_t need, ncap;
    char* p;
    if (b->oom) return 0;
    if (extra > SIZE_MAX - b->len - 1) { b->oom = 1; return 0; }
    need = b->len + extra + 1;
    if (need <= b->cap) return 1;
    ncap = b->cap ? b->cap : 256;
    while (ncap < need) {
        if (ncap > SIZE_MAX / 2) { ncap = need; break; }
        ncap *= 2;
    }
    p = (char*)realloc(b->data, ncap);
    if (!p) { b->oom = 1; return 0; }
    b->data = p;
    b->cap = ncap;
    return 1;
}

static inline void sb_putn(sbuf_t* b, const char* s, size_t n)
{
    if (!sb_reserve(b, n)) return;
    if (n) memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static inline void sb_putc(sbuf_t* b, char c) { sb_putn(b, &c, 1); }

static inline void sb_free(sbuf_t* b)
{
    free(b->data);
    b->data = NULL;
    b->len = b->cap = 0;
    b->oom = 0;
}

static inline char* xstrndup(const char* s, size_t n)
{
    char* p = (char*)malloc(n + 1);
    if (!p) return NULL;
    if (n) memcpy(p, s, n);
    p[n] = '\0';
    return p;
}

static inline char* xstrdup(const char* s) { return s ? xstrndup(s, strlen(s)) : NULL; }

static inline int starts_with(const char* s, const char* prefix)
{
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

static inline void* grow_raw(void* arr, size_t* cap, size_t need, size_t elem, int* ok)
{
    size_t ncap;
    void* p;
    *ok = 1;
    if (need <= *cap) return arr;
    ncap = *cap ? *cap : 8;
    while (ncap < need) ncap *= 2;
    if (ncap > SIZE_MAX / elem) { *ok = 0; return arr; }
    p = realloc(arr, ncap * elem);
    if (!p) { *ok = 0; return arr; }
    memset((char*)p + (*cap) * elem, 0, (ncap - *cap) * elem);
    *cap = ncap;
    return p;
}

#define ARR_GROW(arr, cap, need, okv) \
    ((arr) = grow_raw((arr), &(cap), (need), sizeof(*(arr)), &(okv)))

#endif