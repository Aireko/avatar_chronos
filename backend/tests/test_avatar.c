/*
 * Standalone tests for the C backend; they need nothing but a C compiler.
 * From the repository root:
 *
 *   cc -std=c11 -Wall -Wextra -Ibackend/include backend/src/*.c backend/tests/test_avatar.c -o test_avatar && ./test_avatar
 *   cl /W4 /Ibackend\include backend\src\*.c backend\tests\test_avatar.c /Fe:test_avatar.exe && test_avatar.exe
 *
 * The same functions are also exercised through the Rust bindings by
 * `cargo test` in src-tauri.
 */
#include "avatar.h"

#include <stdio.h>
#include <string.h>

static int failures = 0;

#define CHECK(cond)                                                                  \
    do {                                                                             \
        if (!(cond)) {                                                               \
            fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                              \
        }                                                                            \
    } while (0)

static void test_version(void)
{
    CHECK(strcmp(avatar_version(), AVATAR_VERSION) == 0);
}

static void test_status_message(void)
{
    CHECK(strcmp(avatar_status_message(AVATAR_OK), "ok") == 0);
    CHECK(strcmp(avatar_status_message(AVATAR_ERR_EMPTY_NAME), "name must not be empty") == 0);
    CHECK(strcmp(avatar_status_message(12345), "unknown status code") == 0);
}

static void test_greet(void)
{
    static const char expected[] = "Hello, Ada! You've been greeted from C.";
    char buf[64];
    char small[8];
    int needed;

    needed = avatar_greet("Ada", 3, NULL, 0);
    CHECK(needed == (int)strlen(expected));

    memset(buf, 'x', sizeof buf);
    CHECK(avatar_greet("Ada", 3, buf, sizeof buf) == needed);
    CHECK(strcmp(buf, expected) == 0);

    /* Too-small buffers are truncated, stay NUL-terminated and still report the full length. */
    CHECK(avatar_greet("Ada", 3, small, sizeof small) == needed);
    CHECK(strcmp(small, "Hello, ") == 0);
    CHECK(avatar_greet("Ada", 3, small, 1) == needed);
    CHECK(small[0] == '\0');

    /* Names are (pointer, length) pairs, so no NUL terminator is needed. */
    CHECK(avatar_greet("Ada Lovelace", 3, buf, sizeof buf) == needed);
    CHECK(strcmp(buf, expected) == 0);

    CHECK(avatar_greet("", 0, buf, sizeof buf) == AVATAR_ERR_EMPTY_NAME);
    CHECK(avatar_greet(NULL, 0, buf, sizeof buf) == AVATAR_ERR_EMPTY_NAME);
    CHECK(avatar_greet(NULL, 3, buf, sizeof buf) == AVATAR_ERR_NULL_ARG);
    CHECK(avatar_greet("Ada", 3, NULL, sizeof buf) == AVATAR_ERR_NULL_ARG);
}

static int identicons_equal(const avatar_identicon *a, const avatar_identicon *b)
{
    return memcmp(a->cells, b->cells, sizeof a->cells) == 0 && a->hue == b->hue;
}

static void test_identicon(void)
{
    /* Known answer for "Ada". It pins the algorithm; src-tauri/src/ffi.rs checks the same values. */
    static const uint8_t ada_cells[AVATAR_GRID_CELLS] = {
        0, 0, 1, 0, 0,
        0, 0, 0, 0, 0,
        0, 1, 0, 1, 0,
        0, 1, 1, 1, 0,
        1, 1, 0, 1, 1,
    };
    avatar_identicon a, b;
    int row, col;

    CHECK(avatar_identicon_generate("Ada", 3, &a) == AVATAR_OK);
    CHECK(memcmp(a.cells, ada_cells, sizeof ada_cells) == 0);
    CHECK(a.hue == 53);

    CHECK(avatar_identicon_generate("Ada", 3, &b) == AVATAR_OK);
    CHECK(identicons_equal(&a, &b));

    CHECK(avatar_identicon_generate("Grace", 5, &b) == AVATAR_OK);
    CHECK(!identicons_equal(&a, &b));
    CHECK(b.hue < 360);
    for (row = 0; row < AVATAR_GRID_SIZE; row++) {
        for (col = 0; col < AVATAR_GRID_SIZE; col++) {
            uint8_t cell = b.cells[row * AVATAR_GRID_SIZE + col];
            CHECK(cell == 0 || cell == 1);
            CHECK(cell == b.cells[row * AVATAR_GRID_SIZE + (AVATAR_GRID_SIZE - 1 - col)]);
        }
    }

    CHECK(avatar_identicon_generate(NULL, 0, &b) == AVATAR_OK); /* empty seed is valid */
    CHECK(avatar_identicon_generate(NULL, 1, &b) == AVATAR_ERR_NULL_ARG);
    CHECK(avatar_identicon_generate("Ada", 3, NULL) == AVATAR_ERR_NULL_ARG);
}

int main(void)
{
    test_version();
    test_status_message();
    test_greet();
    test_identicon();

    if (failures != 0) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("all C backend tests passed\n");
    return 0;
}
