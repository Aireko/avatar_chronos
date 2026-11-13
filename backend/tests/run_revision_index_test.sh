#!/bin/sh
# Usage: sh tests/run_revision_index_test.sh .build/test_revision_index
set -eu

if [ "$#" -ne 1 ]; then
    printf 'Usage: %s <test binary>\n' "$0" >&2
    exit 2
fi
case "$1" in
    /*) test_binary=$1 ;;
    *) test_binary="$PWD/$1" ;;
esac

repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
git init -q "$repo"
cd "$repo"
git config user.name Chronos
git config user.email chronos@example.invalid
git config commit.gpgsign false
mkdir app shared
printf '%s\n' 'int work(void) { return helper(); }' > app/work.c
printf '%s\n' 'int helper(void) { return 1; }' 'int removed(void) { return 0; }' > 'shared/x [1].c'
printf '%s\n' 'class Service { run() { return 0; } }' > app/service.ts
printf '%s\n' 'export function App() { return <main />; }' > app/App.tsx
printf '%s\n' 'fn rust_helper() -> i32 { 4 }' > app/main.rs
printf '%s\n' 'export const page = () => 5;' > app/web.js
git add .
git commit -qm base
printf '%s\n' 'int helper(void) { return 2; }' 'int added(void) { return 0; }' > 'shared/x [1].c'
git commit -qam head
printf '%s\n' 'int helper(void) { return 99; }' > 'shared/x [1].c'
"$test_binary" "$repo"
