#!/bin/sh
# Usage: sh tests/run_coverage_diagnostic_test.sh .build/chronos_coverage
set -eu

if [ "$#" -ne 1 ]; then
    printf 'Usage: %s <coverage binary>\n' "$0" >&2
    exit 2
fi
case "$1" in
    /*) coverage_binary=$1 ;;
    *) coverage_binary="$PWD/$1" ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

make_repo() {
    repo=$1
    mkdir -p "$repo"
    git init -q "$repo"
    cd "$repo"
    git config user.name Chronos
    git config user.email chronos@example.invalid
    git config commit.gpgsign false
}

repo=$work/mixed
make_repo "$repo"
mkdir -p src app vendor android
printf '%s\n' 'int main(void) { return 0; }' > src/main.c
printf '%s\n' 'int helper(void);' > src/helper.h
printf '%s\n' 'def run():' '    return 1' > app/service.py
printf '%s\n' 'export function App() { return <main />; }' > app/App.tsx
printf '%s\n' 'package vendor' 'func Tool() {}' > vendor/tool.go
printf '%s\n' 'class Main {}' > android/Main.java
printf '%s\n' '# Mixed fixture' > README.md
printf '%s\n' '{"private":true}' > package.json
git add .
git commit -qm mixed

"$coverage_binary" "$repo" HEAD >"$work/mixed.json"
test "$(grep -o '"sourceFiles":[0-9]*' "$work/mixed.json" | cut -d: -f2)" -eq 6
test "$(grep -o '"supportedFiles":[0-9]*' "$work/mixed.json" | cut -d: -f2)" -eq 5
test "$(grep -o '"unsupportedFiles":[0-9]*' "$work/mixed.json" | cut -d: -f2)" -eq 1
grep -Fq '"code":"language-coverage"' "$work/mixed.json"
grep -Fq '"severity":"info"' "$work/mixed.json"
grep -Fq 'Indexed 5 of 6 source files (83.3%); 1 unsupported.' "$work/mixed.json"

repo=$work/java
make_repo "$repo"
for i in $(seq 1 10); do
    printf 'package example;\npublic class C%s { public int run() { return %s; } }\n' "$i" "$i" \
        > "$repo/C$i.java"
done
printf '%s\n' 'package main' 'func main() {}' > main.go
printf '%s\n' 'plugins { java }' > build.gradle.kts
git add .
git commit -qm java
"$coverage_binary" "$repo" HEAD >"$work/java.json"
test "$(grep -o '"sourceFiles":[0-9]*' "$work/java.json" | cut -d: -f2)" -eq 11
test "$(grep -o '"supportedFiles":[0-9]*' "$work/java.json" | cut -d: -f2)" -eq 10
test "$(grep -o '"unsupportedFiles":[0-9]*' "$work/java.json" | cut -d: -f2)" -eq 1
supported_bytes=$(grep -o '"supportedBytes":[0-9]*' "$work/java.json" | cut -d: -f2)
source_bytes=$(grep -o '"sourceBytes":[0-9]*' "$work/java.json" | cut -d: -f2)
test $((supported_bytes * 100)) -ge $((source_bytes * 90))
grep -Fq 'Indexed 10 of 11 source files (90.9%); 1 unsupported.' "$work/java.json"

repo=$work/unsupported
make_repo "$repo"
printf '%s\n' 'package main' 'func main() {}' > main.go
printf '%s\n' '# Go only' > README.md
git add .
git commit -qm unsupported
if "$coverage_binary" "$repo" HEAD >"$work/unsupported.json"; then
    printf 'coverage diagnostic should fail for unsupported-only input\n' >&2
    exit 1
fi
grep -Fq '"sourceFiles":1' "$work/unsupported.json"
grep -Fq '"supportedFiles":0' "$work/unsupported.json"
grep -Fq '"unsupportedFiles":1' "$work/unsupported.json"
grep -Fq '"severity":"warning"' "$work/unsupported.json"
grep -Fq 'No supported source files were indexed (1 source files are unsupported).' \
    "$work/unsupported.json"

repo=$work/empty
make_repo "$repo"
printf '%s\n' '# No source files' > README.md
git add .
git commit -qm empty
if "$coverage_binary" "$repo" HEAD >"$work/empty.json"; then
    printf 'coverage diagnostic should fail when no source files exist\n' >&2
    exit 1
fi
grep -Fq '"sourceFiles":0' "$work/empty.json"
grep -Fq '"supportedFiles":0' "$work/empty.json"
grep -Fq 'No source files were found in the revision.' "$work/empty.json"

printf 'language coverage diagnostic passed\n'
