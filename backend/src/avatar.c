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
#include "git_process.h"
#include "avatar_util.h"
#include "parser_internal.h"
#include "context_views.h"
#include "index.h"

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

static void sb_puts(sbuf_t* b, const char* s) { sb_putn(b, s, strlen(s)); }

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

static const char* sb_cstr(const sbuf_t* b) { return b->data ? b->data : ""; }

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

static int key_eq(const char* a, const char* b)
{
    if (!a || !b) return a == b;
    return strcmp(a, b) == 0;
}

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

int chronos_git_capture(const char *repo, const char *const *args, size_t count,
                        char **bytes, size_t *length, int *exit_code)
{
    proc_t result;
    int status = git_run(repo, args, count, &result);
    if (status != AVATAR_OK) return status;
    *bytes = result.out.data;
    *length = result.out.len;
    *exit_code = result.exit_code;
    result.out.data = NULL;
    proc_free(&result);
    return AVATAR_OK;
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

static int in_list(const char* w, const char* const* list)
{
    size_t i;
    for (i = 0; list[i]; i++) if (strcmp(w, list[i]) == 0) return 1;
    return 0;
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
        chronos_filelist_free(&c->files);
    }
    free(g->commits);
    memset(g, 0, sizeof *g);
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
        chronos_diff_state_init(&st, 0);
        li_init(&it, &pr.out);
        while ((l = li_next(&it)) != NULL) {
            if (l[0] == '\x1e') {
                int ok;
                ARR_GROW(g->commits, g->cc, g->nc + 1, ok);
                if (!ok) { li_free(&it); proc_free(&pr); return nomem(); }
                cur = &g->commits[g->nc++];
                memset(cur, 0, sizeof *cur);
                if (!chronos_parse_commit_header(l + 1, cur)) { li_free(&it); proc_free(&pr); return nomem(); }
                chronos_diff_state_init(&st, 0);
                continue;
            }
            if (cur) {
                chronos_diff_feed(&st, &cur->files, l);
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
    chronos_diff_state_init(&st, 1);
    li_init(&it, &pr.out);
    while ((l = li_next(&it)) != NULL) {
        chronos_diff_feed(&st, fl, l);
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
            u = chronos_git_unquote(l);
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
    chronos_filelist_free(&ours);
    chronos_filelist_free(&theirs);
    free(base_oid);
    free(src_oid);
    free(tgt_oid);
    free(top);
    return rc;
}

/* ========================================================================== */
/* Blame: who wrote which lines of a file                                     */
/* ========================================================================== */

#define MAX_BLAME_SYMBOLS     4096
#define MAX_SIGNATURE_LINES   64 /* a parameter list may span this many lines */
#define SHORT_SIGNATURE_LINES 8  /* lines to look for a body after the parameter list closes */

typedef struct {
    char      hash[65];
    char*     author;
    char*     email;
    long long time;
    char*     summary;
    long      lines;
} blame_commit_t;

typedef struct {
    long   start; /* 1-based, inclusive, in the blamed revision */
    long   end;
    size_t commit;
} blame_range_t;

typedef struct {
    char        name[NAME_MAX_LEN];
    const char* kind;
    long        start;
    long        end;
} blame_symbol_t;

typedef struct {
    blame_commit_t* commits;
    size_t          ncommits, capcommits;
    blame_range_t*  ranges;
    size_t          nranges, capranges;
    blame_symbol_t* symbols;
    size_t          nsymbols, capsymbols;
    long            total_lines;
} blame_t;

static void blame_free(blame_t* b)
{
    size_t i;
    for (i = 0; i < b->ncommits; i++) {
        free(b->commits[i].author);
        free(b->commits[i].email);
        free(b->commits[i].summary);
    }
    free(b->commits);
    free(b->ranges);
    free(b->symbols);
    memset(b, 0, sizeof *b);
}

static int is_hex_char(char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

/* Parses "<sha> <orig-line> <final-line>[ <count>]"; returns the SHA length (40 or 64) or 0. */
static size_t blame_header(const char* l, long* final_line)
{
    size_t n = 0;
    const char* p;
    char* endp;
    while (is_hex_char(l[n])) n++;
    if ((n != 40 && n != 64) || l[n] != ' ') return 0;
    p = l + n + 1;
    (void)strtol(p, &endp, 10); /* original line number */
    if (endp == p || *endp != ' ') return 0;
    *final_line = strtol(endp + 1, &endp, 10);
    return *final_line > 0 ? n : 0;
}

static size_t blame_find_commit(blame_t* b, const char* hash, size_t n, int* ok)
{
    size_t i;
    blame_commit_t* c;
    for (i = 0; i < b->ncommits; i++) {
        if (strncmp(b->commits[i].hash, hash, n) == 0 && b->commits[i].hash[n] == '\0') return i;
    }
    ARR_GROW(b->commits, b->capcommits, b->ncommits + 1, *ok);
    if (!*ok) return 0;
    c = &b->commits[b->ncommits];
    memset(c, 0, sizeof *c);
    memcpy(c->hash, hash, n);
    c->hash[n] = '\0';
    return b->ncommits++;
}

static void blame_set(char** field, const char* value, int* ok)
{
    free(*field);
    *field = xstrdup(value);
    if (!*field) *ok = 0;
}

/* Parses `git blame --porcelain` output into commits and line ranges. */
static int parse_blame(const sbuf_t* out, blame_t* b)
{
    line_iter_t it;
    const char* l;
    size_t cur = 0;
    long final_line = 0;
    int have = 0, ok = 1;

    li_init(&it, out);
    while (ok && (l = li_next(&it)) != NULL) {
        size_t n;
        long ln;
        if (l[0] == '\t') {
            blame_range_t* last;
            if (!have) continue;
            last = b->nranges ? &b->ranges[b->nranges - 1] : NULL;
            if (last && last->commit == cur && last->end + 1 == final_line) {
                last->end = final_line;
            } else {
                ARR_GROW(b->ranges, b->capranges, b->nranges + 1, ok);
                if (!ok) break;
                b->ranges[b->nranges].start = final_line;
                b->ranges[b->nranges].end = final_line;
                b->ranges[b->nranges].commit = cur;
                b->nranges++;
            }
            b->commits[cur].lines++;
            if (final_line > b->total_lines) b->total_lines = final_line;
            continue;
        }
        n = blame_header(l, &ln);
        if (n) {
            cur = blame_find_commit(b, l, n, &ok);
            final_line = ln;
            have = ok;
            continue;
        }
        if (!have) continue;
        if (starts_with(l, "author ")) {
            blame_set(&b->commits[cur].author, l + 7, &ok);
        } else if (starts_with(l, "author-mail ")) {
            const char* e = l + 12;
            size_t len = strlen(e);
            if (len >= 2 && e[0] == '<' && e[len - 1] == '>') { e++; len -= 2; }
            free(b->commits[cur].email);
            b->commits[cur].email = xstrndup(e, len);
            if (!b->commits[cur].email) ok = 0;
        } else if (starts_with(l, "author-time ")) {
            b->commits[cur].time = strtoll(l + 12, NULL, 10);
        } else if (starts_with(l, "summary ")) {
            blame_set(&b->commits[cur].summary, l + 8, &ok);
        }
    }
    li_free(&it);
    return ok ? CHRONOS_OK : nomem();
}

static int leading_indent(const char* s)
{
    int n = 0;
    while (s[n] == ' ' || s[n] == '\t') n++;
    return n;
}

static const char* skip_ws(const char* p)
{
    while (*p == ' ' || *p == '\t') p++;
    return p;
}

static void copy_name(char* dst, size_t cap, const char* src)
{
    size_t n = strlen(src);
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

enum { SCAN_CODE, SCAN_COMMENT, SCAN_TEMPLATE };

typedef struct {
    int mode;      /* SCAN_CODE, or inside a block comment / template literal (carries across lines) */
    int depth;     /* '{' nesting */
    int parens;    /* '(' nesting, so multi-line parameter lists aren't cut short */
    int opened;    /* a '{' has been seen */
    int semicolon; /* a ';' at depth 0 before any '{' (a prototype) */
    int underflow; /* a '}' closed an enclosing scope before any '{' (a call inside a body) */
} brace_scan_t;

/* Index just past the literal that starts with quote `q` at s[i], or 0 if it isn't closed on this line. */
static size_t skip_quoted(const char* s, size_t i, char q)
{
    size_t k = i + 1;
    while (s[k] && s[k] != q) k += (s[k] == '\\' && s[k + 1]) ? 2 : 1;
    return s[k] == q ? k + 1 : 0;
}

/* Scans one line of a brace language for braces and parentheses outside
 * comments, string/char literals and template literals. */
static void scan_braces(const char* s, brace_scan_t* st)
{
    size_t i = 0;
    while (s[i]) {
        char c = s[i];
        if (st->mode == SCAN_COMMENT) {
            if (c == '*' && s[i + 1] == '/') { st->mode = SCAN_CODE; i += 2; } else i++;
            continue;
        }
        if (st->mode == SCAN_TEMPLATE) {
            if (c == '\\' && s[i + 1]) i += 2;
            else { if (c == '`') st->mode = SCAN_CODE; i++; }
            continue;
        }
        if (c == '/' && s[i + 1] == '/') return;
        if (c == '/' && s[i + 1] == '*') { st->mode = SCAN_COMMENT; i += 2; continue; }
        if (c == '`') { st->mode = SCAN_TEMPLATE; i++; continue; }
        if (c == '"' || c == '\'') {
            size_t next = skip_quoted(s, i, c);
            if (next) { i = next; continue; }
            if (c == '"') return; /* unterminated string: ignore the rest of the line */
            i++;                  /* a lone ' is a Rust lifetime or label: ignore it */
            continue;
        }
        if (c == '(') st->parens++;
        else if (c == ')') { if (st->parens > 0) st->parens--; }
        else if (c == '{') { st->depth++; st->opened = 1; }
        else if (c == '}') { if (st->depth > 0) st->depth--; else if (!st->opened) st->underflow = 1; }
        else if (c == ';' && st->depth == 0 && !st->opened) st->semicolon = 1;
        i++;
    }
}

/* Adds the parentheses on one line of Python/Ruby to *parens, ignoring strings and '#' comments. */
static void count_parens(const char* s, int* parens)
{
    size_t i = 0;
    while (s[i]) {
        char c = s[i];
        if (c == '#') return;
        if (c == '"' || c == '\'') {
            size_t next = skip_quoted(s, i, c);
            if (!next) return;
            i = next;
            continue;
        }
        if (c == '(' || c == '[') (*parens)++;
        else if ((c == ')' || c == ']') && *parens > 0) (*parens)--;
        i++;
    }
}

/* Whether a line is blank or (in Python/Ruby) only a comment. Such lines never end a body. */
static int is_filler(const char* s, int indent_lang)
{
    const char* t = skip_ws(s);
    return *t == '\0' || (indent_lang && *t == '#');
}

/* Body by indentation: everything after line `from - 1` indented deeper than the
 * definition. Ends at its last real line, so blank lines before the next
 * definition (often written by someone else) aren't counted. */
static long dedent_end(char** lines, long nlines, long i, long from, int indent_lang)
{
    int base = leading_indent(lines[i]);
    long j, k;
    for (j = from; j < nlines; j++) {
        if (is_filler(lines[j], indent_lang)) continue;
        if (leading_indent(lines[j]) <= base) {
            if (strcmp(skip_ws(lines[j]), "end") == 0) return j; /* Ruby's "end" belongs to the def */
            break;
        }
    }
    k = j - 1;
    while (k > i && is_filler(lines[k], indent_lang)) k--;
    return k < from - 1 ? from - 1 : k;
}

/* Python/Ruby: the signature runs until its brackets balance; the body is indented deeper. */
static long indent_symbol_end(char** lines, long nlines, long i, int indent_lang)
{
    int parens = 0;
    long j, sig = i;
    for (j = i; j < nlines && j - i < MAX_SIGNATURE_LINES; j++) {
        count_parens(lines[j], &parens);
        if (parens <= 0) { sig = j; break; }
    }
    return dedent_end(lines, nlines, i, sig + 1, indent_lang);
}

/* Last line (0-based) of a definition starting at line `i`, or -1 when it has
 * no body (a C prototype) or is really a call inside another body. Brace
 * languages end where the braces balance; Python and Ruby (indent_lang) and
 * lines ending in ':' end before the next line indented no deeper. */
static long symbol_end(char** lines, long nlines, long i, int indent_lang)
{
    const char* def = lines[i];
    const char* end = def + strlen(def);
    brace_scan_t st;
    long j;

    while (end > def && (end[-1] == ' ' || end[-1] == '\t')) end--;
    if (indent_lang || (end > def && end[-1] == ':')) return indent_symbol_end(lines, nlines, i, indent_lang);

    memset(&st, 0, sizeof st);
    for (j = i; j < nlines; j++) {
        scan_braces(lines[j], &st);
        if (st.semicolon || st.underflow) return -1;
        if (st.opened && st.depth == 0) return j;
        if (st.opened) continue;
        /* No body yet: keep looking while the parameter list is open (one parameter
         * per line), but give up a few lines after it closes. */
        if (j - i + 1 >= MAX_SIGNATURE_LINES) break;
        if (st.parens == 0 && j - i + 1 >= SHORT_SIGNATURE_LINES) break;
    }
    if (st.opened) return nlines - 1; /* unbalanced: runs to the end of the file */
    return dedent_end(lines, nlines, i, i + 1, 0);
}

static int is_indent_language(const char* path);

/* Finds functions, methods and classes in `text` with their full line extents:
 * exact ones from the tree-sitter parser where it supports the language,
 * otherwise from the line-based detector plus brace/indentation extents. */
static int detect_symbols(const sbuf_t* text, const char* path, const char* oid, blame_t* b)
{
    char* copy;
    char** lines = NULL;
    size_t caplines = 0;
    long nlines = 0, i;
    int ok = 1, parsed, indent_lang = is_indent_language(path);
    char* p;
    char* end;
    chronos_def_t* defs = NULL;
    size_t ndefs = 0, d;

    if (!text->data || !text->len) return CHRONOS_OK;

    parsed = chronos_parse_definitions(path, oid, text->data, text->len, &defs, &ndefs);
    if (parsed < 0) return nomem();
    if (parsed > 0) {
        for (d = 0; d < ndefs && b->nsymbols < MAX_BLAME_SYMBOLS; d++) {
            ARR_GROW(b->symbols, b->capsymbols, b->nsymbols + 1, ok);
            if (!ok) break;
            copy_name(b->symbols[b->nsymbols].name, NAME_MAX_LEN, defs[d].name);
            b->symbols[b->nsymbols].kind = defs[d].kind;
            b->symbols[b->nsymbols].start = defs[d].start;
            b->symbols[b->nsymbols].end = defs[d].end;
            b->nsymbols++;
        }
        chronos_free_definitions(defs, ndefs);
        return ok ? CHRONOS_OK : nomem();
    }

    copy = xstrndup(text->data, text->len);
    if (!copy) return nomem();
    p = copy;
    end = copy + text->len;
    while (p < end && ok) {
        char* nl = (char*)memchr(p, '\n', (size_t)(end - p));
        char* e = nl ? nl : end;
        if (e > p && e[-1] == '\r') e[-1] = '\0';
        *e = '\0';
        ARR_GROW(lines, caplines, (size_t)nlines + 1, ok);
        if (ok) lines[nlines++] = p;
        p = nl ? nl + 1 : end;
    }

    for (i = 0; ok && i < nlines && b->nsymbols < MAX_BLAME_SYMBOLS; i++) {
        char name[NAME_MAX_LEN];
        const char* kind = NULL;
        long last;
        if (!chronos_detect_def(lines[i], name, sizeof name, &kind)) continue;
        last = symbol_end(lines, nlines, i, indent_lang);
        if (last < 0) continue;
        /* A qualified name (a::b or a.b) inside another symbol's body is a call
         * such as tauri::async_runtime::spawn_blocking(move || { ... }), not a
         * definition; nested methods have bare names. */
        if (strstr(name, "::") || strchr(name, '.')) {
            size_t k;
            int nested = 0;
            for (k = 0; k < b->nsymbols && !nested; k++) {
                nested = b->symbols[k].start < i + 1 && b->symbols[k].end >= last + 1;
            }
            if (nested) continue;
        }
        ARR_GROW(b->symbols, b->capsymbols, b->nsymbols + 1, ok);
        if (!ok) break;
        copy_name(b->symbols[b->nsymbols].name, NAME_MAX_LEN, name);
        b->symbols[b->nsymbols].kind = kind;
        b->symbols[b->nsymbols].start = i + 1;
        b->symbols[b->nsymbols].end = last + 1;
        b->nsymbols++;
    }
    free(lines);
    free(copy);
    return ok ? CHRONOS_OK : nomem();
}

/* Validates a repository-relative path and normalizes it: forward slashes, no
 * empty or "." segments, no trailing slash. Rejects absolute paths and "..". */
static char* normalize_repo_file(const char* path)
{
    char* p;
    char* out;
    char* seg;
    size_t i, n, o = 0;
    if (!path || !*path) { set_error("file_path is empty"); return NULL; }
    n = strlen(path);
    if (n > 4096) { set_error("file_path is too long"); return NULL; }
    for (i = 0; i < n; i++) {
        if ((unsigned char)path[i] < 0x20) { set_error("file_path contains control characters"); return NULL; }
    }
    p = xstrdup(path);
    out = (char*)malloc(n + 1);
    if (!p || !out) { free(p); free(out); nomem(); return NULL; }
    for (i = 0; i < n; i++) if (p[i] == '\\') p[i] = '/';
    if (p[0] == '/' || (isalpha((unsigned char)p[0]) && p[1] == ':')) {
        set_error("file_path must be relative to the repository root: %s", path);
        free(p);
        free(out);
        return NULL;
    }
    for (seg = p;;) {
        char* slash = strchr(seg, '/');
        size_t len = slash ? (size_t)(slash - seg) : strlen(seg);
        if (len == 2 && seg[0] == '.' && seg[1] == '.') {
            set_error("file_path may not leave the repository: %s", path);
            free(p);
            free(out);
            return NULL;
        }
        if (len && !(len == 1 && seg[0] == '.')) {
            if (o) out[o++] = '/';
            memcpy(out + o, seg, len);
            o += len;
        }
        if (!slash) break;
        seg = slash + 1;
    }
    out[o] = '\0';
    free(p);
    if (!o) { set_error("file_path is empty"); free(out); return NULL; }
    return out;
}

/* Like validate_ref, but also allows ~ and ^ (HEAD~1, main^2) and @{...}:
 * the value only ever reaches `rev-parse --verify <rev>^{commit}`. */
static int validate_revision(const char* r)
{
    size_t n, i;
    if (!r || !*r) { set_error("revision is empty"); return 0; }
    n = strlen(r);
    if (n > 255) { set_error("revision is too long"); return 0; }
    if (r[0] == '-') { set_error("revision may not start with '-'"); return 0; }
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)r[i];
        if (c < 0x20 || c == 0x7F || c == ' ' || c == ':' || c == '?' || c == '*' || c == '[' || c == '\\') {
            set_error("revision contains an invalid character");
            return 0;
        }
    }
    if (strstr(r, "..")) { set_error("revision may not be a range"); return 0; }
    return 1;
}

static int ascii_ieq(const char* a, const char* b)
{
    for (; *a && *b; a++, b++) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
    }
    return *a == *b;
}

/* Python and Ruby files, whose definitions end by indentation rather than braces. */
static int is_indent_language(const char* path)
{
    static const char* const exts[] = {".py", ".pyi", ".pyw", ".rb", ".rake", ".gemspec", ".ru", NULL};
    static const char* const names[] = {"Rakefile", "Gemfile", "Guardfile", "Vagrantfile", NULL};
    const char* base = strrchr(path, '/');
    const char* dot;
    size_t i;
    base = base ? base + 1 : path;
    for (i = 0; names[i]; i++) if (strcmp(base, names[i]) == 0) return 1;
    dot = strrchr(base, '.');
    if (!dot) return 0;
    for (i = 0; exts[i]; i++) if (ascii_ieq(dot, exts[i])) return 1;
    return 0;
}

/* Two commits are by the same person if the emails match (case-insensitively),
 * or, when either email is missing, if the names match. */
static int same_person(const blame_commit_t* a, const blame_commit_t* b)
{
    const char* ea = a->email ? a->email : "";
    const char* eb = b->email ? b->email : "";
    if (*ea && *eb) return ascii_ieq(ea, eb);
    return strcmp(a->author ? a->author : "", b->author ? b->author : "") == 0;
}

typedef struct {
    size_t latest; /* commit index with the newest author-time */
    long   lines;
    long   commits;
} blame_author_t;

static int cmp_author(const void* x, const void* y, const blame_t* b)
{
    const blame_author_t* a = (const blame_author_t*)x;
    const blame_author_t* c = (const blame_author_t*)y;
    if (a->lines != c->lines) return a->lines > c->lines ? -1 : 1;
    if (b->commits[a->latest].time != b->commits[c->latest].time)
        return b->commits[a->latest].time > b->commits[c->latest].time ? -1 : 1;
    return 0;
}

static void json_blame(sbuf_t* j, const char* top, const char* path, const char* oid, const blame_t* b, int* ok)
{
    blame_author_t* authors = NULL;
    size_t nauthors = 0, capauthors = 0, i, k;
    size_t* order = NULL;

    /* Group commits by person. */
    for (i = 0; i < b->ncommits && *ok; i++) {
        const blame_commit_t* c = &b->commits[i];
        if (c->lines == 0) continue;
        for (k = 0; k < nauthors; k++) {
            if (same_person(&b->commits[authors[k].latest], c)) break;
        }
        if (k == nauthors) {
            ARR_GROW(authors, capauthors, nauthors + 1, *ok);
            if (!*ok) break;
            authors[nauthors].latest = i;
            authors[nauthors].lines = 0;
            authors[nauthors].commits = 0;
            nauthors++;
        }
        authors[k].lines += c->lines;
        authors[k].commits++;
        if (c->time > b->commits[authors[k].latest].time) authors[k].latest = i;
    }
    /* Insertion sort: most lines first, then most recent. Author lists are short. */
    for (i = 1; i < nauthors; i++) {
        blame_author_t t = authors[i];
        k = i;
        while (k > 0 && cmp_author(&t, &authors[k - 1], b) < 0) { authors[k] = authors[k - 1]; k--; }
        authors[k] = t;
    }
    /* Commits newest first. */
    order = (size_t*)malloc((b->ncommits ? b->ncommits : 1) * sizeof *order);
    if (!order) { *ok = 0; free(authors); return; }
    for (i = 0; i < b->ncommits; i++) order[i] = i;
    for (i = 1; i < b->ncommits; i++) {
        size_t t = order[i];
        k = i;
        while (k > 0 && b->commits[t].time > b->commits[order[k - 1]].time) { order[k] = order[k - 1]; k--; }
        order[k] = t;
    }

    sb_puts(j, "{\"repoPath\":");
    json_str(j, top);
    sb_puts(j, ",\"path\":");
    json_str(j, path);
    sb_puts(j, ",\"revision\":");
    json_str(j, oid);
    sb_puts(j, ",\"totalLines\":");
    sb_put_i64(j, b->total_lines);

    sb_puts(j, ",\"authors\":[");
    for (i = 0; i < nauthors; i++) {
        const blame_commit_t* c = &b->commits[authors[i].latest];
        if (i) sb_putc(j, ',');
        sb_puts(j, "{\"name\":");
        json_str(j, c->author);
        sb_puts(j, ",\"email\":");
        json_str(j, c->email);
        sb_puts(j, ",\"lines\":");
        sb_put_i64(j, authors[i].lines);
        sb_puts(j, ",\"commits\":");
        sb_put_i64(j, authors[i].commits);
        sb_puts(j, ",\"lastTime\":");
        sb_put_i64(j, c->time);
        sb_puts(j, ",\"lastCommit\":");
        json_str(j, c->hash);
        sb_puts(j, ",\"lastSummary\":");
        json_str(j, c->summary);
        sb_putc(j, '}');
    }

    sb_puts(j, "],\"commits\":[");
    for (i = 0; i < b->ncommits; i++) {
        const blame_commit_t* c = &b->commits[order[i]];
        if (i) sb_putc(j, ',');
        sb_puts(j, "{\"hash\":");
        json_str(j, c->hash);
        sb_puts(j, ",\"author\":");
        json_str(j, c->author);
        sb_puts(j, ",\"email\":");
        json_str(j, c->email);
        sb_puts(j, ",\"time\":");
        sb_put_i64(j, c->time);
        sb_puts(j, ",\"summary\":");
        json_str(j, c->summary);
        sb_puts(j, ",\"lines\":");
        sb_put_i64(j, c->lines);
        sb_putc(j, '}');
    }

    sb_puts(j, "],\"ranges\":[");
    for (i = 0; i < b->nranges; i++) {
        if (i) sb_putc(j, ',');
        sb_puts(j, "{\"start\":");
        sb_put_i64(j, b->ranges[i].start);
        sb_puts(j, ",\"end\":");
        sb_put_i64(j, b->ranges[i].end);
        sb_puts(j, ",\"commit\":");
        json_str(j, b->commits[b->ranges[i].commit].hash);
        sb_putc(j, '}');
    }

    sb_puts(j, "],\"symbols\":[");
    for (i = 0; i < b->nsymbols; i++) {
        if (i) sb_putc(j, ',');
        sb_puts(j, "{\"name\":");
        json_str(j, b->symbols[i].name);
        sb_puts(j, ",\"kind\":");
        json_str(j, b->symbols[i].kind);
        sb_puts(j, ",\"startLine\":");
        sb_put_i64(j, b->symbols[i].start);
        sb_puts(j, ",\"endLine\":");
        sb_put_i64(j, b->symbols[i].end);
        sb_putc(j, '}');
    }
    sb_puts(j, "]}");

    free(order);
    free(authors);
}

int chronos_blame(const char* repo_path, const char* file_path, const char* revision, char** out_json)
{
    char* top = NULL;
    char* path = NULL;
    char* oid = NULL;
    blame_t b;
    proc_t pr;
    sbuf_t spec = {0};
    sbuf_t j = {0};
    int rc, ok = 1;

    clear_error();
    memset(&b, 0, sizeof b);
    if (!out_json) { set_error("out_json is required"); return CHRONOS_ERR_ARGS; }
    *out_json = NULL;
    if (!revision || !*revision) revision = "HEAD";
    if (!validate_revision(revision)) return CHRONOS_ERR_ARGS;
    path = normalize_repo_file(file_path);
    if (!path) return CHRONOS_ERR_ARGS;

    rc = resolve_repo(repo_path, &top);
    if (rc == CHRONOS_OK) rc = resolve_commit(top, revision, &oid);

    if (rc == CHRONOS_OK) {
        /* --no-textconv: textconv filters are commands from the repository config,
         * and their output would not line up with the symbols found in the raw blob. */
        const char* a[] = {"blame", "--porcelain", "--no-textconv", "-w", "-M", oid, "--", path};
        rc = git_run(top, a, 8, &pr);
        if (rc == CHRONOS_OK) {
            if (pr.exit_code != 0) {
                char* msg = first_line_dup(&pr.err);
                set_error("git blame failed for %s: %s", path, msg ? msg : "unknown error");
                free(msg);
                rc = CHRONOS_ERR_GIT;
            } else {
                rc = parse_blame(&pr.out, &b);
            }
            proc_free(&pr);
        }
    }

    /* Function extents come from the same revision's file text. */
    if (rc == CHRONOS_OK) {
        sb_puts(&spec, oid);
        sb_putc(&spec, ':');
        sb_puts(&spec, path);
        if (spec.oom) rc = nomem();
    }
    if (rc == CHRONOS_OK) {
        const char* a[] = {"cat-file", "blob", spec.data};
        rc = git_run(top, a, 3, &pr);
        if (rc == CHRONOS_OK) {
            if (pr.exit_code == 0) rc = detect_symbols(&pr.out, path, oid, &b);
            proc_free(&pr);
        }
    }

    if (rc == CHRONOS_OK) {
        json_blame(&j, top, path, oid, &b, &ok);
        if (!ok || j.oom) rc = nomem();
    }
    if (rc == CHRONOS_OK) {
        *out_json = j.data ? j.data : xstrdup("{}");
        if (!*out_json) rc = nomem();
    } else {
        sb_free(&j);
    }

    sb_free(&spec);
    blame_free(&b);
    free(oid);
    free(path);
    free(top);
    return rc;
}

static const GraphSymbol* find_views_symbol(const RepositoryIndex* index,
                                            const char* path,
                                            const char* qualified_name,
                                            int* ambiguous)
{
    size_t count = 0;
    const IndexScope* scopes = index_scopes(index, &count);
    const GraphSymbol* found = NULL;
    *ambiguous = 0;
    for (size_t i = 0; i < count; ++i) {
        if (scopes[i].kind != INDEX_SYMBOL || !scopes[i].symbol) continue;
        const GraphSymbol* symbol = scopes[i].symbol;
        if (symbol->form != PARSER_DEFINITION) continue;
        if (strcmp(symbol->location.file_path, path) != 0 ||
            strcmp(symbol->qualified_name, qualified_name) != 0) continue;
        if (found) {
            *ambiguous = 1;
            return NULL;
        }
        found = symbol;
    }
    return found;
}

static void json_revision(sbuf_t* b, const RevisionRef* revision)
{
    sb_puts(b, "{\"repositoryId\":");
    json_str(b, revision->repository_id);
    sb_puts(b, ",\"commitSha\":");
    json_str(b, revision->commit_sha);
    sb_putc(b, '}');
}

static void json_ref(sbuf_t* b, const SymbolVersionRef* ref)
{
    if (!ref) { sb_puts(b, "null"); return; }
    sb_puts(b, "{\"revision\":");
    json_revision(b, &ref->revision);
    sb_puts(b, ",\"id\":");
    json_str(b, ref->id);
    sb_putc(b, '}');
}

static void json_location(sbuf_t* b, const SourceLocation* location)
{
    if (!location) { sb_puts(b, "null"); return; }
    sb_puts(b, "{\"revision\":");
    json_revision(b, &location->revision);
    sb_puts(b, ",\"filePath\":");
    json_str(b, location->file_path);
    sb_puts(b, ",\"range\":{\"startByte\":");
    sb_put_i64(b, (long long)location->range.start_byte);
    sb_puts(b, ",\"endByte\":");
    sb_put_i64(b, (long long)location->range.end_byte);
    sb_puts(b, ",\"startLine\":");
    sb_put_i64(b, (long long)location->range.start_line);
    sb_puts(b, ",\"endLine\":");
    sb_put_i64(b, (long long)location->range.end_line);
    sb_puts(b, "}}");
}

static void json_number(sbuf_t* b, double value)
{
    char digits[64];
    (void)snprintf(digits, sizeof digits, "%.6f", value);
    sb_puts(b, digits);
}

static void json_flow_set(sbuf_t* b, const ContextFlowSet* flows)
{
    sb_putc(b, '[');
    for (size_t i = 0; i < flows->count; ++i) {
        const ContextFlow* flow = &flows->flows[i];
        if (i) sb_putc(b, ',');
        sb_puts(b, "{\"id\":");
        json_str(b, flow->id);
        sb_puts(b, ",\"seed\":");
        json_ref(b, &flow->seed->ref);
        sb_puts(b, ",\"relevance\":");
        json_number(b, flow->relevance);
        sb_puts(b, ",\"nodes\":[");
        for (size_t j = 0; j < flow->node_count; ++j) {
            const ContextFlowNode* node = &flow->nodes[j];
            if (j) sb_putc(b, ',');
            sb_puts(b, "{\"symbol\":");
            json_ref(b, &node->symbol->ref);
            sb_puts(b, ",\"name\":");
            json_str(b, node->symbol->name);
            sb_puts(b, ",\"hop\":");
            sb_put_i64(b, (long long)node->hop);
            sb_puts(b, ",\"relevance\":");
            json_number(b, node->relevance);
            sb_puts(b, ",\"fanIn\":");
            sb_put_i64(b, (long long)node->fan_in);
            sb_puts(b, ",\"isSeed\":");
            sb_puts(b, node->is_seed ? "true" : "false");
            sb_puts(b, ",\"viaIncoming\":");
            sb_puts(b, node->via_incoming ? "true" : "false");
            sb_puts(b, ",\"crossedModule\":");
            sb_puts(b, node->crossed_module ? "true" : "false");
            sb_putc(b, '}');
        }
        sb_puts(b, "],\"edges\":[");
        for (size_t j = 0; j < flow->edge_count; ++j) {
            const ContextFlowEdge* edge = &flow->edges[j];
            if (j) sb_putc(b, ',');
            sb_puts(b, "{\"evidenceId\":");
            json_str(b, edge->evidence_id);
            sb_puts(b, ",\"from\":");
            sb_put_i64(b, (long long)edge->from);
            sb_puts(b, ",\"to\":");
            sb_put_i64(b, (long long)edge->to);
            sb_puts(b, ",\"forward\":");
            sb_puts(b, edge->forward ? "true" : "false");
            sb_putc(b, '}');
        }
        sb_puts(b, "]}");
    }
    sb_putc(b, ']');
}

static const char* bridge_kind_name(ContextBridgeKind kind)
{
    switch (kind) {
    case CONTEXT_BRIDGE_INVOKE: return "invoke";
    case CONTEXT_BRIDGE_REGISTRATION: return "registration";
    case CONTEXT_BRIDGE_DISPATCH: return "dispatch";
    case CONTEXT_BRIDGE_FFI: return "ffi";
    default: return "unknown";
    }
}

static void json_bridge_set(sbuf_t* b, const ContextBridgeSet* bridges)
{
    sb_putc(b, '[');
    for (size_t i = 0; i < bridges->count; ++i) {
        const ContextBridgeEdge* edge = &bridges->edges[i];
        if (i) sb_putc(b, ',');
        sb_puts(b, "{\"kind\":");
        json_str(b, bridge_kind_name(edge->kind));
        sb_puts(b, ",\"label\":");
        json_str(b, edge->label);
        sb_puts(b, ",\"from\":");
        json_ref(b, edge->from);
        sb_puts(b, ",\"to\":");
        json_ref(b, edge->to);
        sb_puts(b, ",\"evidenceId\":");
        json_str(b, edge->evidence_id);
        sb_puts(b, ",\"evidence\":");
        json_location(b, &edge->evidence);
        sb_putc(b, '}');
    }
    sb_putc(b, ']');
}

#define MAX_VIEW_TARGETS 64

static int compile_views_from_index(const RepositoryIndex* index,
                                    ContextFlowMode mode,
                                    const ContextFlowSeed* seeds,
                                    size_t seed_count,
                                    size_t max_items,
                                    size_t max_source_bytes,
                                    char** out_json)
{
    ContextViews views;
    ContextFlowRequest flow;
    ContextViewsRequest request;
    char* brief_json = NULL;
    char* graph_json = NULL;
    sbuf_t result = {0};
    int rc, views_status;

    memset(&views, 0, sizeof views);
    memset(&flow, 0, sizeof flow);
    *out_json = NULL;
    flow.mode = mode;
    flow.seeds = seeds;
    flow.seed_count = seed_count;
    flow.max_hops = 3;
    flow.max_flows = 8;
    flow.max_nodes = 8;
    request = (ContextViewsRequest){&flow, {max_items, max_source_bytes}};

    views_status = context_build_views(index, &request, &views);
    if (views_status < 0) {
        set_error("view build failed (status %d)", views_status);
        rc = views_status;
        goto done;
    }

    int brief_len = context_brief_write_json(&views.brief, NULL, 0);
    int graph_len = context_graph_write_json(&views.graph, NULL, 0);
    if (brief_len < 0 || graph_len < 0) {
        rc = brief_len < 0 ? brief_len : graph_len;
        set_error("context JSON sizing failed (status %d)", rc);
        goto done;
    }
    brief_json = (char*)malloc((size_t)brief_len + 1);
    graph_json = (char*)malloc((size_t)graph_len + 1);
    if (!brief_json || !graph_json) {
        rc = CHRONOS_ERR_NOMEM;
        set_error("out of memory");
        goto done;
    }
    if (context_brief_write_json(&views.brief, brief_json, (size_t)brief_len + 1) != brief_len ||
        context_graph_write_json(&views.graph, graph_json, (size_t)graph_len + 1) != graph_len) {
        rc = CHRONOS_ERR_IO;
        set_error("context JSON serialization failed");
        goto done;
    }

    sb_puts(&result, "{\"schemaVersion\":1,\"repositoryId\":");
    json_str(&result, index_revision(index)->repository_id);
    sb_puts(&result, ",\"revision\":{\"repositoryId\":");
    json_str(&result, index_revision(index)->repository_id);
    sb_puts(&result, ",\"commitSha\":");
    json_str(&result, index_revision(index)->commit_sha);
    sb_puts(&result, "},\"targetCount\":");
    sb_put_i64(&result, (long long)seed_count);
    sb_puts(&result, ",\"brief\":");
    sb_putn(&result, brief_json, (size_t)brief_len);
    sb_puts(&result, ",\"graph\":");
    sb_putn(&result, graph_json, (size_t)graph_len);
    sb_puts(&result, ",\"flows\":");
    json_flow_set(&result, &views.flows);
    sb_puts(&result, ",\"bridges\":");
    json_bridge_set(&result, &views.bridges);
    sb_puts(&result, "}");
    if (result.oom || !result.data) {
        rc = CHRONOS_ERR_NOMEM;
        set_error("out of memory");
        goto done;
    }
    *out_json = result.data;
    result.data = NULL;
    rc = views_status == CHRONOS_PARTIAL ? CHRONOS_PARTIAL : CHRONOS_OK;

done:
    sb_free(&result);
    free(brief_json);
    free(graph_json);
    context_views_free(&views);
    return rc;
}

int chronos_compile_views(const char* repo_path,
                          const char* revision,
                          const char* mode,
                          const char* path,
                          const char* qualified_name,
                          size_t max_items,
                          size_t max_source_bytes,
                          char** out_json)
{
    char* top = NULL;
    RepositoryIndex* index = NULL;
    ContextFlowSeed seed;
    ContextFlowMode flow_mode;
    int rc;

    clear_error();
    memset(&seed, 0, sizeof seed);
    if (!out_json) { set_error("out_json is required"); return CHRONOS_ERR_ARGS; }
    *out_json = NULL;
    if (!revision || !*revision) revision = "HEAD";
    if (!validate_revision(revision)) return CHRONOS_ERR_ARGS;
    if (!mode || !*mode) mode = "onboarding";

    if (strcmp(mode, "onboarding") == 0) {
        flow_mode = CONTEXT_FLOW_ONBOARDING;
    } else if (strcmp(mode, "task") == 0 || strcmp(mode, "review") == 0) {
        flow_mode = CONTEXT_FLOW_TASK;
        if (!path || !*path || !qualified_name || !*qualified_name) {
            set_error("task mode requires path and qualified_name");
            return CHRONOS_ERR_ARGS;
        }
    } else {
        set_error("mode must be onboarding or task");
        return CHRONOS_ERR_ARGS;
    }

    rc = resolve_repo(repo_path, &top);
    if (rc != CHRONOS_OK) return rc;
    {
        GitRepository repo = {top, top};
        rc = index_build_revision(&repo, revision, &index);
    }
    if (rc < 0) {
        set_error("index build failed (status %d)", rc);
        free(top);
        return rc;
    }

    if (flow_mode == CONTEXT_FLOW_TASK) {
        int ambiguous = 0;
        const GraphSymbol* target = find_views_symbol(index, path, qualified_name, &ambiguous);
        if (!target) {
            set_error(ambiguous ? "target symbol is ambiguous" : "target symbol not found");
            index_free(index);
            free(top);
            return CHRONOS_ERR_ARGS;
        }
        seed = (ContextFlowSeed){CONTEXT_FLOW_SEED_SYMBOL, &target->ref, NULL};
    }
    rc = compile_views_from_index(index, flow_mode,
                                  flow_mode == CONTEXT_FLOW_TASK ? &seed : NULL,
                                  flow_mode == CONTEXT_FLOW_TASK ? 1 : 0,
                                  max_items, max_source_bytes, out_json);
    index_free(index);
    free(top);
    return rc;
}

int chronos_compile_multi_views(const char* repo_path,
                                const char* revision,
                                const char* mode,
                                const char* const* paths,
                                const char* const* qualified_names,
                                size_t target_count,
                                size_t max_items,
                                size_t max_source_bytes,
                                char** out_json)
{
    char* top = NULL;
    RepositoryIndex* index = NULL;
    ContextFlowSeed* seeds = NULL;
    ContextFlowMode flow_mode;
    int rc;

    clear_error();
    if (!out_json) { set_error("out_json is required"); return CHRONOS_ERR_ARGS; }
    *out_json = NULL;
    if (!revision || !*revision) revision = "HEAD";
    if (!validate_revision(revision)) return CHRONOS_ERR_ARGS;
    if (!mode || !*mode) mode = "onboarding";

    if (strcmp(mode, "onboarding") == 0) {
        flow_mode = CONTEXT_FLOW_ONBOARDING;
        target_count = 0;
    } else if (strcmp(mode, "task") == 0 || strcmp(mode, "review") == 0) {
        flow_mode = CONTEXT_FLOW_TASK;
        if (target_count == 0 || target_count > MAX_VIEW_TARGETS ||
            !paths || !qualified_names) {
            set_error("task mode requires 1..%d path/qualified targets", MAX_VIEW_TARGETS);
            return CHRONOS_ERR_ARGS;
        }
    } else {
        set_error("mode must be onboarding or task");
        return CHRONOS_ERR_ARGS;
    }

    rc = resolve_repo(repo_path, &top);
    if (rc != CHRONOS_OK) return rc;
    {
        GitRepository repo = {top, top};
        rc = index_build_revision(&repo, revision, &index);
    }
    if (rc < 0) {
        set_error("index build failed (status %d)", rc);
        free(top);
        return rc;
    }

    if (flow_mode == CONTEXT_FLOW_TASK) {
        seeds = (ContextFlowSeed*)calloc(target_count, sizeof *seeds);
        if (!seeds) {
            index_free(index);
            free(top);
            return CHRONOS_ERR_NOMEM;
        }
        for (size_t i = 0; i < target_count; ++i) {
            if (!paths[i] || !*paths[i] || !qualified_names[i] || !*qualified_names[i]) {
                set_error("target %zu requires path and qualified_name", i + 1);
                free(seeds);
                index_free(index);
                free(top);
                return CHRONOS_ERR_ARGS;
            }
            int ambiguous = 0;
            const GraphSymbol* target = find_views_symbol(index, paths[i], qualified_names[i],
                                                          &ambiguous);
            if (!target) {
                set_error(ambiguous ? "target %zu is ambiguous" : "target %zu not found", i + 1);
                free(seeds);
                index_free(index);
                free(top);
                return CHRONOS_ERR_ARGS;
            }
            seeds[i] = (ContextFlowSeed){CONTEXT_FLOW_SEED_SYMBOL, &target->ref, NULL};
        }
    }

    rc = compile_views_from_index(index, flow_mode, seeds, target_count,
                                  max_items, max_source_bytes, out_json);
    free(seeds);
    index_free(index);
    free(top);
    return rc;
}

int chronos_read_source(const char* repo_path,
                        const char* revision,
                        const char* file_path,
                        size_t start_byte,
                        size_t end_byte,
                        char** out_json)
{
    char* top = NULL;
    char* path = NULL;
    GitRepository repo;
    RevisionRef resolved;
    GitBlob blob;
    sbuf_t j = {0};
    int rc;

    clear_error();
    memset(&resolved, 0, sizeof resolved);
    memset(&blob, 0, sizeof blob);
    if (!out_json) { set_error("out_json is required"); return CHRONOS_ERR_ARGS; }
    *out_json = NULL;
    if (!revision || !*revision) revision = "HEAD";
    if (!validate_revision(revision)) return CHRONOS_ERR_ARGS;
    path = normalize_repo_file(file_path);
    if (!path) return CHRONOS_ERR_ARGS;
    if (start_byte > end_byte) {
        set_error("start_byte is after end_byte");
        free(path);
        return CHRONOS_ERR_ARGS;
    }

    rc = resolve_repo(repo_path, &top);
    if (rc != CHRONOS_OK) {
        free(path);
        return rc;
    }
    repo = (GitRepository){top, top};
    rc = git_resolve_revision(&repo, revision, &resolved);
    if (rc == CHRONOS_OK) rc = git_read_blob(&repo, &resolved, path, &blob);
    if (rc < 0) {
        if (rc == CHRONOS_NOT_FOUND) set_error("file not found at revision: %s", path);
        else set_error("cannot read source (status %d)", rc);
        goto done;
    }
    if (end_byte > blob.byte_count) {
        set_error("range is outside the file");
        rc = CHRONOS_ERR_ARGS;
        goto done;
    }

    sb_puts(&j, "{\"repositoryId\":");
    json_str(&j, resolved.repository_id);
    sb_puts(&j, ",\"commitSha\":");
    json_str(&j, resolved.commit_sha);
    sb_puts(&j, ",\"filePath\":");
    json_str(&j, path);
    sb_puts(&j, ",\"startByte\":");
    sb_put_i64(&j, (long long)start_byte);
    sb_puts(&j, ",\"endByte\":");
    sb_put_i64(&j, (long long)end_byte);
    sb_puts(&j, ",\"source\":");
    const char* source_bytes = blob.bytes
        ? (const char*)blob.bytes + start_byte : "";
    json_strn(&j, source_bytes, end_byte - start_byte);
    sb_putc(&j, '}');
    if (j.oom || !j.data) {
        rc = CHRONOS_ERR_NOMEM;
        set_error("out of memory");
        goto done;
    }
    *out_json = j.data;
    j.data = NULL;
    rc = CHRONOS_OK;

done:
    sb_free(&j);
    git_blob_free(&blob);
    git_revision_free(&resolved);
    free(path);
    free(top);
    return rc;
}

const char* chronos_last_error(void) { return g_last_error; }

void chronos_free_string(char* s) { free(s); }

const char* chronos_version(void) { return CHRONOS_VERSION_STRING; }