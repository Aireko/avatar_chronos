#!/bin/sh
# End-to-end CLI test for the context compiler.
# Usage: sh tests/run_context_compile_test.sh .build/chronos_context
set -eu

if [ "$#" -ne 1 ]; then
    printf 'Usage: %s <chronos_context binary>\n' "$0" >&2
    exit 2
fi
case "$1" in
    /*) cli=$1 ;;
    *) cli="$PWD/$1" ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
repo=$work/repo
mkdir -p "$repo"
cd "$repo"
git init -q -b main
git config user.name Chronos
git config user.email chronos@example.invalid
git config commit.gpgsign false
git config core.autocrlf false

cat > math.c <<'EOF'
int alpha(void) { return 1; }

int beta(void) { return alpha() + save() + missing(); }

int removed(void) { return alpha(); }
EOF
cat > save_a.c <<'EOF'
int save(void) { return 1; }
EOF
cat > save_b.c <<'EOF'
int save(void) { return 2; }
EOF
cat > example.py <<'EOF'
def helper():
    return 1

def work():
    return helper()
EOF
git add .
git commit -qm base

cat > math.c <<'EOF'
int alpha(void) { return 1; }

int beta(void) { return alpha() + save() + missing() + 1; }

int added(void) { return alpha(); }
EOF
sed 's/return 1/return 2/' example.py > example.new
mv example.new example.py
git commit -qam head

run_twice() {
    name=$1
    shift
    "$cli" "$repo" HEAD^ HEAD "$@" >"$work/$name.1.json"
    "$cli" "$repo" HEAD^ HEAD "$@" >"$work/$name.2.json"
    cmp "$work/$name.1.json" "$work/$name.2.json"
}

run_twice modified math.c beta 8 4096
run_twice added math.c added 8 4096
run_twice deleted math.c removed 8 4096
run_twice tight math.c beta 1 0
run_twice python example.py helper 8 4096

grep -q '"calleeText":"helper"' "$work/python.1.json"
grep -q '"direction":"incoming"' "$work/python.1.json"
grep -q '"resolution":"resolved"' "$work/python.1.json"
grep -q 'return 1' "$work/python.1.json"
grep -q 'return 2' "$work/python.1.json"

grep -q '"schemaVersion":1' "$work/modified.1.json"
grep -q '\\"math.c\\",\\"beta\\"' "$work/modified.1.json"
grep -q '"previous":{"status":"present"' "$work/modified.1.json"
grep -q '"current":{"status":"present"' "$work/modified.1.json"
grep -q '"resolution":"resolved"' "$work/modified.1.json"
grep -q '"resolution":"ambiguous"' "$work/modified.1.json"
grep -q '"resolution":"unresolved"' "$work/modified.1.json"
grep -q '"snippet":{"status":"unavailable"' "$work/modified.1.json"

grep -q '"previous":{"status":"unavailable"' "$work/added.1.json"
grep -q '"current":{"status":"present"' "$work/added.1.json"
grep -q '\\"math.c\\",\\"added\\"' "$work/added.1.json"

grep -q '"previous":{"status":"present"' "$work/deleted.1.json"
grep -q '"current":{"status":"unavailable"' "$work/deleted.1.json"
grep -q '\\"math.c\\",\\"removed\\"' "$work/deleted.1.json"

grep -q '"maxItems":1' "$work/tight.1.json"
grep -q '"maxSourceBytes":0' "$work/tight.1.json"
grep -q '"usedItems":1' "$work/tight.1.json"
grep -q '"usedSourceBytes":0' "$work/tight.1.json"
grep -q '"omittedEvidenceIds":\["' "$work/tight.1.json"

"$cli" "$repo" HEAD^ HEAD math.c beta 8 4096 "$work/file.json"
cmp "$work/file.json" "$work/modified.1.json"

printf 'context compiler CLI passed\n'
