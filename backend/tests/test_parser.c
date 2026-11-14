#include "parser.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void assert_slice(const char *source, SourceRange range, const char *expected)
{
    size_t length = strlen(expected);
    assert(range.end_byte - range.start_byte == length);
    assert(memcmp(source + range.start_byte, expected, length) == 0);
}

static const ParsedSymbol *find_symbol(const ParsedFile *file, const char *name)
{
    for (size_t i = 0; i < file->symbol_count; ++i)
        if (strcmp(file->symbols[i].qualified_name, name) == 0) return &file->symbols[i];
    return NULL;
}

int main(void)
{
    const RevisionRef revision = {"fixture", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"};
    /* Explicit bytes keep the test independent of compiler source encoding. */
    const char c_source[] = "/* caf\xc3\xa9 */\r\n"
                            "int helper(int n) { return n; }\r\n"
                            "int outer(void) {\r\n"
                            "    return helper(\r\n"
                            "        7);\r\n"
                            "}\r\n";
    ParsedFile file = {0};
    assert(parser_parse("src/example.c", &revision, c_source, sizeof c_source - 1, &file) == CHRONOS_OK);
    assert(file.symbol_count == 2 && file.call_count == 1);
    const ParsedSymbol *outer = find_symbol(&file, "outer");
    assert(outer && outer->range.start_line == 3 && outer->range.end_line == 6);
    assert_slice(c_source, outer->range, "int outer(void) {\r\n    return helper(\r\n        7);\r\n}");
    const ParsedCall *call = &file.calls[0];
    assert(call->enclosing_symbol_id == outer->id);
    assert(strcmp(call->callee_text, "helper") == 0);
    assert(call->range.start_line == 4 && call->range.end_line == 5);
    assert_slice(c_source, call->range, "helper(\r\n        7)");
    assert(call->range.start_byte == (size_t)(strstr(c_source, "helper(\r\n") - c_source));
    parser_free(&file);

    const char ts_source[] = "class Runner { run() { service.work(); } }\nstart();\n";
    assert(parser_parse("src/example.ts", &revision, ts_source, sizeof ts_source - 1, &file) == CHRONOS_OK);
    const ParsedSymbol *runner = find_symbol(&file, "Runner");
    const ParsedSymbol *run = find_symbol(&file, "Runner::run");
    assert(runner && run && run->parent_id == runner->id && run->kind == PARSER_METHOD);
    assert(file.call_count == 2);
    assert(file.calls[0].enclosing_symbol_id == run->id);
    assert(strcmp(file.calls[0].callee_text, "service.work") == 0);
    assert_slice(ts_source, file.calls[0].range, "service.work()");
    assert(file.calls[1].enclosing_symbol_id == 0);
    assert_slice(ts_source, file.calls[1].range, "start()");
    parser_free(&file);
    const char py_source[] = "class Worker:\n    async def run(self):\n        return helper()\n";
    assert(parser_parse("app.py", &revision, py_source, sizeof py_source - 1, &file) == CHRONOS_OK);
    const ParsedSymbol *worker = find_symbol(&file, "Worker");
    const ParsedSymbol *method = find_symbol(&file, "Worker::run");
    assert(worker && method && method->kind == PARSER_METHOD && method->parent_id == worker->id);
    assert(file.call_count == 1 && file.calls[0].enclosing_symbol_id == method->id);
    assert_slice(py_source, file.calls[0].range, "helper()");
    parser_free(&file);
    const char stub[] = "def helper() -> int: ...\n";
    assert(parser_parse("app.pyi", &revision, stub, sizeof stub - 1, &file) == CHRONOS_OK);
    assert(file.symbol_count == 1 && file.symbols[0].form == PARSER_DECLARATION);
    parser_free(&file);
    puts("parser ownership and byte-range tests passed");
    return 0;
}
