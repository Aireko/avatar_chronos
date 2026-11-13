/*
 * Chronos backend: git CLI -> structured JSON (commit DAG, file/symbol diffs,
 * deterministic merge-conflict analysis). Pure C11, no external libraries.
 */
#if defined(_WIN32)
#  if !defined(_WIN32_WINNT) || (_WIN32_WINNT < 0x0601)
#    undef _WIN32_WINNT
#    define _WIN32_WINNT 0x0601
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef _CRT_SECURE_NO_WARNINGS
#    define _CRT_SECURE_NO_WARNINGS
#  endif
#else
#  ifndef _POSIX_C_SOURCE
#    define _POSIX_C_SOURCE 200809L
#  endif
#endif

#include "avatar.h"

/* Internal short names for the public AVATAR_* codes in avatar.h. */
#define CHRONOS_OK                  AVATAR_OK
#define CHRONOS_ERR_ARGS            AVATAR_ERR_ARGS
#define CHRONOS_ERR_GIT             AVATAR_ERR_GIT
#define CHRONOS_ERR_IO              AVATAR_ERR_IO
#define CHRONOS_ERR_NOMEM           AVATAR_ERR_NOMEM
#define CHRONOS_ERR_FORBIDDEN       AVATAR_ERR_FORBIDDEN
#define CHRONOS_ERR_SPAWN           AVATAR_ERR_SPAWN
#define CHRONOS_DEFAULT_MAX_COMMITS AVATAR_DEFAULT_MAX_COMMITS

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(_WIN32)
#  include <windows.h>
#else
#  include <fcntl.h>
#  include <spawn.h>
#  include <sys/types.h>
#  include <sys/wait.h>
#  include <unistd.h>
extern char** environ;
#endif

#if defined(_MSC_VER)
#  define CHRONOS_TLS __declspec(thread)
#else
#  define CHRONOS_TLS _Thread_local
#endif

#define CHRONOS_VERSION_STRING "chronos-backend 1.0.0"
#define NAME_MAX_LEN           256
#define MAX_SYMBOLS_PER_FILE   512
#define MAX_HUNKS_PER_FILE     4096
#define MAX_SNIPPET_LINES      200
#define MAX_SNIPPET_BYTES      (32 * 1024)
#define MAX_CMD_OUTPUT_BYTES   (1024 * 1024)
#define MAX_GIT_TOKENS         256
#define MAX_COMMITS_HARD_CAP   100000

/* ========================================================================== */
/* Error handling                                                             */
/* ========================================================================== */

static CHRONOS_TLS char g_last_error[2048];

static void set_error(const char* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_last_error, sizeof g_last_error, fmt, ap);
    va_end(ap);
}

static void clear_error(void) { g_last_error[0] = '\0'; }

static int nomem(void)
{
    set_error("out of memory");
    return CHRONOS_ERR_NOMEM;
}

/* ========================================================================== */
/* String buffer                                                              */
/* ========================================================================== */

typedef struct {
    char*  data;
    size_t len;
    size_t cap;
    int    oom;
} sbuf_t;

static int sb_reserve(sbuf_t* b, size_t extra)
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

static void sb_putn(sbuf_t* b, const char* s, size_t n)
{
    if (!sb_reserve(b, n)) return;
    if (n) memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static void sb_puts(sbuf_t* b, const char* s) { sb_putn(b, s, strlen(s)); }
static void sb_putc(sbuf_t* b, char c) { sb_putn(b, &c, 1); }

static void sb_put_i64(sbuf_t* b, long long v)
{
    char tmp[24];
    int i = 0;
    unsigned long long u = (v < 0) ? (unsigned long long)(-(v + 1)) + 1ULL
                                   : (unsigned long long)v;
    do { tmp[i++] = (char)('0' + (int)(u % 10ULL)); u /= 10ULL; } while (u);
    if (v < 0) tmp[i++] = '-';
    while (i) sb_putc(b, tmp[--i]);
}

static void sb_free(sbuf_t* b)
{
    free(b->data);
    b->data = NULL;
    b->len = b->cap = 0;
    b->oom = 0;
}

static const char* sb_cstr(const sbuf_t* b) { return b->data ? b->data : ""; }

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

static char* xstrndup(const char* s, size_t n)
{
    char* p = (char*)malloc(n + 1);
    if (!p) return NULL;
    if (n) memcpy(p, s, n);
    p[n] = '\0';
    return p;
}

static char* xstrdup(const char* s) { return s ? xstrndup(s, strlen(s)) : NULL; }

static int starts_with(const char* s, const char* prefix)
{
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

static int key_eq(const char* a, const char* b)
{
    if (!a || !b) return a == b;
    return strcmp(a, b) == 0;
}

static void copy_name(char* dst, size_t cap, const char* src)
{
    size_t n = strlen(src);
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static void* grow_raw(void* arr, size_t* cap, size_t need, size_t elem, int* ok)
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

/* First line of a buffer, trimmed of CR/LF. */
static char* first_line_dup(const sbuf_t* b)
{
    const char* s = sb_cstr(b);
    size_t n = strcspn(s, "\r\n");
    return xstrndup(s, n);
}

/* ========================================================================== */
/* Line iterator                                                              */
/* ========================================================================== */

typedef struct {
    const char* cur;
    const char* end;
    sbuf_t      line;
} line_iter_t;

static void li_init(line_iter_t* it, const sbuf_t* b)
{
    it->cur = b->data;
    it->end = b->data ? b->data + b->len : NULL;
    memset(&it->line, 0, sizeof it->line);
}

static const char* li_next(line_iter_t* it)
{
    const char* s;
    const char* nl;
    const char* e;
    size_t n;
    if (!it->cur || it->cur >= it->end) return NULL;
    s = it->cur;
    nl = (const char*)memchr(s, '\n', (size_t)(it->end - s));
    e = nl ? nl : it->end;
    it->cur = nl ? nl + 1 : it->end;
    n = (size_t)(e - s);
    if (n && s[n - 1] == '\r') n--;
    it->line.len = 0;
    sb_putn(&it->line, s, n);
    if (it->line.oom) return NULL;
    return it->line.data;
}

static void li_free(line_iter_t* it) { sb_free(&it->line); }

/* ========================================================================== */
/* JSON serialization                                                         */
/* ========================================================================== */

static size_t utf8_seq_len(const unsigned char* s, size_t rem)
{
    unsigned c = s[0], cp;
    size_t n, i;
    if (c < 0x80) return 1;
    if ((c & 0xE0) == 0xC0)      { n = 2; cp = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0) { n = 3; cp = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0) { n = 4; cp = c & 0x07; }
    else return 0;
    if (n > rem) return 0;
    for (i = 1; i < n; i++) {
        if ((s[i] & 0xC0) != 0x80) return 0;
        cp = (cp << 6) | (s[i] & 0x3F);
    }
    if ((n == 2 && cp < 0x80) || (n == 3 && cp < 0x800) ||
        (n == 4 && (cp < 0x10000 || cp > 0x10FFFF)) ||
        (cp >= 0xD800 && cp <= 0xDFFF))
        return 0;
    return n;
}

/* Escapes a byte string as a JSON string. Invalid UTF-8 becomes U+FFFD. */
static void json_strn(sbuf_t* b, const char* s, size_t n)
{
    static const char hex[] = "0123456789abcdef";
    const unsigned char* p = (const unsigned char*)s;
    size_t i = 0;
    sb_putc(b, '"');
    while (i < n) {
        unsigned char c = p[i];
        if (c == '"')       { sb_puts(b, "\\\""); i++; }
        else if (c == '\\') { sb_puts(b, "\\\\"); i++; }
        else if (c == '\n') { sb_puts(b, "\\n");  i++; }
        else if (c == '\r') { sb_puts(b, "\\r");  i++; }
        else if (c == '\t') { sb_puts(b, "\\t");  i++; }
        else if (c == '\b') { sb_puts(b, "\\b");  i++; }
        else if (c == '\f') { sb_puts(b, "\\f");  i++; }
        else if (c < 0x20 || c == 0x7F) {
            char e[7];
            e[0] = '\\'; e[1] = 'u'; e[2] = '0'; e[3] = '0';
            e[4] = hex[c >> 4]; e[5] = hex[c & 15]; e[6] = '\0';
            sb_puts(b, e);
            i++;
        } else if (c < 0x80) {
            sb_putc(b, (char)c);
            i++;
        } else {
            size_t L = utf8_seq_len(p + i, n - i);
            if (L == 0) { sb_puts(b, "\\ufffd"); i++; }
            else { sb_putn(b, (const char*)p + i, L); i += L; }
        }
    }
    sb_putc(b, '"');
}

static void json_str(sbuf_t* b, const char* s) { json_strn(b, s ? s : "", s ? strlen(s) : 0); }

static void json_str_or_null(sbuf_t* b, const char* s)
{
    if (s) json_str(b, s);
    else sb_puts(b, "null");
}

static void json_bool(sbuf_t* b, int v) { sb_puts(b, v ? "true" : "false"); }

/* ========================================================================== */
/* Process execution (no shell involved)                                      */
/* ========================================================================== */

typedef struct {
    sbuf_t out;
    sbuf_t err;
    int    exit_code;
} proc_t;

static void proc_free(proc_t* p)
{
    sb_free(&p->out);
    sb_free(&p->err);
}

#if defined(_WIN32)

static wchar_t* utf8_to_wide(const char* s)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    wchar_t* w;
    if (n <= 0) return NULL;
    w = (wchar_t*)malloc((size_t)n * sizeof(wchar_t));
    if (!w) return NULL;
    if (MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n) <= 0) { free(w); return NULL; }
    return w;
}

/* Quote one argument per the MSVCRT / CommandLineToArgvW rules. */
static void win_quote_arg(sbuf_t* cmd, const char* arg)
{
    const char* p;
    if (*arg && !strpbrk(arg, " \t\n\v\"")) { sb_puts(cmd, arg); return; }
    sb_putc(cmd, '"');
    for (p = arg;; p++) {
        size_t bs = 0, i;
        while (*p == '\\') { bs++; p++; }
        if (*p == '\0') {
            for (i = 0; i < bs * 2; i++) sb_putc(cmd, '\\');
            break;
        }
        if (*p == '"') {
            for (i = 0; i < bs * 2 + 1; i++) sb_putc(cmd, '\\');
            sb_putc(cmd, '"');
        } else {
            for (i = 0; i < bs; i++) sb_putc(cmd, '\\');
            sb_putc(cmd, *p);
        }
    }
    sb_putc(cmd, '"');
}

static int run_process(const char* const* argv, proc_t* pr)
{
    sbuf_t cmd = {0};
    wchar_t* wcmd = NULL;
    SECURITY_ATTRIBUTES sa;
    HANDLE out_r = NULL, out_w = NULL;
    HANDLE err_h = INVALID_HANDLE_VALUE, nul_h = INVALID_HANDLE_VALUE;
    HANDLE inherit[3];
    wchar_t tmp_dir[MAX_PATH + 1], tmp_name[MAX_PATH + 1];
    LPPROC_THREAD_ATTRIBUTE_LIST attrs = NULL;
    int attrs_init = 0;
    SIZE_T attr_size = 0;
    STARTUPINFOEXW si;
    PROCESS_INFORMATION pi;
    DWORD tl, code = 0, n = 0;
    char buf[16384];
    size_t i;
    int rc = CHRONOS_ERR_SPAWN;

    memset(pr, 0, sizeof *pr);
    pr->exit_code = -1;
    ZeroMemory(&pi, sizeof pi);

    for (i = 0; argv[i]; i++) {
        if (i) sb_putc(&cmd, ' ');
        win_quote_arg(&cmd, argv[i]);
    }
    if (cmd.oom) { sb_free(&cmd); return nomem(); }
    wcmd = utf8_to_wide(cmd.data);
    sb_free(&cmd);
    if (!wcmd) { set_error("failed to encode git command line"); return CHRONOS_ERR_SPAWN; }

    sa.nLength = sizeof sa;
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    if (!CreatePipe(&out_r, &out_w, &sa, 0)) { set_error("CreatePipe failed (%lu)", (unsigned long)GetLastError()); goto done; }
    SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);

    tl = GetTempPathW(MAX_PATH + 1, tmp_dir);
    if (tl == 0 || tl > MAX_PATH) { set_error("GetTempPath failed"); goto done; }
    if (!GetTempFileNameW(tmp_dir, L"chr", 0, tmp_name)) { set_error("GetTempFileName failed"); goto done; }
    err_h = CreateFileW(tmp_name, GENERIC_READ | GENERIC_WRITE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &sa,
                        CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, NULL);
    if (err_h == INVALID_HANDLE_VALUE) { DeleteFileW(tmp_name); set_error("cannot create stderr temp file"); goto done; }
    nul_h = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
    if (nul_h == INVALID_HANDLE_VALUE) { set_error("cannot open NUL device"); goto done; }

    /* Restrict inheritance to exactly these handles (safe with concurrent spawns). */
    InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size);
    attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attr_size);
    if (!attrs) { rc = nomem(); goto done; }
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, &attr_size)) { set_error("InitializeProcThreadAttributeList failed"); goto done; }
    attrs_init = 1;
    inherit[0] = nul_h; inherit[1] = out_w; inherit[2] = err_h;
    if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof inherit, NULL, NULL)) {
        set_error("UpdateProcThreadAttribute failed");
        goto done;
    }

    ZeroMemory(&si, sizeof si);
    si.StartupInfo.cb = sizeof si;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = nul_h;
    si.StartupInfo.hStdOutput = out_w;
    si.StartupInfo.hStdError = err_h;
    si.lpAttributeList = attrs;

    if (!CreateProcessW(NULL, wcmd, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                        NULL, NULL, &si.StartupInfo, &pi)) {
        DWORD e = GetLastError();
        if (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND)
            set_error("git executable not found in PATH");
        else
            set_error("CreateProcess failed (Win32 error %lu)", (unsigned long)e);
        goto done;
    }

    CloseHandle(out_w); out_w = NULL;
    CloseHandle(nul_h); nul_h = INVALID_HANDLE_VALUE;

    for (;;) {
        if (!ReadFile(out_r, buf, (DWORD)sizeof buf, &n, NULL) || n == 0) break;
        sb_putn(&pr->out, buf, (size_t)n);
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &code);
    pr->exit_code = (int)code;

    SetFilePointer(err_h, 0, NULL, FILE_BEGIN);
    for (;;) {
        if (!ReadFile(err_h, buf, (DWORD)sizeof buf, &n, NULL) || n == 0) break;
        sb_putn(&pr->err, buf, (size_t)n);
    }
    rc = (pr->out.oom || pr->err.oom) ? nomem() : CHRONOS_OK;

done:
    if (pi.hProcess) CloseHandle(pi.hProcess);
    if (pi.hThread) CloseHandle(pi.hThread);
    if (attrs) {
        if (attrs_init) DeleteProcThreadAttributeList(attrs);
        HeapFree(GetProcessHeap(), 0, attrs);
    }
    if (out_r) CloseHandle(out_r);
    if (out_w) CloseHandle(out_w);
    if (nul_h != INVALID_HANDLE_VALUE) CloseHandle(nul_h);
    if (err_h != INVALID_HANDLE_VALUE) CloseHandle(err_h);
    free(wcmd);
    if (rc != CHRONOS_OK) proc_free(pr);
    return rc;
}

#else /* POSIX */

static char** build_child_env(void)
{
    size_t n = 0, k = 0, i;
    char** env;
    while (environ && environ[n]) n++;
    env = (char**)calloc(n + 2, sizeof(char*));
    if (!env) return NULL;
    for (i = 0; i < n; i++)
        if (strncmp(environ[i], "GIT_TERMINAL_PROMPT=", 20) != 0) env[k++] = environ[i];
    env[k++] = (char*)"GIT_TERMINAL_PROMPT=0";
    env[k] = NULL;
    return env;
}

static int run_process(const char* const* argv, proc_t* pr)
{
    int outp[2] = {-1, -1};
    FILE* errf = NULL;
    int errfd = -1;
    char** env = NULL;
    posix_spawn_file_actions_t fa;
    int fa_init = 0;
    pid_t pid = -1;
    char buf[16384];
    int status = 0, e;
    size_t m;
    int rc = CHRONOS_ERR_SPAWN;

    memset(pr, 0, sizeof *pr);
    pr->exit_code = -1;

    if (pipe(outp) != 0) { set_error("pipe() failed: %s", strerror(errno)); goto done; }
    fcntl(outp[0], F_SETFD, FD_CLOEXEC);
    fcntl(outp[1], F_SETFD, FD_CLOEXEC);
    errf = tmpfile();
    if (!errf) { set_error("tmpfile() failed: %s", strerror(errno)); goto done; }
    errfd = fileno(errf);
    fcntl(errfd, F_SETFD, FD_CLOEXEC);
    env = build_child_env();
    if (!env) { rc = nomem(); goto done; }

    if (posix_spawn_file_actions_init(&fa) != 0) { set_error("posix_spawn_file_actions_init failed"); goto done; }
    fa_init = 1;
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_adddup2(&fa, outp[1], 1);
    posix_spawn_file_actions_adddup2(&fa, errfd, 2);

    e = posix_spawnp(&pid, "git", &fa, NULL, (char* const*)argv, env);
    if (e != 0) {
        if (e == ENOENT) set_error("git executable not found in PATH");
        else set_error("posix_spawnp failed: %s", strerror(e));
        goto done;
    }
    close(outp[1]);
    outp[1] = -1;

    for (;;) {
        ssize_t n = read(outp[0], buf, sizeof buf);
        if (n > 0) sb_putn(&pr->out, buf, (size_t)n);
        else if (n < 0 && errno == EINTR) continue;
        else break;
    }
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) { status = -1; break; }
    }
    pr->exit_code = (status != -1 && WIFEXITED(status)) ? WEXITSTATUS(status) : -1;
    if (pr->exit_code == 127 && pr->out.len == 0) {
        set_error("git executable not found in PATH");
        goto done;
    }

    rewind(errf);
    while ((m = fread(buf, 1, sizeof buf, errf)) > 0) sb_putn(&pr->err, buf, m);
    rc = (pr->out.oom || pr->err.oom) ? nomem() : CHRONOS_OK;

done:
    if (fa_init) posix_spawn_file_actions_destroy(&fa);
    if (outp[0] >= 0) close(outp[0]);
    if (outp[1] >= 0) close(outp[1]);
    if (errf) fclose(errf);
    free(env);
    if (rc != CHRONOS_OK) proc_free(pr);
    return rc;
}

#endif

/* Runs `git -C <repo> <safe global options> <args...>`. */
static int git_run(const char* repo, const char* const* args, size_t nargs, proc_t* pr)
{
    static const char* const base[] = {
        "git", "--no-pager", "--no-optional-locks",
        "-c", "core.quotepath=off",
        "-c", "color.ui=never",
        "-c", "core.pager=cat",
        "-c", "core.editor=:",
        "-c", "sequence.editor=:",
        "-c", "log.showSignature=false",
        "-c", "i18n.logOutputEncoding=UTF-8",
        "-c", "protocol.ext.allow=never",
        "-c", "advice.detachedHead=false"
    };
    size_t nb = sizeof base / sizeof base[0];
    const char** argv;
    size_t n = 0, i;
    int rc;

    argv = (const char**)malloc((nb + 2 + nargs + 1) * sizeof(char*));
    if (!argv) return nomem();
    argv[n++] = base[0];
    argv[n++] = "-C";
    argv[n++] = repo;
    for (i = 1; i < nb; i++) argv[n++] = base[i];
    for (i = 0; i < nargs; i++) argv[n++] = args[i];
    argv[n] = NULL;
    rc = run_process(argv, pr);
    free(argv);
    return rc;
}

/* ========================================================================== */
/* Validation                                                                 */
/* ========================================================================== */

static int validate_repo_path(const char* p)
{
    size_t i, n;
    if (!p || !*p) { set_error("repo_path is empty"); return 0; }
    n = strlen(p);
    if (n > 4096) { set_error("repo_path is too long"); return 0; }
    for (i = 0; i < n; i++) {
        if ((unsigned char)p[i] < 0x20) { set_error("repo_path contains control characters"); return 0; }
    }
    return 1;
}

static int validate_ref(const char* r, const char* what)
{
    size_t n, i;
    if (!r || !*r) { set_error("%s is empty", what); return 0; }
    n = strlen(r);
    if (n > 255) { set_error("%s is too long", what); return 0; }
    if (r[0] == '-') { set_error("%s may not start with '-'", what); return 0; }
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)r[i];
        if (c < 0x20 || c == 0x7F || c == ' ' || c == '~' || c == '^' || c == ':' ||
            c == '?' || c == '*' || c == '[' || c == '\\') {
            set_error("%s contains an invalid character", what);
            return 0;
        }
    }
    if (strstr(r, "..") || strstr(r, "@{")) { set_error("%s is not a valid ref name", what); return 0; }
    return 1;
}

/* Resolves the repository top-level directory (forward slashes on Windows). */
static int resolve_repo(const char* repo, char** toplevel)
{
    proc_t pr;
    int rc;
    *toplevel = NULL;
    if (!validate_repo_path(repo)) return CHRONOS_ERR_ARGS;
    {
        const char* a[] = {"rev-parse", "--show-toplevel"};
        rc = git_run(repo, a, 2, &pr);
    }
    if (rc) return rc;
    if (pr.exit_code == 0) {
        *toplevel = first_line_dup(&pr.out);
        proc_free(&pr);
        return *toplevel ? CHRONOS_OK : nomem();
    }
    proc_free(&pr);
    {
        const char* a[] = {"rev-parse", "--git-dir"};
        rc = git_run(repo, a, 2, &pr);
    }
    if (rc) return rc;
    if (pr.exit_code == 0) { /* bare repository */
        proc_free(&pr);
        *toplevel = xstrdup(repo);
        return *toplevel ? CHRONOS_OK : nomem();
    }
    set_error("not a git repository: %s (%s)", repo, sb_cstr(&pr.err));
    proc_free(&pr);
    return CHRONOS_ERR_GIT;
}

static int resolve_commit(const char* repo, const char* ref, char** oid)
{
    sbuf_t spec = {0};
    proc_t pr;
    int rc;
    *oid = NULL;
    sb_puts(&spec, ref);
    sb_puts(&spec, "^{commit}");
    if (spec.oom) { sb_free(&spec); return nomem(); }
    {
        const char* a[] = {"rev-parse", "--verify", "-q", spec.data};
        rc = git_run(repo, a, 4, &pr);
    }
    sb_free(&spec);
    if (rc) return rc;
    if (pr.exit_code != 0) {
        set_error("cannot resolve '%s' to a commit", ref);
        proc_free(&pr);
        return CHRONOS_ERR_GIT;
    }
    *oid = first_line_dup(&pr.out);
    proc_free(&pr);
    return *oid ? CHRONOS_OK : nomem();
}

/* ========================================================================== */
/* Symbol detection (language-agnostic heuristics)                            */
/* ========================================================================== */

static int is_id_start(unsigned char c) { return isalpha(c) || c == '_' || c == '$'; }
static int is_id_char(unsigned char c) { return isalnum(c) || c == '_' || c == '$'; }

static const char* skip_ws(const char* p)
{
    while (*p == ' ' || *p == '\t') p++;
    return p;
}

static int word_at(const char* p, const char* w)
{
    size_t n = strlen(w);
    return strncmp(p, w, n) == 0 && !is_id_char((unsigned char)p[n]);
}

static const char* read_ident(const char* p, char* out, size_t cap)
{
    size_t n = 0;
    if (!is_id_start((unsigned char)*p)) return NULL;
    while (is_id_char((unsigned char)*p)) {
        if (n + 1 < cap) out[n++] = *p;
        p++;
    }
    out[n] = '\0';
    return p;
}

static const char* skip_balanced(const char* p, char open, char close)
{
    int depth = 0;
    for (; *p; p++) {
        if (*p == open) depth++;
        else if (*p == close) { if (--depth == 0) return p + 1; }
    }
    return NULL;
}

static int in_list(const char* w, const char* const* list)
{
    size_t i;
    for (i = 0; list[i]; i++) if (strcmp(w, list[i]) == 0) return 1;
    return 0;
}

static const char* const k_modifiers[] = {
    "export", "default", "public", "private", "protected", "internal", "static",
    "abstract", "final", "async", "pub", "virtual", "inline", "extern", "override",
    "sealed", "partial", "unsafe", "open", "suspend", "synchronized", "native",
    "explicit", "constexpr", "consteval", "friend", "declare", "readonly", NULL
};

static const char* const k_not_names[] = {
    "if", "for", "while", "switch", "return", "sizeof", "catch", "else", "do", "new",
    "delete", "throw", "case", "typeof", "await", "yield", "defined", "elif", "assert",
    "with", "using", "foreach", "lock", "goto", "alignof", "_Alignof", "_Generic",
    "static_assert", "_Static_assert", "decltype", "match", "not", "and", "or", "in",
    "print", "printf", "super", "this", "template", "operator", "except", "raise",
    "lambda", "defer", "go", "import", "from", "pass", "del", "unless", "until", NULL
};

/* RHS of an assignment that defines a function: `(a) =>`, `x =>`, `function`. */
static int rhs_is_function(const char* r)
{
    char tmp[NAME_MAX_LEN];
    const char* e;
    r = skip_ws(r);
    if (word_at(r, "async")) r = skip_ws(r + 5);
    if (word_at(r, "function")) return 1;
    if (*r == '(') {
        e = skip_balanced(r, '(', ')');
        if (!e) return 1; /* multi-line parameter list */
        e = skip_ws(e);
        if (*e == ':') return strstr(e, "=>") != NULL; /* TS return annotation */
        return e[0] == '=' && e[1] == '>';
    }
    e = read_ident(r, tmp, sizeof tmp);
    if (e) {
        e = skip_ws(e);
        return e[0] == '=' && e[1] == '>';
    }
    return 0;
}

/*
 * Detects a function / method / class definition on a single source line.
 * Returns 1 and fills name/kind ("function" | "method" | "class") on success.
 */
static int detect_def(const char* line, char* name, size_t cap, const char** kind)
{
    const char* p = skip_ws(line);
    const char* end;
    const char* q;
    const char* r;
    char word[NAME_MAX_LEN];
    int indented = (p != line);
    size_t i;
    char last;

    if (!*p) return 0;
    if ((p[0] == '/' && (p[1] == '/' || p[1] == '*')) || p[0] == '*' || p[0] == '#' ||
        p[0] == '@' || p[0] == '<' || p[0] == '}' || p[0] == ')' || p[0] == ']' ||
        p[0] == '"' || p[0] == '\'' || (p[0] == '-' && p[1] == '-'))
        return 0;

    end = p + strlen(p);
    while (end > p && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) end--;
    if (end == p) return 0;
    last = end[-1];

    /* Strip leading modifiers. */
    for (;;) {
        int hit = 0;
        for (i = 0; k_modifiers[i]; i++) {
            if (word_at(p, k_modifiers[i])) {
                p = skip_ws(p + strlen(k_modifiers[i]));
                if (strcmp(k_modifiers[i], "pub") == 0 && *p == '(') {
                    q = strchr(p, ')');
                    if (q) p = skip_ws(q + 1);
                }
                hit = 1;
                break;
            }
        }
        if (!hit) break;
    }
    if (p >= end) return 0;

    /* Go: type X struct / interface */
    if (word_at(p, "type")) {
        q = read_ident(skip_ws(p + 4), word, sizeof word);
        if (q) {
            q = skip_ws(q);
            if (word_at(q, "struct") || word_at(q, "interface")) {
                copy_name(name, cap, word);
                *kind = "class";
                return 1;
            }
        }
        return 0;
    }

    /* class-like declarations */
    {
        static const char* const ck[] = {
            "class", "interface", "trait", "struct", "enum", "union", "impl", "record", NULL
        };
        for (i = 0; ck[i]; i++) {
            int c_like;
            if (!word_at(p, ck[i])) continue;
            c_like = (!strcmp(ck[i], "struct") || !strcmp(ck[i], "union") || !strcmp(ck[i], "enum"));
            q = skip_ws(p + strlen(ck[i]));
            if (!strcmp(ck[i], "enum")) {
                if (word_at(q, "class")) q = skip_ws(q + 5);
                else if (word_at(q, "struct")) q = skip_ws(q + 6);
            }
            if (*q == '<') {
                r = skip_balanced(q, '<', '>');
                if (!r) return 0;
                q = skip_ws(r);
            }
            r = read_ident(q, word, sizeof word);
            if (!r) return 0;
            if (!strcmp(ck[i], "impl")) {
                const char* s2 = skip_ws(r);
                if (*s2 == '<') {
                    const char* s3 = skip_balanced(s2, '<', '>');
                    if (s3) s2 = skip_ws(s3);
                }
                if (word_at(s2, "for")) {
                    char w2[NAME_MAX_LEN];
                    if (read_ident(skip_ws(s2 + 3), w2, sizeof w2)) copy_name(word, sizeof word, w2);
                }
            }
            if (c_like && memchr(p, '(', (size_t)(end - p))) break; /* function returning struct */
            if (last == ';' || last == ',') return 0;
            copy_name(name, cap, word);
            *kind = "class";
            return 1;
        }
    }

    /* keyword-introduced functions */
    {
        static const char* const fk[] = {"def", "fn", "fun", "function", "func", "sub", "proc", NULL};
        for (i = 0; fk[i]; i++) {
            int method = indented;
            if (!word_at(p, fk[i])) continue;
            q = skip_ws(p + strlen(fk[i]));
            if (*q == '*') q = skip_ws(q + 1);
            if (!strcmp(fk[i], "func") && *q == '(') {
                r = skip_balanced(q, '(', ')');
                if (!r) return 0;
                q = skip_ws(r);
                method = 1;
            }
            if (*q == '<') {
                r = skip_balanced(q, '<', '>');
                if (!r) return 0;
                q = skip_ws(r);
            }
            r = read_ident(q, word, sizeof word);
            if (!r) return 0;
            if (*r == '.') {
                char w2[NAME_MAX_LEN];
                if (read_ident(r + 1, w2, sizeof w2)) { copy_name(word, sizeof word, w2); method = 1; }
            }
            copy_name(name, cap, word);
            *kind = method ? "method" : "function";
            return 1;
        }
    }

    /* const/let/var X = (...) => / function */
    if (word_at(p, "const") || word_at(p, "let") || word_at(p, "var")) {
        q = skip_ws(p + (p[0] == 'c' ? 5 : 3));
        r = read_ident(q, word, sizeof word);
        if (!r) return 0;
        r = skip_ws(r);
        if (*r == ':') { while (*r && *r != '=') r++; }
        if (*r != '=' || r[1] == '=' || r[1] == '>') return 0;
        if (rhs_is_function(r + 1)) {
            copy_name(name, cap, word);
            *kind = "function";
            return 1;
        }
        return 0;
    }

    /* class field / assignment arrow: handleClick = () => { */
    q = read_ident(p, word, sizeof word);
    if (q) {
        r = skip_ws(q);
        if (*r == '=' && r[1] != '=' && r[1] != '>' && rhs_is_function(r + 1)) {
            copy_name(name, cap, word);
            *kind = indented ? "method" : "function";
            return 1;
        }
    }

    /* C-family: <type> name(args) [const] [{] */
    if (last == ';') return 0;
    if (!(is_id_start((unsigned char)*p) || *p == '~' || *p == ':')) return 0;
    {
        const char* paren = (const char*)memchr(p, '(', (size_t)(end - p));
        const char* ne;
        const char* ns;
        const char* t;
        const char* close = NULL;
        const char* lastc;
        char first[NAME_MAX_LEN];
        char full[NAME_MAX_LEN];
        int has_type = 0, has_scope, depth = 0;
        size_t n;

        if (!paren) return 0;
        for (t = p; t < paren; t++) {
            char c = *t;
            if (c == '=' || c == '"' || c == '\'' || c == '.' || c == '!' || c == '|' ||
                c == '?' || c == '+' || c == '-' || c == '/' || c == '%' || c == '^')
                return 0;
        }
        if (read_ident(p, first, sizeof first) && in_list(first, k_not_names)) return 0;

        ne = paren;
        while (ne > p && (ne[-1] == ' ' || ne[-1] == '\t')) ne--;
        if (ne > p && ne[-1] == '>') return 0;
        ns = ne;
        while (ns > p && (is_id_char((unsigned char)ns[-1]) || ns[-1] == ':' || ns[-1] == '~')) ns--;
        if (ns == ne) return 0;

        n = (size_t)(ne - ns);
        if (n >= sizeof full) n = sizeof full - 1;
        memcpy(full, ns, n);
        full[n] = '\0';
        {
            char* c = full;
            while (*c == ':') c++;
            if (c != full) memmove(full, c, strlen(c) + 1);
        }
        for (t = full; *t; t++) {
            if (*t == ':') {
                if (t[1] != ':') return 0;
                t++;
            }
        }
        lastc = full;
        for (t = full; *t; t++) if (t[0] == ':' && t[1] == ':') lastc = t + 2;
        if (!*lastc || !(is_id_start((unsigned char)*lastc) || *lastc == '~')) return 0;
        if (in_list(lastc, k_not_names)) return 0;
        has_scope = (lastc != full);

        for (t = p; t < ns; t++) {
            unsigned char c = (unsigned char)*t;
            if (is_id_char(c) || c == '*' || c == '&' || c == '>' || c == ']') { has_type = 1; break; }
        }
        for (t = paren; t < end; t++) {
            if (*t == '(') depth++;
            else if (*t == ')') { if (--depth == 0) { close = t; break; } }
        }
        if (close) {
            r = skip_ws(close + 1);
            if (r < end) {
                if (!(*r == '{' || *r == ':' || (r[0] == '-' && r[1] == '>') ||
                      word_at(r, "const") || word_at(r, "override") || word_at(r, "noexcept") ||
                      word_at(r, "final") || word_at(r, "throws") || word_at(r, "where") ||
                      word_at(r, "volatile") || word_at(r, "mutable") || word_at(r, "async")))
                    return 0;
            }
            if (!has_type && !has_scope) {
                if (!(indented && r < end && (*r == '{' || *r == ':'))) return 0;
                for (t = paren + 1; t < close; t++)
                    if (*t == '"' || *t == '\'' || *t == '(') return 0;
            }
        } else if (!has_type && !has_scope) {
            return 0;
        }
        copy_name(name, cap, full);
        *kind = (has_scope || indented) ? "method" : "function";
        return 1;
    }
}

/* ========================================================================== */
/* Diff model + parser                                                        */
/* ========================================================================== */

enum { CH_MOD = 0, CH_ADD = 1, CH_DEL = 2 };

typedef struct {
    char*       name;
    const char* kind;
    int         change;
    long        start;
    long        end;
    int         range_new; /* 1: new-file coordinates, 0: old-file coordinates */
} sym_t;

typedef struct {
    long old_start, old_count, new_start, new_count;
    int  sym;
} hunk_t;

typedef struct {
    char*   path;
    char*   old_path;
    char    status;
    int     binary;
    long    additions;
    long    deletions;
    sym_t*  syms;
    size_t  nsyms, csyms;
    hunk_t* hunks;
    size_t  nhunks, chunks;
} file_t;

typedef struct {
    file_t* items;
    size_t  n, cap;
} filelist_t;

static void file_free(file_t* f)
{
    size_t i;
    free(f->path);
    free(f->old_path);
    for (i = 0; i < f->nsyms; i++) free(f->syms[i].name);
    free(f->syms);
    free(f->hunks);
    memset(f, 0, sizeof *f);
}

static void filelist_free(filelist_t* fl)
{
    size_t i;
    for (i = 0; i < fl->n; i++) file_free(&fl->items[i]);
    free(fl->items);
    memset(fl, 0, sizeof *fl);
}

static void sym_extend(sym_t* s, long line, int line_is_new)
{
    if (line < 1) line = 1;
    if (line_is_new && !s->range_new) {
        s->start = s->end = line;
        s->range_new = 1;
        return;
    }
    if (line_is_new != s->range_new) return;
    if (line < s->start) s->start = line;
    if (line > s->end) s->end = line;
}

static int sym_touch(file_t* f, const char* name, const char* kind, int change, long line, int line_is_new)
{
    size_t i;
    int ok;
    sym_t* s;
    for (i = 0; i < f->nsyms; i++) {
        if (strcmp(f->syms[i].name, name) == 0) {
            s = &f->syms[i];
            if (change != CH_MOD && s->change != CH_MOD && s->change != change) s->change = CH_MOD;
            sym_extend(s, line, line_is_new);
            return (int)i;
        }
    }
    if (f->nsyms >= MAX_SYMBOLS_PER_FILE) return -1;
    ARR_GROW(f->syms, f->csyms, f->nsyms + 1, ok);
    if (!ok) return -1;
    s = &f->syms[f->nsyms];
    s->name = xstrdup(name);
    if (!s->name) return -1;
    s->kind = kind;
    s->change = change;
    s->start = s->end = (line < 1) ? 1 : line;
    s->range_new = line_is_new;
    return (int)f->nsyms++;
}

typedef struct {
    long        cur;
    int         in_hunk;
    long        old_rem, new_rem, old_line, new_line;
    long        hunk_idx;
    int         plus_sym, minus_sym, ctx_sym;
    int         has_ctx;
    char        ctx_name[NAME_MAX_LEN];
    const char* ctx_kind;
    int         keep_hunks;
    int         oom;
} diff_state_t;

static void diff_state_init(diff_state_t* st, int keep_hunks)
{
    memset(st, 0, sizeof *st);
    st->cur = -1;
    st->hunk_idx = -1;
    st->plus_sym = st->minus_sym = st->ctx_sym = -1;
    st->keep_hunks = keep_hunks;
}

static char* git_unquote(const char* s)
{
    sbuf_t o = {0};
    size_t i, n = strlen(s);
    if (n < 2 || s[0] != '"') return xstrdup(s);
    for (i = 1; i < n; i++) {
        char c = s[i];
        if (c == '"') break;
        if (c == '\\' && i + 1 < n) {
            char d = s[++i];
            switch (d) {
            case 'n': sb_putc(&o, '\n'); break;
            case 't': sb_putc(&o, '\t'); break;
            case 'r': sb_putc(&o, '\r'); break;
            case 'a': sb_putc(&o, '\a'); break;
            case 'b': sb_putc(&o, '\b'); break;
            case 'f': sb_putc(&o, '\f'); break;
            case 'v': sb_putc(&o, '\v'); break;
            default:
                if (d >= '0' && d <= '7' && i + 2 < n &&
                    s[i + 1] >= '0' && s[i + 1] <= '7' && s[i + 2] >= '0' && s[i + 2] <= '7') {
                    int v = ((d - '0') << 6) | ((s[i + 1] - '0') << 3) | (s[i + 2] - '0');
                    sb_putc(&o, (char)v);
                    i += 2;
                } else {
                    sb_putc(&o, d);
                }
            }
        } else {
            sb_putc(&o, c);
        }
    }
    if (o.oom) { sb_free(&o); return NULL; }
    if (!o.data) return xstrdup("");
    return o.data;
}

/* Parses the path of a ---/+++ line. Sets *is_null for /dev/null. */
static char* parse_diff_path(const char* s, char side, int* is_null)
{
    size_t n = strlen(s);
    char* tmp;
    char* u;
    *is_null = 0;
    while (n && s[n - 1] == '\t') n--;
    if (n == 9 && strncmp(s, "/dev/null", 9) == 0) { *is_null = 1; return NULL; }
    tmp = xstrndup(s, n);
    if (!tmp) return NULL;
    u = git_unquote(tmp);
    free(tmp);
    if (!u) return NULL;
    if (u[0] == side && u[1] == '/') memmove(u, u + 2, strlen(u + 2) + 1);
    return u;
}

static void replace_str(char** dst, char* v)
{
    if (v) { free(*dst); *dst = v; }
}

/* Fallback path from "diff --git a/P b/P" when both sides are identical. */
static void parse_diff_git_line(file_t* f, const char* rest)
{
    size_t n = strlen(rest), p;
    if (rest[0] == '"' || n < 7 || rest[0] != 'a' || rest[1] != '/') return;
    if ((n - 5) % 2) return;
    p = (n - 5) / 2;
    if (rest[2 + p] != ' ' || rest[3 + p] != 'b' || rest[4 + p] != '/') return;
    if (memcmp(rest + 2, rest + 5 + p, p) != 0) return;
    replace_str(&f->path, xstrndup(rest + 2, p));
    replace_str(&f->old_path, xstrndup(rest + 2, p));
}

static int parse_hunk_header(const char* l, long* a, long* b, long* c, long* d, const char** ctx)
{
    const char* p = l + 3;
    char* e;
    if (*p != '-') return 0;
    *a = strtol(p + 1, &e, 10);
    p = e;
    *b = 1;
    if (*p == ',') { *b = strtol(p + 1, &e, 10); p = e; }
    if (p[0] != ' ' || p[1] != '+') return 0;
    p += 2;
    *c = strtol(p, &e, 10);
    p = e;
    *d = 1;
    if (*p == ',') { *d = strtol(p + 1, &e, 10); p = e; }
    p = strstr(p, "@@");
    if (!p) return 0;
    p += 2;
    while (*p == ' ') p++;
    *ctx = p;
    return 1;
}

static void mark_hunk(diff_state_t* st, file_t* f, int sym)
{
    if (st->keep_hunks && st->hunk_idx >= 0 && sym >= 0 && f->hunks[st->hunk_idx].sym < 0)
        f->hunks[st->hunk_idx].sym = sym;
}

static int ctx_symbol(diff_state_t* st, file_t* f, long new_line)
{
    if (!st->has_ctx) return -1;
    if (st->ctx_sym >= 0) {
        sym_extend(&f->syms[st->ctx_sym], new_line, 1);
        return st->ctx_sym;
    }
    st->ctx_sym = sym_touch(f, st->ctx_name, st->ctx_kind, CH_MOD, new_line, 1);
    return st->ctx_sym;
}

static void diff_plus(diff_state_t* st, file_t* f, const char* content)
{
    char nm[NAME_MAX_LEN];
    const char* kind;
    int s;
    if (detect_def(content, nm, sizeof nm, &kind)) {
        s = sym_touch(f, nm, kind, CH_ADD, st->new_line, 1);
        st->plus_sym = s;
    } else if (st->plus_sym >= 0) {
        s = st->plus_sym;
        sym_extend(&f->syms[s], st->new_line, 1);
    } else {
        s = ctx_symbol(st, f, st->new_line);
    }
    mark_hunk(st, f, s);
}

static void diff_minus(diff_state_t* st, file_t* f, const char* content)
{
    char nm[NAME_MAX_LEN];
    const char* kind;
    int s;
    if (detect_def(content, nm, sizeof nm, &kind)) {
        s = sym_touch(f, nm, kind, CH_DEL, st->old_line, 0);
        st->minus_sym = s;
    } else if (st->minus_sym >= 0) {
        s = st->minus_sym;
        sym_extend(&f->syms[s], st->old_line, 0);
    } else {
        s = ctx_symbol(st, f, st->new_line);
    }
    mark_hunk(st, f, s);
}

/* Feeds one line of `git diff`/`git log -p` (-U0) output into the model. */
static void diff_feed(diff_state_t* st, filelist_t* fl, const char* l)
{
    file_t* f = (st->cur >= 0) ? &fl->items[st->cur] : NULL;
    int is_null;

    if (st->in_hunk && f && (st->old_rem > 0 || st->new_rem > 0)) {
        char c = l[0];
        if (c == '+' && st->new_rem > 0) {
            f->additions++;
            diff_plus(st, f, l + 1);
            st->new_line++;
            st->new_rem--;
            return;
        }
        if (c == '-' && st->old_rem > 0) {
            f->deletions++;
            diff_minus(st, f, l + 1);
            st->old_line++;
            st->old_rem--;
            return;
        }
        if (c == ' ') {
            st->old_line++;
            st->new_line++;
            if (st->old_rem) st->old_rem--;
            if (st->new_rem) st->new_rem--;
            return;
        }
        if (c == '\\') return;
        st->in_hunk = 0;
    }
    if (l[0] == '\\') return;

    if (starts_with(l, "diff --git ")) {
        int ok;
        ARR_GROW(fl->items, fl->cap, fl->n + 1, ok);
        if (!ok) { st->oom = 1; return; }
        f = &fl->items[fl->n];
        memset(f, 0, sizeof *f);
        f->status = 'M';
        st->cur = (long)fl->n;
        fl->n++;
        st->in_hunk = 0;
        parse_diff_git_line(f, l + 11);
        return;
    }
    if (!f) return;

    if (starts_with(l, "@@ ")) {
        long a, b, c, d;
        const char* ctx = NULL;
        const char* kind;
        if (!parse_hunk_header(l, &a, &b, &c, &d, &ctx)) return;
        st->in_hunk = (b > 0 || d > 0);
        st->old_rem = b;
        st->new_rem = d;
        st->old_line = a;
        st->new_line = c;
        st->plus_sym = st->minus_sym = st->ctx_sym = -1;
        st->has_ctx = 0;
        if (ctx && *ctx && detect_def(ctx, st->ctx_name, sizeof st->ctx_name, &kind)) {
            st->has_ctx = 1;
            st->ctx_kind = kind;
        }
        st->hunk_idx = -1;
        if (st->keep_hunks && f->nhunks < MAX_HUNKS_PER_FILE) {
            int ok;
            ARR_GROW(f->hunks, f->chunks, f->nhunks + 1, ok);
            if (!ok) { st->oom = 1; return; }
            f->hunks[f->nhunks].old_start = a;
            f->hunks[f->nhunks].old_count = b;
            f->hunks[f->nhunks].new_start = c;
            f->hunks[f->nhunks].new_count = d;
            f->hunks[f->nhunks].sym = -1;
            st->hunk_idx = (long)f->nhunks;
            f->nhunks++;
        }
        return;
    }

    if (starts_with(l, "new file mode")) f->status = 'A';
    else if (starts_with(l, "deleted file mode")) f->status = 'D';
    else if (starts_with(l, "rename from ")) { replace_str(&f->old_path, git_unquote(l + 12)); f->status = 'R'; }
    else if (starts_with(l, "rename to ")) { replace_str(&f->path, git_unquote(l + 10)); f->status = 'R'; }
    else if (starts_with(l, "copy from ")) { replace_str(&f->old_path, git_unquote(l + 10)); f->status = 'C'; }
    else if (starts_with(l, "copy to ")) { replace_str(&f->path, git_unquote(l + 8)); f->status = 'C'; }
    else if (starts_with(l, "--- ")) {
        char* p = parse_diff_path(l + 4, 'a', &is_null);
        if (is_null) f->status = 'A';
        else replace_str(&f->old_path, p);
    } else if (starts_with(l, "+++ ")) {
        char* p = parse_diff_path(l + 4, 'b', &is_null);
        if (is_null) f->status = 'D';
        else replace_str(&f->path, p);
    } else if (starts_with(l, "Binary files ") || starts_with(l, "GIT binary patch")) {
        f->binary = 1;
    }
}

static const char* file_display_path(const file_t* f, const char** old_out)
{
    *old_out = NULL;
    if (f->status == 'R' || f->status == 'C') {
        *old_out = f->old_path;
        return f->path ? f->path : f->old_path;
    }
    if (f->status == 'D') return f->old_path ? f->old_path : f->path;
    return f->path ? f->path : f->old_path;
}

static const char* file_base_key(const file_t* f)
{
    if (f->status == 'A') return f->path ? f->path : f->old_path;
    return f->old_path ? f->old_path : f->path;
}

static const char* file_new_path(const file_t* f)
{
    if (f->status == 'D') return NULL;
    return f->path ? f->path : f->old_path;
}

/* ========================================================================== */
/* Graph model                                                                */
/* ========================================================================== */

typedef struct {
    char* name;
    char* hash;
    int   is_head;
} branch_t;

typedef struct {
    char*      hash;
    char*      short_hash;
    char*      author;
    char*      message;
    long long  ts;
    char**     parents;
    size_t     np, cp;
    char**     refs;
    size_t     nr, cr;
    filelist_t files;
} commit_t;

typedef struct {
    char*     repo_path;
    char*     head;
    branch_t* branches;
    size_t    nb, cb;
    commit_t* commits;
    size_t    nc, cc;
} graph_t;

static void graph_free(graph_t* g)
{
    size_t i, k;
    free(g->repo_path);
    free(g->head);
    for (i = 0; i < g->nb; i++) { free(g->branches[i].name); free(g->branches[i].hash); }
    free(g->branches);
    for (i = 0; i < g->nc; i++) {
        commit_t* c = &g->commits[i];
        free(c->hash); free(c->short_hash); free(c->author); free(c->message);
        for (k = 0; k < c->np; k++) free(c->parents[k]);
        free(c->parents);
        for (k = 0; k < c->nr; k++) free(c->refs[k]);
        free(c->refs);
        filelist_free(&c->files);
    }
    free(g->commits);
    memset(g, 0, sizeof *g);
}

static int push_str(char*** arr, size_t* n, size_t* cap, const char* s, size_t len)
{
    int ok;
    char* v;
    if (len == 0) return 1;
    v = xstrndup(s, len);
    if (!v) return 0;
    ARR_GROW(*arr, *cap, *n + 1, ok);
    if (!ok) { free(v); return 0; }
    (*arr)[(*n)++] = v;
    return 1;
}

/* Fields: hash \x1f short \x1f parents \x1f author \x1f ts \x1f refs \x1f subject */
static int parse_commit_header(const char* line, commit_t* c)
{
    const char* f[7];
    size_t fl[7];
    size_t nf = 0, i;
    const char* p = line;

    for (i = 0; i < 7; i++) { f[i] = ""; fl[i] = 0; }
    while (nf < 7) {
        const char* sep = (nf < 6) ? strchr(p, '\x1f') : NULL;
        f[nf] = p;
        if (sep) {
            fl[nf] = (size_t)(sep - p);
            p = sep + 1;
            nf++;
        } else {
            fl[nf] = strlen(p);
            nf++;
            break;
        }
    }

    c->hash = xstrndup(f[0], fl[0]);
    c->short_hash = xstrndup(f[1], fl[1]);
    c->author = xstrndup(f[3], fl[3]);
    c->message = xstrndup(f[6], fl[6]);
    if (!c->hash || !c->short_hash || !c->author || !c->message) return 0;
    {
        char* tsbuf = xstrndup(f[4], fl[4]);
        if (!tsbuf) return 0;
        c->ts = strtoll(tsbuf, NULL, 10);
        free(tsbuf);
    }
    { /* parents: space-separated */
        const char* s = f[2];
        const char* e = f[2] + fl[2];
        while (s < e) {
            const char* sp = (const char*)memchr(s, ' ', (size_t)(e - s));
            const char* te = sp ? sp : e;
            if (!push_str(&c->parents, &c->np, &c->cp, s, (size_t)(te - s))) return 0;
            s = sp ? sp + 1 : e;
        }
    }
    { /* refs: ", "-separated */
        const char* s = f[5];
        const char* e = f[5] + fl[5];
        while (s < e) {
            const char* sep = NULL;
            const char* t;
            for (t = s; t + 1 < e; t++) if (t[0] == ',' && t[1] == ' ') { sep = t; break; }
            if (!push_str(&c->refs, &c->nr, &c->cr, s, (size_t)((sep ? sep : e) - s))) return 0;
            s = sep ? sep + 2 : e;
        }
    }
    return 1;
}

static int load_graph(const char* top, int max_commits, graph_t* g)
{
    proc_t pr;
    int rc;
    line_iter_t it;
    const char* l;
    char maxbuf[48];

    g->repo_path = xstrdup(top);
    if (!g->repo_path) return nomem();

    { /* HEAD */
        const char* a[] = {"rev-parse", "--verify", "-q", "HEAD"};
        rc = git_run(top, a, 4, &pr);
        if (rc) return rc;
        if (pr.exit_code == 0) {
            g->head = first_line_dup(&pr.out);
            if (!g->head) { proc_free(&pr); return nomem(); }
        }
        proc_free(&pr);
    }

    { /* local branches */
        const char* a[] = {"for-each-ref", "--format=%(HEAD)%09%(objectname)%09%(refname:short)", "refs/heads"};
        rc = git_run(top, a, 3, &pr);
        if (rc) return rc;
        if (pr.exit_code != 0) {
            set_error("git for-each-ref failed: %s", sb_cstr(&pr.err));
            proc_free(&pr);
            return CHRONOS_ERR_GIT;
        }
        li_init(&it, &pr.out);
        while ((l = li_next(&it)) != NULL) {
            const char* t1 = strchr(l, '\t');
            const char* t2 = t1 ? strchr(t1 + 1, '\t') : NULL;
            branch_t* b;
            int ok;
            if (!t1 || !t2 || !t2[1]) continue;
            ARR_GROW(g->branches, g->cb, g->nb + 1, ok);
            if (!ok) { li_free(&it); proc_free(&pr); return nomem(); }
            b = &g->branches[g->nb++];
            b->is_head = (l[0] == '*');
            b->hash = xstrndup(t1 + 1, (size_t)(t2 - t1 - 1));
            b->name = xstrdup(t2 + 1);
            if (!b->hash || !b->name) { li_free(&it); proc_free(&pr); return nomem(); }
        }
        if (it.line.oom) { li_free(&it); proc_free(&pr); return nomem(); }
        li_free(&it);
        proc_free(&pr);
    }

    if (!g->head && g->nb == 0) return CHRONOS_OK; /* empty repository */

    snprintf(maxbuf, sizeof maxbuf, "--max-count=%d", max_commits);
    {
        const char* a[24];
        size_t n = 0;
        a[n++] = "log";
        a[n++] = "--branches";
        a[n++] = "--tags";
        a[n++] = "--remotes";
        if (g->head) a[n++] = "HEAD";
        a[n++] = "--topo-order";
        a[n++] = maxbuf;
        a[n++] = "--format=%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ct%x1f%D%x1f%s";
        a[n++] = "-p";
        a[n++] = "-U0";
        a[n++] = "-M";
        a[n++] = "--diff-merges=first-parent";
        a[n++] = "--no-color";
        a[n++] = "--no-ext-diff";
        a[n++] = "--no-textconv";
        a[n++] = "--src-prefix=a/";
        a[n++] = "--dst-prefix=b/";
        a[n++] = "--";
        rc = git_run(top, a, n, &pr);
    }
    if (rc) return rc;
    if (pr.exit_code != 0) {
        set_error("git log failed: %s", sb_cstr(&pr.err));
        proc_free(&pr);
        return CHRONOS_ERR_GIT;
    }

    {
        commit_t* cur = NULL;
        diff_state_t st;
        diff_state_init(&st, 0);
        li_init(&it, &pr.out);
        while ((l = li_next(&it)) != NULL) {
            if (l[0] == '\x1e') {
                int ok;
                ARR_GROW(g->commits, g->cc, g->nc + 1, ok);
                if (!ok) { li_free(&it); proc_free(&pr); return nomem(); }
                cur = &g->commits[g->nc++];
                memset(cur, 0, sizeof *cur);
                if (!parse_commit_header(l + 1, cur)) { li_free(&it); proc_free(&pr); return nomem(); }
                diff_state_init(&st, 0);
                continue;
            }
            if (cur) {
                diff_feed(&st, &cur->files, l);
                if (st.oom) { li_free(&it); proc_free(&pr); return nomem(); }
            }
        }
        if (it.line.oom) { li_free(&it); proc_free(&pr); return nomem(); }
        li_free(&it);
    }
    proc_free(&pr);
    return CHRONOS_OK;
}

/* ========================================================================== */
/* Merge analysis model                                                       */
/* ========================================================================== */

enum { RS_CLEAN = 0, RS_AUTO = 1, RS_TRUE = 2 };

typedef struct {
    char* file_path;
    char* key_path;
    char* symbol;
    int   status;
    int   has_ours, has_theirs;
    long  ours_lo, ours_hi, theirs_lo, theirs_hi;
    char* base_snip;
    char* ours_snip;
    char* theirs_snip;
} conflict_t;

typedef struct {
    int         active;
    char*       source;
    char*       target;
    char*       base;
    int         can_auto;
    conflict_t* items;
    size_t      n, cap;
} merge_t;

typedef struct {
    const char* repo;
    const char* base_oid;
    const char* ours_oid;
    const char* theirs_oid;
    int         have_git;
    char**      conflicted;
    size_t      nconf;
} merge_ctx_t;

typedef struct { size_t o, t; } pair_t;

typedef struct {
    int    loaded;
    int    ok;
    sbuf_t text;
} blob_cache_t;

static void merge_free(merge_t* m)
{
    size_t i;
    for (i = 0; i < m->n; i++) {
        conflict_t* c = &m->items[i];
        free(c->file_path); free(c->key_path); free(c->symbol);
        free(c->base_snip); free(c->ours_snip); free(c->theirs_snip);
    }
    free(m->items);
    free(m->source); free(m->target); free(m->base);
    memset(m, 0, sizeof *m);
}

static const char* status_name(int s)
{
    return s == RS_TRUE ? "TRUE_COLLISION" : (s == RS_AUTO ? "AUTO_RESOLVABLE" : "CLEAN");
}

static conflict_t* push_conflict(merge_t* m, const char* file_path, const char* key_path,
                                 const char* symbol, int status)
{
    int ok;
    conflict_t* c;
    ARR_GROW(m->items, m->cap, m->n + 1, ok);
    if (!ok) return NULL;
    c = &m->items[m->n];
    memset(c, 0, sizeof *c);
    c->file_path = xstrdup(file_path ? file_path : "");
    c->key_path = xstrdup(key_path ? key_path : "");
    c->symbol = symbol ? xstrdup(symbol) : NULL;
    c->status = status;
    if (!c->file_path || !c->key_path || (symbol && !c->symbol)) {
        free(c->file_path); free(c->key_path); free(c->symbol);
        return NULL;
    }
    m->n++;
    return c;
}

static void disp_range(long start, long count, long* lo, long* hi)
{
    if (count > 0) { *lo = start; *hi = start + count - 1; }
    else { *lo = *hi = (start < 1) ? 1 : start; }
}

/* Base (pre-image) interval; an insertion after line s is the empty [s+1, s]. */
static void base_interval(const hunk_t* h, long* lo, long* hi)
{
    if (h->old_count > 0) { *lo = h->old_start; *hi = h->old_start + h->old_count - 1; }
    else { *lo = h->old_start + 1; *hi = h->old_start; }
}

static void range_add(int* has, long* lo, long* hi, long a, long b)
{
    if (!*has) { *lo = a; *hi = b; *has = 1; return; }
    if (a < *lo) *lo = a;
    if (b > *hi) *hi = b;
}

static const char* hunk_key(const file_t* f, size_t i)
{
    int s = f->hunks[i].sym;
    return (s >= 0) ? f->syms[s].name : NULL;
}

static int add_key(const char*** keys, size_t* n, size_t* cap, const char* k)
{
    size_t i;
    int ok;
    for (i = 0; i < *n; i++) if (key_eq((*keys)[i], k)) return 1;
    ARR_GROW(*keys, *cap, *n + 1, ok);
    if (!ok) return 0;
    (*keys)[(*n)++] = k;
    return 1;
}

/*
 * Sweep both sorted hunk lists and record every colliding pair. Like git,
 * overlapping OR directly adjacent base ranges are treated as colliding.
 */
static int find_pairs(const file_t* fo, const file_t* ft, pair_t** out, size_t* np)
{
    size_t i = 0, j = 0, cap = 0;
    int ok;
    *out = NULL;
    *np = 0;
    while (i < fo->nhunks && j < ft->nhunks) {
        long al, ah, bl, bh;
        base_interval(&fo->hunks[i], &al, &ah);
        base_interval(&ft->hunks[j], &bl, &bh);
        if (al <= bh + 1 && bl <= ah + 1) {
            ARR_GROW(*out, cap, *np + 1, ok);
            if (!ok) return 0;
            (*out)[*np].o = i;
            (*out)[*np].t = j;
            (*np)++;
        }
        if (ah < bh) i++;
        else j++;
    }
    return 1;
}

static int path_conflicted(const merge_ctx_t* cx, const char* p)
{
    size_t i;
    if (!p) return 0;
    for (i = 0; i < cx->nconf; i++) if (strcmp(cx->conflicted[i], p) == 0) return 1;
    return 0;
}

static const sbuf_t* blob_get(blob_cache_t* bc, const char* repo, const char* rev, const char* path)
{
    if (!bc->loaded) {
        bc->loaded = 1;
        if (rev && path) {
            sbuf_t spec = {0};
            proc_t pr;
            sb_puts(&spec, rev);
            sb_putc(&spec, ':');
            sb_puts(&spec, path);
            if (!spec.oom) {
                const char* a[] = {"cat-file", "blob", spec.data};
                if (git_run(repo, a, 3, &pr) == CHRONOS_OK) {
                    if (pr.exit_code == 0) {
                        bc->text = pr.out;
                        memset(&pr.out, 0, sizeof pr.out);
                        bc->ok = 1;
                    }
                    proc_free(&pr);
                }
            }
            sb_free(&spec);
        }
    }
    return bc->ok ? &bc->text : NULL;
}

static char* extract_lines(const sbuf_t* text, long lo, long hi)
{
    sbuf_t o = {0};
    const char* p;
    const char* end;
    long ln = 1;
    if (!text || !text->data) return xstrdup("");
    if (lo < 1) lo = 1;
    if (hi < lo) return xstrdup("");
    if (hi - lo + 1 > MAX_SNIPPET_LINES) hi = lo + MAX_SNIPPET_LINES - 1;
    p = text->data;
    end = text->data + text->len;
    while (p < end && ln <= hi) {
        const char* nl = (const char*)memchr(p, '\n', (size_t)(end - p));
        const char* e = nl ? nl : end;
        if (ln >= lo) {
            size_t n = (size_t)(e - p);
            if (n && p[n - 1] == '\r') n--;
            if (o.len + n > MAX_SNIPPET_BYTES) { sb_puts(&o, "\n[... snippet truncated ...]"); break; }
            if (ln > lo) sb_putc(&o, '\n');
            sb_putn(&o, p, n);
        }
        ln++;
        p = nl ? nl + 1 : end;
    }
    if (o.oom) { sb_free(&o); return NULL; }
    return o.data ? o.data : xstrdup("");
}

static int analyze_pair(merge_t* m, const merge_ctx_t* cx, const file_t* fo, const file_t* ft)
{
    const file_t* any = fo ? fo : ft;
    const char* key_path = file_base_key(any);
    const char* opath = fo ? file_new_path(fo) : NULL;
    const char* tpath = ft ? file_new_path(ft) : NULL;
    const char* shown = opath ? opath : (tpath ? tpath : key_path);
    int git_conf = path_conflicted(cx, key_path) || path_conflicted(cx, opath) || path_conflicted(cx, tpath);
    const char** keys = NULL;
    size_t nk = 0, ck = 0;
    pair_t* pairs = NULL;
    size_t np = 0;
    unsigned char* so = NULL;
    unsigned char* sth = NULL;
    blob_cache_t bb, bo, bt;
    size_t i, k;
    int rc = CHRONOS_OK;
    conflict_t* c;

    memset(&bb, 0, sizeof bb);
    memset(&bo, 0, sizeof bo);
    memset(&bt, 0, sizeof bt);

    /* Only one branch touched this file: CLEAN per symbol. */
    if (!fo || !ft) {
        for (i = 0; i < any->nhunks; i++)
            if (!add_key(&keys, &nk, &ck, hunk_key(any, i))) { rc = nomem(); goto done; }
        if (nk == 0) {
            if (!push_conflict(m, shown, key_path, NULL, RS_CLEAN)) rc = nomem();
            goto done;
        }
        for (k = 0; k < nk; k++) {
            int has = 0;
            long lo = 0, hi = 0;
            for (i = 0; i < any->nhunks; i++) {
                if (key_eq(hunk_key(any, i), keys[k])) {
                    long a, b;
                    disp_range(any->hunks[i].new_start, any->hunks[i].new_count, &a, &b);
                    range_add(&has, &lo, &hi, a, b);
                }
            }
            c = push_conflict(m, shown, key_path, keys[k], RS_CLEAN);
            if (!c) { rc = nomem(); goto done; }
            if (fo) { c->has_ours = has; c->ours_lo = lo; c->ours_hi = hi; }
            else { c->has_theirs = has; c->theirs_lo = lo; c->theirs_hi = hi; }
        }
        goto done;
    }

    /* File-level special cases. */
    if (fo->status == 'D' && ft->status == 'D') {
        if (!push_conflict(m, shown, key_path, NULL, RS_AUTO)) rc = nomem();
        goto done;
    }
    if ((fo->status == 'D') != (ft->status == 'D') || fo->binary || ft->binary) {
        int s = (cx->have_git && !git_conf) ? RS_AUTO : RS_TRUE;
        if (!push_conflict(m, shown, key_path, NULL, s)) rc = nomem();
        goto done;
    }

    if (!find_pairs(fo, ft, &pairs, &np)) { rc = nomem(); goto done; }
    for (i = 0; i < fo->nhunks; i++)
        if (!add_key(&keys, &nk, &ck, hunk_key(fo, i))) { rc = nomem(); goto done; }
    for (i = 0; i < ft->nhunks; i++)
        if (!add_key(&keys, &nk, &ck, hunk_key(ft, i))) { rc = nomem(); goto done; }

    if (nk == 0) { /* e.g. both renamed, no content hunks */
        if (!push_conflict(m, shown, key_path, NULL, git_conf ? RS_TRUE : RS_AUTO)) rc = nomem();
        goto done;
    }

    so = (unsigned char*)calloc(fo->nhunks + 1, 1);
    sth = (unsigned char*)calloc(ft->nhunks + 1, 1);
    if (!so || !sth) { rc = nomem(); goto done; }

    for (k = 0; k < nk; k++) {
        const char* key = keys[k];
        int has_o = 0, has_t = 0, has_b = 0, collided = 0, own_o = 0, own_t = 0, st;
        long olo = 0, ohi = 0, tlo = 0, thi = 0, blo = 0, bhi = 0;
        size_t p;

        memset(so, 0, fo->nhunks + 1);
        memset(sth, 0, ft->nhunks + 1);
        for (i = 0; i < fo->nhunks; i++) if (key_eq(hunk_key(fo, i), key)) { so[i] = 1; own_o = 1; }
        for (i = 0; i < ft->nhunks; i++) if (key_eq(hunk_key(ft, i), key)) { sth[i] = 1; own_t = 1; }

        for (p = 0; p < np; p++) {
            int ko = key_eq(hunk_key(fo, pairs[p].o), key);
            int kt = key_eq(hunk_key(ft, pairs[p].t), key);
            if (ko || kt) {
                long a, b;
                collided = 1;
                so[pairs[p].o] = 1;
                sth[pairs[p].t] = 1;
                disp_range(fo->hunks[pairs[p].o].old_start, fo->hunks[pairs[p].o].old_count, &a, &b);
                range_add(&has_b, &blo, &bhi, a, b);
                disp_range(ft->hunks[pairs[p].t].old_start, ft->hunks[pairs[p].t].old_count, &a, &b);
                range_add(&has_b, &blo, &bhi, a, b);
            }
        }
        for (i = 0; i < fo->nhunks; i++) {
            if (so[i]) {
                long a, b;
                disp_range(fo->hunks[i].new_start, fo->hunks[i].new_count, &a, &b);
                range_add(&has_o, &olo, &ohi, a, b);
            }
        }
        for (i = 0; i < ft->nhunks; i++) {
            if (sth[i]) {
                long a, b;
                disp_range(ft->hunks[i].new_start, ft->hunks[i].new_count, &a, &b);
                range_add(&has_t, &tlo, &thi, a, b);
            }
        }

        if (collided) st = (cx->have_git && !git_conf) ? RS_AUTO : RS_TRUE;
        else if (own_o && own_t) st = RS_AUTO;
        else st = RS_CLEAN;

        c = push_conflict(m, shown, key_path, key, st);
        if (!c) { rc = nomem(); goto done; }
        c->has_ours = has_o; c->ours_lo = olo; c->ours_hi = ohi;
        c->has_theirs = has_t; c->theirs_lo = tlo; c->theirs_hi = thi;

        if (st == RS_TRUE) {
            const sbuf_t* tb;
            tb = has_b ? blob_get(&bb, cx->repo, cx->base_oid, key_path) : NULL;
            c->base_snip = tb ? extract_lines(tb, blo, bhi) : NULL;
            tb = has_o ? blob_get(&bo, cx->repo, cx->ours_oid, opath) : NULL;
            c->ours_snip = tb ? extract_lines(tb, olo, ohi) : NULL;
            tb = has_t ? blob_get(&bt, cx->repo, cx->theirs_oid, tpath) : NULL;
            c->theirs_snip = tb ? extract_lines(tb, tlo, thi) : NULL;
        }
    }

done:
    free(keys);
    free(pairs);
    free(so);
    free(sth);
    sb_free(&bb.text);
    sb_free(&bo.text);
    sb_free(&bt.text);
    return rc;
}

static int run_diff(const char* repo, const char* from, const char* to, filelist_t* fl)
{
    const char* a[] = {
        "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--no-textconv",
        "--src-prefix=a/", "--dst-prefix=b/", from, to, "--"
    };
    proc_t pr;
    line_iter_t it;
    const char* l;
    diff_state_t st;
    int rc = git_run(repo, a, sizeof a / sizeof a[0], &pr);
    if (rc) return rc;
    if (pr.exit_code != 0) {
        set_error("git diff failed: %s", sb_cstr(&pr.err));
        proc_free(&pr);
        return CHRONOS_ERR_GIT;
    }
    diff_state_init(&st, 1);
    li_init(&it, &pr.out);
    while ((l = li_next(&it)) != NULL) {
        diff_feed(&st, fl, l);
        if (st.oom) break;
    }
    rc = (st.oom || it.line.oom) ? nomem() : CHRONOS_OK;
    li_free(&it);
    proc_free(&pr);
    return rc;
}

static int run_merge_tree(const char* repo, const char* ours, const char* theirs,
                          int* have, int* clean, char*** paths, size_t* np)
{
    const char* a[] = {"merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs};
    proc_t pr;
    size_t cap = 0;
    int rc;
    *have = 0;
    *clean = 1;
    *paths = NULL;
    *np = 0;
    rc = git_run(repo, a, 6, &pr);
    if (rc) return rc;
    if (pr.exit_code == 0 || pr.exit_code == 1) {
        line_iter_t it;
        const char* l;
        int first = 1;
        *have = 1;
        *clean = (pr.exit_code == 0);
        li_init(&it, &pr.out);
        while ((l = li_next(&it)) != NULL) {
            char* u;
            size_t k;
            int dup = 0, ok;
            if (first) { first = 0; continue; } /* tree OID */
            if (!*l) break;
            u = git_unquote(l);
            if (!u) { li_free(&it); proc_free(&pr); return nomem(); }
            for (k = 0; k < *np; k++) if (strcmp((*paths)[k], u) == 0) { dup = 1; break; }
            if (dup) { free(u); continue; }
            ARR_GROW(*paths, cap, *np + 1, ok);
            if (!ok) { free(u); li_free(&it); proc_free(&pr); return nomem(); }
            (*paths)[(*np)++] = u;
        }
        li_free(&it);
    }
    /* Any other exit code (e.g. git < 2.38) => fall back to heuristic engine. */
    proc_free(&pr);
    return CHRONOS_OK;
}

/* ========================================================================== */
/* JSON output                                                                */
/* ========================================================================== */

static const char* change_name(int c)
{
    return c == CH_ADD ? "ADDED" : (c == CH_DEL ? "DELETED" : "MODIFIED");
}

static void json_file(sbuf_t* j, const file_t* f)
{
    const char* old;
    const char* path = file_display_path(f, &old);
    char st[2];
    size_t i;
    st[0] = f->status;
    st[1] = '\0';
    sb_puts(j, "{\"path\":");
    json_str_or_null(j, path);
    sb_puts(j, ",\"oldPath\":");
    json_str_or_null(j, old);
    sb_puts(j, ",\"status\":");
    json_str(j, st);
    sb_puts(j, ",\"additions\":");
    sb_put_i64(j, f->additions);
    sb_puts(j, ",\"deletions\":");
    sb_put_i64(j, f->deletions);
    sb_puts(j, ",\"symbolsTouched\":[");
    for (i = 0; i < f->nsyms; i++) {
        const sym_t* s = &f->syms[i];
        if (i) sb_putc(j, ',');
        sb_puts(j, "{\"name\":");
        json_str(j, s->name);
        sb_puts(j, ",\"kind\":");
        json_str(j, s->kind);
        sb_puts(j, ",\"changeType\":");
        json_str(j, change_name(s->change));
        sb_puts(j, ",\"startLine\":");
        sb_put_i64(j, s->start);
        sb_puts(j, ",\"endLine\":");
        sb_put_i64(j, s->end);
        sb_putc(j, '}');
    }
    sb_puts(j, "]}");
}

static void json_range(sbuf_t* j, int has, long lo, long hi)
{
    if (!has) { sb_puts(j, "null"); return; }
    sb_putc(j, '[');
    sb_put_i64(j, lo);
    sb_putc(j, ',');
    sb_put_i64(j, hi);
    sb_putc(j, ']');
}

static void json_merge(sbuf_t* j, const merge_t* m)
{
    size_t i;
    if (!m || !m->active) {
        sb_puts(j, "{\"active\":false,\"sourceBranch\":null,\"targetBranch\":null,"
                   "\"mergeBase\":null,\"canAutoMerge\":true,\"conflicts\":[]}");
        return;
    }
    sb_puts(j, "{\"active\":true,\"sourceBranch\":");
    json_str_or_null(j, m->source);
    sb_puts(j, ",\"targetBranch\":");
    json_str_or_null(j, m->target);
    sb_puts(j, ",\"mergeBase\":");
    json_str_or_null(j, m->base);
    sb_puts(j, ",\"canAutoMerge\":");
    json_bool(j, m->can_auto);
    sb_puts(j, ",\"conflicts\":[");
    for (i = 0; i < m->n; i++) {
        const conflict_t* c = &m->items[i];
        if (i) sb_putc(j, ',');
        sb_puts(j, "\n{\"filePath\":");
        json_str(j, c->file_path);
        sb_puts(j, ",\"symbolName\":");
        json_str_or_null(j, c->symbol);
        sb_puts(j, ",\"resolutionStatus\":");
        json_str(j, status_name(c->status));
        sb_puts(j, ",\"oursRange\":");
        json_range(j, c->has_ours, c->ours_lo, c->ours_hi);
        sb_puts(j, ",\"theirsRange\":");
        json_range(j, c->has_theirs, c->theirs_lo, c->theirs_hi);
        sb_puts(j, ",\"baseSnippet\":");
        json_str(j, c->base_snip ? c->base_snip : "");
        sb_puts(j, ",\"oursSnippet\":");
        json_str(j, c->ours_snip ? c->ours_snip : "");
        sb_puts(j, ",\"theirsSnippet\":");
        json_str(j, c->theirs_snip ? c->theirs_snip : "");
        sb_putc(j, '}');
    }
    sb_puts(j, "]}");
}

static void json_graph(sbuf_t* j, const graph_t* g, const merge_t* m)
{
    size_t i, k;
    sb_puts(j, "{\"repoPath\":");
    json_str(j, g->repo_path);
    sb_puts(j, ",\"head\":");
    json_str_or_null(j, g->head);
    sb_puts(j, ",\"generatedAt\":");
    sb_put_i64(j, (long long)time(NULL));

    sb_puts(j, ",\"branches\":[");
    for (i = 0; i < g->nb; i++) {
        const branch_t* b = &g->branches[i];
        if (i) sb_putc(j, ',');
        sb_puts(j, "{\"name\":");
        json_str(j, b->name);
        sb_puts(j, ",\"commitHash\":");
        json_str(j, b->hash);
        sb_puts(j, ",\"isHead\":");
        json_bool(j, b->is_head);
        sb_putc(j, '}');
    }

    sb_puts(j, "],\"commits\":[");
    for (i = 0; i < g->nc; i++) {
        const commit_t* c = &g->commits[i];
        if (i) sb_putc(j, ',');
        sb_puts(j, "\n{\"hash\":");
        json_str(j, c->hash);
        sb_puts(j, ",\"shortHash\":");
        json_str(j, c->short_hash);
        sb_puts(j, ",\"parents\":[");
        for (k = 0; k < c->np; k++) {
            if (k) sb_putc(j, ',');
            json_str(j, c->parents[k]);
        }
        sb_puts(j, "],\"author\":");
        json_str(j, c->author);
        sb_puts(j, ",\"timestamp\":");
        sb_put_i64(j, c->ts);
        sb_puts(j, ",\"message\":");
        json_str(j, c->message);
        sb_puts(j, ",\"refs\":[");
        for (k = 0; k < c->nr; k++) {
            if (k) sb_putc(j, ',');
            json_str(j, c->refs[k]);
        }
        sb_puts(j, "],\"filesChanged\":[");
        for (k = 0; k < c->files.n; k++) {
            if (k) sb_putc(j, ',');
            json_file(j, &c->files.items[k]);
        }
        sb_puts(j, "]}");
    }

    sb_puts(j, "],\"mergeAnalysis\":");
    json_merge(j, m);
    sb_puts(j, "}\n");
}

/* ========================================================================== */
/* Atomic file write                                                          */
/* ========================================================================== */

static int write_file_atomic(const char* path, const char* data, size_t len)
{
    sbuf_t tmp = {0};
    FILE* f = NULL;
    int rc = CHRONOS_ERR_IO;
#if defined(_WIN32)
    wchar_t* wtmp = NULL;
    wchar_t* wpath = NULL;
#endif

    sb_puts(&tmp, path);
    sb_puts(&tmp, ".chronos-tmp");
    if (tmp.oom) { sb_free(&tmp); return nomem(); }

#if defined(_WIN32)
    wtmp = utf8_to_wide(tmp.data);
    wpath = utf8_to_wide(path);
    if (!wtmp || !wpath) { set_error("invalid output path encoding: %s", path); goto done; }
    f = _wfopen(wtmp, L"wb");
#else
    f = fopen(tmp.data, "wb");
#endif
    if (!f) {
        set_error("cannot open '%s' for writing: %s", tmp.data, strerror(errno));
        goto done;
    }
    if (len && fwrite(data, 1, len, f) != len) {
        fclose(f);
        set_error("write failed for '%s'", tmp.data);
        goto remove_tmp;
    }
    if (fclose(f) != 0) {
        set_error("close failed for '%s'", tmp.data);
        goto remove_tmp;
    }
#if defined(_WIN32)
    if (!MoveFileExW(wtmp, wpath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        set_error("cannot replace '%s' (Win32 error %lu)", path, (unsigned long)GetLastError());
        goto remove_tmp;
    }
#else
    if (rename(tmp.data, path) != 0) {
        set_error("cannot replace '%s': %s", path, strerror(errno));
        goto remove_tmp;
    }
#endif
    rc = CHRONOS_OK;
    goto done;

remove_tmp:
#if defined(_WIN32)
    _wremove(wtmp);
#else
    remove(tmp.data);
#endif

done:
#if defined(_WIN32)
    free(wtmp);
    free(wpath);
#endif
    sb_free(&tmp);
    return rc;
}

/* ========================================================================== */
/* Export pipeline                                                            */
/* ========================================================================== */

static int export_internal(const char* top, const char* out_path, int max_commits, const merge_t* m)
{
    graph_t g;
    sbuf_t j = {0};
    int rc;

    if (!out_path || !*out_path) {
        set_error("output_json_path is required");
        return CHRONOS_ERR_ARGS;
    }
    if (max_commits <= 0) max_commits = CHRONOS_DEFAULT_MAX_COMMITS;
    if (max_commits > MAX_COMMITS_HARD_CAP) max_commits = MAX_COMMITS_HARD_CAP;

    memset(&g, 0, sizeof g);
    rc = load_graph(top, max_commits, &g);
    if (rc == CHRONOS_OK) {
        json_graph(&j, &g, m);
        if (j.oom) rc = nomem();
        else rc = write_file_atomic(out_path, j.data, j.len);
    }
    sb_free(&j);
    graph_free(&g);
    return rc;
}

/* ========================================================================== */
/* Live command execution: tokenizer + whitelist                              */
/* ========================================================================== */

static void free_tokens(char** toks, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) free(toks[i]);
    free(toks);
}

/* Splits on whitespace; supports "double" and 'single' quoting.
 * Inside double quotes only \" is an escape (Windows paths stay literal). */
static int tokenize_args(const char* s, char*** out, size_t* nout)
{
    char** toks = NULL;
    size_t n = 0, cap = 0;
    sbuf_t cur = {0};
    int in_tok = 0, ok;
    char quote = 0;
    const char* p;

    *out = NULL;
    *nout = 0;
    if (strlen(s) > 16384) { set_error("git arguments are too long"); return CHRONOS_ERR_ARGS; }

    for (p = s;; p++) {
        char c = *p;
        if (c == '\0') {
            if (quote) {
                set_error("unterminated quote in git arguments");
                sb_free(&cur);
                free_tokens(toks, n);
                return CHRONOS_ERR_ARGS;
            }
            break;
        }
        if (quote) {
            if (c == quote) { quote = 0; continue; }
            if (quote == '"' && c == '\\' && p[1] == '"') { p++; sb_putc(&cur, '"'); continue; }
            sb_putc(&cur, c);
            continue;
        }
        if (c == '"' || c == '\'') { quote = c; in_tok = 1; continue; }
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            if (!in_tok) continue;
        } else {
            sb_putc(&cur, c);
            in_tok = 1;
            continue;
        }
        /* end of token */
        if (n >= MAX_GIT_TOKENS) {
            set_error("too many git arguments");
            sb_free(&cur);
            free_tokens(toks, n);
            return CHRONOS_ERR_ARGS;
        }
        ARR_GROW(toks, cap, n + 1, ok);
        if (!ok || cur.oom) { sb_free(&cur); free_tokens(toks, n); return nomem(); }
        toks[n] = xstrndup(cur.data ? cur.data : "", cur.len);
        if (!toks[n]) { sb_free(&cur); free_tokens(toks, n); return nomem(); }
        n++;
        cur.len = 0;
        in_tok = 0;
    }
    if (in_tok) {
        if (n >= MAX_GIT_TOKENS) {
            set_error("too many git arguments");
            sb_free(&cur);
            free_tokens(toks, n);
            return CHRONOS_ERR_ARGS;
        }
        ARR_GROW(toks, cap, n + 1, ok);
        if (!ok || cur.oom) { sb_free(&cur); free_tokens(toks, n); return nomem(); }
        toks[n] = xstrndup(cur.data ? cur.data : "", cur.len);
        if (!toks[n]) { sb_free(&cur); free_tokens(toks, n); return nomem(); }
        n++;
    }
    sb_free(&cur);
    *out = toks;
    *nout = n;
    return CHRONOS_OK;
}

static int validate_git_tokens(char** toks, size_t n)
{
    static const char* const allowed[] = {
        "status", "log", "show", "diff", "branch", "checkout", "switch", "restore",
        "add", "rm", "mv", "commit", "merge", "rebase", "cherry-pick", "revert",
        "reset", "tag", "stash", "fetch", "pull", "push", "remote", "blame",
        "shortlog", "describe", "rev-parse", "ls-files", "reflog", NULL
    };
    static const char* const blocked_prefix[] = {
        "--upload-pack", "--receive-pack", "--exec", "--output", "--git-dir",
        "--work-tree", "--namespace", "--super-prefix", "--config-env",
        "--open-files-in-pager", "--no-index", NULL
    };
    size_t i, k;

    if (n == 0) { set_error("empty git command"); return CHRONOS_ERR_ARGS; }
    if (!in_list(toks[0], allowed)) {
        set_error("git subcommand '%s' is not allowed", toks[0]);
        return CHRONOS_ERR_FORBIDDEN;
    }
    for (i = 1; i < n; i++) {
        const char* t = toks[i];
        for (k = 0; blocked_prefix[k]; k++) {
            if (starts_with(t, blocked_prefix[k])) {
                set_error("git option '%s' is not allowed", t);
                return CHRONOS_ERR_FORBIDDEN;
            }
        }
        /* rebase -x / --exec runs arbitrary shell commands */
        if (strcmp(toks[0], "rebase") == 0 && t[0] == '-' && t[1] != '-' && strchr(t, 'x')) {
            set_error("git rebase -x is not allowed");
            return CHRONOS_ERR_FORBIDDEN;
        }
    }
    return CHRONOS_OK;
}

/* ========================================================================== */
/* Public API                                                                 */
/* ========================================================================== */

int chronos_export_graph(const char* repo_path, const char* output_json_path, int max_commits)
{
    char* top = NULL;
    int rc;
    clear_error();
    if (!output_json_path || !*output_json_path) {
        set_error("output_json_path is required");
        return CHRONOS_ERR_ARGS;
    }
    rc = resolve_repo(repo_path, &top);
    if (rc == CHRONOS_OK) rc = export_internal(top, output_json_path, max_commits, NULL);
    free(top);
    return rc;
}

char* chronos_run_git_cmd(const char* repo_path, const char* git_args, const char* output_json_path)
{
    char** toks = NULL;
    size_t ntok = 0, i;
    char* top = NULL;
    proc_t pr;
    int have_proc = 0;
    int rc;
    int graph_status = CHRONOS_ERR_ARGS;
    int exit_code = -1;
    int out_trunc = 0;
    size_t out_len = 0, err_len = 0;
    sbuf_t res = {0};
    sbuf_t cmd = {0};
    char err_msg[2048];
    char graph_err[2048];

    err_msg[0] = '\0';
    graph_err[0] = '\0';
    memset(&pr, 0, sizeof pr);
    clear_error();
    if (!git_args) git_args = "";

    rc = resolve_repo(repo_path, &top);
    if (rc == CHRONOS_OK) rc = tokenize_args(git_args, &toks, &ntok);
    if (rc == CHRONOS_OK) rc = validate_git_tokens(toks, ntok);
    if (rc == CHRONOS_OK) {
        rc = git_run(top, (const char* const*)toks, ntok, &pr);
        if (rc == CHRONOS_OK) { have_proc = 1; exit_code = pr.exit_code; }
    }
    if (rc != CHRONOS_OK) snprintf(err_msg, sizeof err_msg, "%s", g_last_error);

    sb_puts(&cmd, "git");
    for (i = 0; i < ntok; i++) { sb_putc(&cmd, ' '); sb_puts(&cmd, toks[i]); }

    /* Refresh the graph whenever the command actually ran (success or not). */
    if (have_proc) {
        if (output_json_path && *output_json_path) {
            graph_status = export_internal(top, output_json_path, CHRONOS_DEFAULT_MAX_COMMITS, NULL);
            if (graph_status != CHRONOS_OK) snprintf(graph_err, sizeof graph_err, "%s", g_last_error);
        } else {
            snprintf(graph_err, sizeof graph_err, "output_json_path not provided; graph not refreshed");
        }
    } else {
        snprintf(graph_err, sizeof graph_err, "command did not run; graph not refreshed");
    }

    if (have_proc) {
        out_len = pr.out.len;
        err_len = pr.err.len;
        if (out_len > MAX_CMD_OUTPUT_BYTES) { out_len = MAX_CMD_OUTPUT_BYTES; out_trunc = 1; }
        if (err_len > MAX_CMD_OUTPUT_BYTES) err_len = MAX_CMD_OUTPUT_BYTES;
    }

    sb_puts(&res, "{\"ok\":");
    json_bool(&res, rc == CHRONOS_OK && exit_code == 0);
    sb_puts(&res, ",\"exitCode\":");
    sb_put_i64(&res, exit_code);
    sb_puts(&res, ",\"command\":");
    json_str(&res, sb_cstr(&cmd));
    sb_puts(&res, ",\"stdout\":");
    json_strn(&res, have_proc ? sb_cstr(&pr.out) : "", out_len);
    sb_puts(&res, ",\"stderr\":");
    json_strn(&res, have_proc ? sb_cstr(&pr.err) : "", err_len);
    sb_puts(&res, ",\"stdoutTruncated\":");
    json_bool(&res, out_trunc);
    sb_puts(&res, ",\"graphStatus\":");
    sb_put_i64(&res, graph_status);
    sb_puts(&res, ",\"graphPath\":");
    json_str_or_null(&res, (output_json_path && *output_json_path) ? output_json_path : NULL);
    sb_puts(&res, ",\"graphError\":");
    json_str_or_null(&res, graph_err[0] ? graph_err : NULL);
    sb_puts(&res, ",\"error\":");
    json_str_or_null(&res, err_msg[0] ? err_msg : NULL);
    sb_puts(&res, "}");

    if (have_proc) proc_free(&pr);
    free_tokens(toks, ntok);
    free(top);
    sb_free(&cmd);

    if (err_msg[0]) set_error("%s", err_msg);
    else if (graph_err[0] && graph_status != CHRONOS_OK) set_error("%s", graph_err);

    if (res.oom) {
        sb_free(&res);
        nomem();
        return NULL;
    }
    return res.data; /* caller frees with chronos_free_string */
}

int chronos_analyze_merge(const char* repo_path, const char* source_branch,
                          const char* target_branch, const char* output_json_path)
{
    char* top = NULL;
    char* src_oid = NULL;
    char* tgt_oid = NULL;
    char* base_oid = NULL;
    filelist_t ours, theirs;
    merge_t m;
    merge_ctx_t cx;
    unsigned char* used = NULL;
    proc_t pr;
    size_t i, j;
    int rc;

    memset(&ours, 0, sizeof ours);
    memset(&theirs, 0, sizeof theirs);
    memset(&m, 0, sizeof m);
    memset(&cx, 0, sizeof cx);
    clear_error();

    if (!output_json_path || !*output_json_path) {
        set_error("output_json_path is required");
        return CHRONOS_ERR_ARGS;
    }
    if (!validate_ref(source_branch, "source branch")) return CHRONOS_ERR_ARGS;
    if (!validate_ref(target_branch, "target branch")) return CHRONOS_ERR_ARGS;

    rc = resolve_repo(repo_path, &top);
    if (rc) return rc;
    rc = resolve_commit(top, source_branch, &src_oid);
    if (rc) goto done;
    rc = resolve_commit(top, target_branch, &tgt_oid);
    if (rc) goto done;

    {
        const char* a[] = {"merge-base", tgt_oid, src_oid};
        rc = git_run(top, a, 3, &pr);
        if (rc) goto done;
        if (pr.exit_code != 0) {
            set_error("no merge base between '%s' and '%s' (unrelated histories?)",
                      target_branch, source_branch);
            proc_free(&pr);
            rc = CHRONOS_ERR_GIT;
            goto done;
        }
        base_oid = first_line_dup(&pr.out);
        proc_free(&pr);
        if (!base_oid) { rc = nomem(); goto done; }
    }

    /* ours = target branch changes since base, theirs = source branch changes */
    rc = run_diff(top, base_oid, tgt_oid, &ours);
    if (rc) goto done;
    rc = run_diff(top, base_oid, src_oid, &theirs);
    if (rc) goto done;

    {
        int clean = 1;
        rc = run_merge_tree(top, tgt_oid, src_oid, &cx.have_git, &clean, &cx.conflicted, &cx.nconf);
        if (rc) goto done;
        m.can_auto = clean;
    }
    cx.repo = top;
    cx.base_oid = base_oid;
    cx.ours_oid = tgt_oid;
    cx.theirs_oid = src_oid;

    m.active = 1;
    m.source = xstrdup(source_branch);
    m.target = xstrdup(target_branch);
    m.base = xstrdup(base_oid);
    if (!m.source || !m.target || !m.base) { rc = nomem(); goto done; }

    used = (unsigned char*)calloc(theirs.n + 1, 1);
    if (!used) { rc = nomem(); goto done; }

    for (i = 0; i < ours.n; i++) {
        const char* key = file_base_key(&ours.items[i]);
        const file_t* ft = NULL;
        for (j = 0; j < theirs.n; j++) {
            if (!used[j] && key_eq(key, file_base_key(&theirs.items[j]))) {
                ft = &theirs.items[j];
                used[j] = 1;
                break;
            }
        }
        rc = analyze_pair(&m, &cx, &ours.items[i], ft);
        if (rc) goto done;
    }
    for (j = 0; j < theirs.n; j++) {
        if (used[j]) continue;
        rc = analyze_pair(&m, &cx, NULL, &theirs.items[j]);
        if (rc) goto done;
    }

    /* Every file git itself reports as conflicted must surface as a collision. */
    for (i = 0; i < cx.nconf; i++) {
        int found = 0;
        for (j = 0; j < m.n; j++) {
            if (m.items[j].status == RS_TRUE &&
                (strcmp(m.items[j].file_path, cx.conflicted[i]) == 0 ||
                 strcmp(m.items[j].key_path, cx.conflicted[i]) == 0)) {
                found = 1;
                break;
            }
        }
        if (!found && !push_conflict(&m, cx.conflicted[i], cx.conflicted[i], NULL, RS_TRUE)) {
            rc = nomem();
            goto done;
        }
    }

    if (!cx.have_git) {
        m.can_auto = 1;
        for (j = 0; j < m.n; j++) if (m.items[j].status == RS_TRUE) { m.can_auto = 0; break; }
    }

    rc = export_internal(top, output_json_path, CHRONOS_DEFAULT_MAX_COMMITS, &m);

done:
    free(used);
    for (i = 0; i < cx.nconf; i++) free(cx.conflicted[i]);
    free(cx.conflicted);
    merge_free(&m);
    filelist_free(&ours);
    filelist_free(&theirs);
    free(base_oid);
    free(src_oid);
    free(tgt_oid);
    free(top);
    return rc;
}

const char* chronos_last_error(void) { return g_last_error; }

void chronos_free_string(char* s) { free(s); }

const char* chronos_version(void) { return CHRONOS_VERSION_STRING; }