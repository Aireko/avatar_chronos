#include "avatar.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    char *views = NULL;
    int status = chronos_compile_views("..", "HEAD", "onboarding", "", "", 8, 2048, &views);
    assert(status >= 0);
    assert(views != NULL);
    assert(strstr(views, "\"brief\":{") != NULL);
    assert(strstr(views, "\"graph\":{") != NULL);
    assert(strstr(views, "\"source\":") == NULL);
    chronos_free_string(views);

    char *source = NULL;
    status = chronos_read_source("..", "HEAD", "backend/include/avatar.h", 0, 32, &source);
    assert(status >= 0);
    assert(source != NULL);
    assert(strstr(source, "\"filePath\":\"backend/include/avatar.h\"") != NULL);
    assert(strstr(source, "\"source\":\"") != NULL);
    chronos_free_string(source);

    assert(chronos_compile_views("..", "HEAD", "bogus", "", "", 8, 2048, &views) < 0);
    assert(views == NULL);
    assert(chronos_compile_views("..", "HEAD", "task", "", "", 8, 2048, &views) < 0);
    assert(views == NULL);
    assert(chronos_compile_views("/no/such/repository", "HEAD", "onboarding", "", "", 8, 2048,
                                 &views) < 0);
    assert(views == NULL);
    assert(chronos_read_source("..", "HEAD", "backend/include/avatar.h", 20, 10, &source) < 0);
    assert(source == NULL);
    assert(chronos_read_source("..", "HEAD", "backend/include/avatar.h", 0, 999999, &source) < 0);
    assert(source == NULL);
    assert(chronos_read_source("..", "HEAD", "../outside.c", 0, 1, &source) < 0);
    assert(source == NULL);

    puts("context compiler C API tests passed");
    return 0;
}
