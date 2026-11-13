#ifndef CHRONOS_GIT_PROCESS_H
#define CHRONOS_GIT_PROCESS_H

#include <stddef.h>

/* Runs argv through the application's existing shell-free Git runner.
 * On success the caller owns the byte buffer, which has an extra NUL. */
int chronos_git_capture(const char *repo, const char *const *args, size_t count,
                        char **bytes, size_t *length, int *exit_code);
#endif
```