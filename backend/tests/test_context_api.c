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
    assert(strstr(views, "\"flows\":[") != NULL);
    assert(strstr(views, "\"bridges\":[") != NULL);
    assert(strstr(views, "\"kind\":\"invoke\"") != NULL);
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

    uint64_t handle = 0;
    status = chronos_views_open("..", "HEAD", "onboarding", NULL, NULL, 0, 8, 2048, &handle);
    assert(status >= 0);
    assert(handle != 0);
    char *brief = NULL;
    assert(chronos_views_brief(handle, &brief) >= 0);
    assert(brief != NULL && strstr(brief, "\"sections\"") != NULL);
    chronos_free_string(brief);
    char *page = NULL;
    assert(chronos_views_page(handle, 0, NULL, 0, 0, 0, 8, 8, 8, &page) >= 0);
    assert(page != NULL && strstr(page, "\"kind\":\"root\"") != NULL);
    chronos_free_string(page);
    assert(chronos_views_page(handle, 1, "[\"module\",\"backend/src\"]",
                              0, 0, 0, 8, 8, 8, &page) >= 0);
    assert(page != NULL && strstr(page, "\"kind\":\"file\"") != NULL);
    chronos_free_string(page);
    chronos_views_close(handle);
    assert(chronos_views_brief(handle, &brief) < 0);
    assert(brief == NULL);
    assert(chronos_views_source(handle, "missing", &source) < 0);

    const char *paths[] = {"backend/src/avatar.c", "backend/src/avatar.c"};
    const char *names[] = {"chronos_compile_views", "chronos_read_source"};
    char *multi = NULL;
    status = chronos_compile_multi_views("..", "HEAD", "task", paths, names, 2, 8, 65536,
                                         &multi);
    assert(status >= 0);
    assert(multi != NULL);
    assert(strstr(multi, "\"targetCount\":2") != NULL);
    assert(strstr(multi, "\"id\":\"targets\"") != NULL);
    assert(strstr(multi, "Target: chronos_compile_views") != NULL);
    assert(strstr(multi, "Target: chronos_read_source") != NULL);
    assert(strstr(multi, "\"flows\":[") != NULL);
    assert(strstr(multi, "\"bridges\":[") != NULL);
    chronos_free_string(multi);
    assert(chronos_compile_multi_views("..", "HEAD", "task", paths, names, 0, 8, 2048,
                                       &multi) < 0);
    assert(multi == NULL);

    puts("context compiler C API tests passed");
    return 0;
}
