#include "parser.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const ParsedSymbol *find_symbol(const ParsedFile *file, const char *name)
{
    for (size_t i = 0; i < file->symbol_count; ++i)
        if (strcmp(file->symbols[i].qualified_name, name) == 0) return &file->symbols[i];
    return NULL;
}

static const ParsedImport *find_import(const ParsedFile *file, const char *name)
{
    for (size_t i = 0; i < file->import_count; ++i)
        if (strcmp(file->imports[i].name, name) == 0) return &file->imports[i];
    return NULL;
}

static const ParsedCall *find_call(const ParsedFile *file, const char *text)
{
    for (size_t i = 0; i < file->call_count; ++i)
        if (strcmp(file->calls[i].callee_text, text) == 0) return &file->calls[i];
    return NULL;
}

int main(void)
{
    const RevisionRef revision = {"fixture", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"};
    const char source[] =
        "package com.example;\n"
        "import java.util.List;\n"
        "import static com.example.Util.help;\n"
        "import com.example.models.*;\n"
        "public class Service {\n"
        "    public Service() {}\n"
        "    public int run(List<String> values) {\n"
        "        int a = helper();\n"
        "        int b = worker.execute();\n"
        "        int c = Service.build();\n"
        "        return a + b + c + help();\n"
        "    }\n"
        "    private int helper() { return 1; }\n"
        "    static int build() { return 2; }\n"
        "    static class Nested { void work() { helper(); } }\n"
        "}\n"
        "interface Worker { void work(); }\n"
        "enum Mode { ON, OFF }\n"
        "record Point(int x, int y) {}\n";
    ParsedFile file = {0};
    assert(parser_parse("src/com/example/Service.java", &revision,
                        source, sizeof source - 1, &file) == CHRONOS_OK);
    assert(strcmp(file.language, "java") == 0);
    assert(strcmp(file.package_name, "com.example") == 0);
    assert(file.import_count == 3);

    const ParsedImport *list = find_import(&file, "List");
    assert(list && list->module && strcmp(list->module, "java.util") == 0 &&
           !list->is_static && !list->is_wildcard);
    const ParsedImport *help = find_import(&file, "help");
    assert(help && help->module && strcmp(help->module, "com.example.Util") == 0 &&
           help->is_static && !help->is_wildcard);
    const ParsedImport *wildcard = find_import(&file, "*");
    assert(wildcard && wildcard->module &&
           strcmp(wildcard->module, "com.example.models") == 0 && wildcard->is_wildcard);

    const ParsedSymbol *service = find_symbol(&file, "Service");
    const ParsedSymbol *constructor = find_symbol(&file, "Service::Service");
    const ParsedSymbol *run = find_symbol(&file, "Service::run");
    const ParsedSymbol *nested = find_symbol(&file, "Service::Nested");
    const ParsedSymbol *nested_work = find_symbol(&file, "Service::Nested::work");
    const ParsedSymbol *worker = find_symbol(&file, "Worker");
    const ParsedSymbol *declaration = find_symbol(&file, "Worker::work");
    const ParsedSymbol *mode = find_symbol(&file, "Mode");
    const ParsedSymbol *point = find_symbol(&file, "Point");
    assert(service && service->kind == PARSER_CLASS && service->parent_id == 0);
    assert(constructor && constructor->kind == PARSER_METHOD &&
           constructor->parent_id == service->id);
    assert(run && run->kind == PARSER_METHOD && run->parent_id == service->id);
    assert(nested && nested->kind == PARSER_CLASS && nested->parent_id == service->id);
    assert(nested_work && nested_work->kind == PARSER_METHOD &&
           nested_work->parent_id == nested->id);
    assert(worker && worker->kind == PARSER_CLASS);
    assert(declaration && declaration->form == PARSER_DECLARATION);
    assert(mode && mode->kind == PARSER_CLASS);
    assert(point && point->kind == PARSER_CLASS);

    const ParsedCall *helper = find_call(&file, "helper");
    const ParsedCall *execute = find_call(&file, "worker.execute");
    const ParsedCall *build = find_call(&file, "Service.build");
    const ParsedCall *static_help = find_call(&file, "help");
    assert(helper && helper->enclosing_symbol_id == run->id);
    assert(execute && execute->enclosing_symbol_id == run->id);
    assert(build && build->enclosing_symbol_id == run->id);
    assert(static_help && static_help->enclosing_symbol_id == run->id);
    assert(memcmp(source + helper->range.start_byte, "helper()", strlen("helper()")) == 0);
    assert(memcmp(source + execute->range.start_byte, "worker.execute()",
                  strlen("worker.execute()")) == 0);
    const ParsedCall *nested_call = NULL;
    for (size_t i = 0; i < file.call_count; ++i)
        if (file.calls[i].enclosing_symbol_id == nested_work->id) nested_call = &file.calls[i];
    assert(nested_call && strcmp(nested_call->callee_text, "helper") == 0);

    parser_free(&file);
    puts("Java parser symbol, import, and callsite tests passed");
    return 0;
}
