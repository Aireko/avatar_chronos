#!/bin/sh
# Usage: sh tests/run_call_tree_test.sh .build/test_call_tree
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
git config core.autocrlf false

cat > graph.c <<'SRC'
int leaf(void) { return 1; }
int mid(void) { return leaf() + leaf(); }
int top(void) { return mid() + missing(); }
int loop_a(void) { return loop_b(); }
int loop_b(void) { return loop_a(); }
int fact(int n) { return n ? fact(n - 1) : 1; }
SRC
printf '%s\n' 'class A { run() { return 1; } }' 'class B { run() { return 2; } }' > multi.ts
printf '%s\n' 'mid is not code' > notes.txt
git add .
git commit -qm base

"$test_binary" "$repo"
