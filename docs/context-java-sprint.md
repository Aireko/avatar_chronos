# Context compiler Java support sprint

Branch: `context-java-support` (local only; do not push)

## Goal

Add Java as a first-class context-compiler language: parse Java source, build
the same scope/symbol/call graph used by the context compiler, resolve the
common call forms statically, recognize Java entry points and tests, and prove
the result through fixtures, a real repository, and the language-coverage
diagnostic.

## Scope

In scope:

- `.java` grammar integration and build wiring.
- Classes, interfaces, enums, records, annotations, methods, constructors.
- Method calls, including receiver-qualified calls.
- Package and import records used for static resolution.
- Java onboarding entry points and test-location heuristics.
- Parser, mapper, context-view, and coverage tests.
- Performance review of the new parser and resolver paths.

Out of scope for this sprint:

- Full Java type inference, generics resolution, or dynamic dispatch.
- Reflection, annotation processing, or framework-specific wiring.
- Cross-revision rename detection beyond the existing symbol matcher.
- Kotlin, C++, or Go.

## Slices

### Slice 1: Grammar and symbol extraction

- Add `tree-sitter-java` to the JS dependency set.
- Compile the grammar in `backend/Makefile` and `src-tauri/build.rs`.
- Map `.java` to the Java grammar.
- Extract class-like declarations, methods, constructors, and callsites.
- Record the file package and module-level imports.
- Add parser tests for nested classes, methods, constructors, receivers, and
  byte ranges.

Exit check: Java fixtures produce the expected symbols, parent links, call
texts, and source ranges; the full backend suite passes.

### Slice 2: Static call resolution

- Extend the mapper with Java-aware candidate matching.
- Resolve same-file and same-class calls.
- Resolve receiver-qualified calls through imports, same-package classes, and
  fully qualified names.
- Keep unresolved and ambiguous calls explicit rather than guessing.
- Add CLI/context tests for resolved, ambiguous, and unbound calls.

Exit check: Java call evidence appears in compiled review context with stable
evidence IDs and pinned locations; repeated compiles are byte-identical.

### Slice 3: Entry points, tests, and views

- Treat Java `main` methods as onboarding entry points.
- Recognize Java test paths (`src/test/java`, `*Test.java`, `*Tests.java`) and
  test-named methods.
- Add context-view and task-impact fixtures for Java.
- Keep test detection conservative so helper methods are not reported as tests.

Exit check: Java onboarding and task-impact briefs contain entry, flow, edit,
and test locations without leaking unrelated helper methods.

### Slice 4: Coverage and real-repository validation

- Teach the coverage diagnostic to classify Java as supported.
- Add a Java coverage fixture and CI assertion.
- Measure a real Java repository and record file/byte coverage.
- Verify the diagnostic reports zero unsupported Java files once support is in
  place.

Exit check: Java fixture coverage is above 90%; the real repository measurement
is recorded; `make -C backend test` and the coverage CI target pass.

### Slice 5: Performance hardening

- Revisit parser allocation and call-text construction.
- Ensure Java resolution does not scan every callable symbol for every call.
- Benchmark indexing and context compilation on the real Java fixture.
- Keep only optimizations that preserve deterministic output and all tests.

Exit check: No test regressions; parser/index/compile timings are recorded and
any avoidable hot-path allocation or full-table scan is removed.

## Measurements

Real Android Studio Java repositories on the local machine, indexed at `HEAD`:

| Repository | Files | Bytes | Coverage | Index time |
| --- | ---: | ---: | ---: | ---: |
| `PetShop` | 14 / 14 | 6,728 / 6,728 | 100.0% | ~4.5 s |
| `Lab08` | 4 / 4 | 3,535 / 3,535 | 100.0% | ~1.0 s |

`build.gradle.kts` and `settings.gradle.kts` are excluded from the source
inventory because they are build configuration, not application source. The
Java files themselves are fully covered.

The synthetic Java coverage fixture in CI has 10 supported Java files and one
unsupported Go file, so the assertion checks a mixed inventory above 90%.

## Performance review

The first resolver passed every same-name method through Java receiver matching
for unqualified calls. A synthetic 500-file Java repository with repeated
method names exposed that scan:

| Measurement | Before | After |
| --- | ---: | ---: |
| Java index, 500 files / 6,509 scopes | ~1.35 s | ~1.20 s |
| Context views, full graph | ~0.67 s | ~0.65 s |
| `PetShop` index, 14 files | ~0.04 s | ~0.04 s |

The resolver now keeps a file/name index in `MapperLookup`. Unqualified Java
calls resolve against the caller's file first, so a repository with thousands
of same-named methods no longer scans the global short-name set for every call.
Qualified calls still use the receiver/import matcher. Full graph view
materialization remains outside this slice; the payload-control page API is the
long-term fix for that path.

## Definition of done

- Java is included in the coverage diagnostic and the supported-language docs.
- Java context compilation works on synthetic and real repositories.
- CI includes the Java coverage regression.
- The sprint is split into reviewable commits.
- The branch remains local and is not pushed.
