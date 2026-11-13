#include "parser_internal.h"
#include "avatar_util.h"

#include <ctype.h>

#define MAX_SYMBOLS_PER_FILE   512
#define MAX_HUNKS_PER_FILE     4096

static void copy_name(char* dst, size_t cap, const char* src)
{
    size_t n = strlen(src);
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
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

void chronos_filelist_free(filelist_t* fl)
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

void chronos_diff_state_init(diff_state_t* st, int keep_hunks)
{
    memset(st, 0, sizeof *st);
    st->cur = -1;
    st->hunk_idx = -1;
    st->plus_sym = st->minus_sym = st->ctx_sym = -1;
    st->keep_hunks = keep_hunks;
}

char* chronos_git_unquote(const char* s)
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
    u = chronos_git_unquote(tmp);
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
void chronos_diff_feed(diff_state_t* st, filelist_t* fl, const char* l)
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
    else if (starts_with(l, "rename from ")) { replace_str(&f->old_path, chronos_git_unquote(l + 12)); f->status = 'R'; }
    else if (starts_with(l, "rename to ")) { replace_str(&f->path, chronos_git_unquote(l + 10)); f->status = 'R'; }
    else if (starts_with(l, "copy from ")) { replace_str(&f->old_path, chronos_git_unquote(l + 10)); f->status = 'C'; }
    else if (starts_with(l, "copy to ")) { replace_str(&f->path, chronos_git_unquote(l + 8)); f->status = 'C'; }
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
int chronos_parse_commit_header(const char* line, commit_t* c)
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