# Avatar

A desktop app built with [Tauri 2](https://tauri.app). The frontend is React + TypeScript (Vite) and the backend is written in C.

React calls Tauri commands, the commands call the C library through Rust FFI, and Cargo compiles the C sources on every build, so there is no separate C build step.

```text
React (src/)  --invoke()-->  Tauri commands (src-tauri/src/lib.rs)
                                   |  safe Rust wrappers (src-tauri/src/ffi.rs)
                                   v
                             C backend (backend/), compiled by src-tauri/build.rs
```

## Layout

| Path | Contents |
| --- | --- |
| `backend/include/avatar.h` | Public C API and its conventions |
| `backend/src/` | C implementation. Every `.c` file here is compiled automatically |
| `backend/tests/test_avatar.c` | Plain C tests, no framework needed |
| `src-tauri/build.rs` | Compiles `backend/src/*.c` into a static library with the [`cc`](https://docs.rs/cc) crate |
| `src-tauri/src/ffi.rs` | Hand-written `extern "C"` bindings, safe wrappers, and Rust tests against the C code |
| `src-tauri/src/lib.rs` | Tauri commands exposed to the frontend |
| `src/backend.ts` | Typed TypeScript wrappers around `invoke()` |
| `src/App.tsx` | Demo UI: greets a name and draws an identicon, both computed in C |
| `src-tauri/src/ai/` | Local AI service: Ollama client, Qwen 3.5 model rules, config, errors and the `ai_*` Tauri commands |
| `src/ai/aiService.ts` | The single frontend entry point for local AI (typed wrappers around the `ai_*` commands) |
| `src/ai/types.ts` | TypeScript mirrors of the AI request, response, event and error shapes |
| `src/ai/AiPanel.tsx` | Minimal test panel for the AI integration: connection, model, download, streaming prompt |
| `docs/ollama.md` | Setup and developer guide for Ollama + Qwen 3.5 |
| `src-tauri/src/review/` | PR Bug Check: `gh` CLI access, diff parsing and chunking, the review engine, report store, auto-review watcher and the `bug_check_*` Tauri commands |
| `src/bugcheck/bugCheckService.ts` | The single frontend entry point for PR Bug Check (typed wrappers around the `bug_check_*` commands and watcher events) |
| `src/bugcheck/types.ts` | TypeScript mirrors of the PR Bug Check report, finding, event, watcher and error shapes |
| `src/bugcheck/BugCheckPanel.tsx` | The PR Bug Check panel: open PRs, run and cancel checks, findings, posting, auto review |
| `docs/pr-bug-check.md` | User and developer guide for PR Bug Check |

## Prerequisites

- Node.js 20.19+ or 22.12+
- Rust stable, installed with [rustup](https://rustup.rs)
- A C toolchain, which Rust also needs for linking. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for details.
  - **Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. WebView2 is already part of Windows 10 and 11.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** `build-essential` plus the WebKitGTK packages listed in the Tauri prerequisites.

## Develop

```bash
npm ci --ignore-scripts
npm run tauri:dev
```

`npm run tauri:dev` starts the app with hot reload. It runs `tauri dev` and also watches `backend/`, so saving a C file rebuilds and restarts the app. Plain `npm run tauri dev` works too, but it only watches `src-tauri/`.

`npm run dev` starts only the Vite server. The UI loads in a browser, but it can't reach the C backend outside the app.

To build a release bundle or installer (written to `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

## Test

```bash
npm test
```

`npm test` runs `cargo test`, which calls the C backend through the same Rust bindings the app uses.

The index compiles the Tree-sitter C runtime and grammars from the installed npm
packages. The Node bindings are unused. Run the C tests from the repository root
with Git and a C compiler on PATH:

```bash
npm ci --ignore-scripts
sh backend/tests/test_index_revision.sh
```

On Windows, run the C test script in WSL with a Linux C compiler.

## Repository index

`index_build_revision` reads a pinned Git revision. The tree contains the project
root, tracked source directories, supported files, and parsed symbols with their
lexical parents. Supported extensions cover C, Rust, JavaScript, TypeScript, and
TSX. Working-tree edits are outside the selected commit.

`index_map_calls` projects direct callsites between any two scopes. Resolution
uses unique syntactic names in the indexed language. Imports, dynamic dispatch,
and function pointers require additional semantic analysis. Partial parse coverage
is reported alongside the relationships that could be extracted.

`index_compare_revisions` matches symbols by exact path and qualified name and
compares their pinned bytes. `index_collect_context` supplies phase two with
the target source, direct call evidence, and available snippets. Keep the index
alive while consuming that evidence.

## Context compiler contract

`backend/include/context_compiler.h` defines the phase-two request and output
contracts. A request pins the repository and head commit, optionally pins a
base commit, and selects `onboarding`, `task`, or `review` mode. Scope, symbol,
and evidence IDs are derived from data rather than array positions, so the
graph and the agent brief can refer to the same pinned source.

`context-graph.json` (schema version 1) keeps the project root as a container
and starts the visible UI graph at module scope, expanding to files and
symbols. It contains no source text: every edge carries an evidence ID, and a
client opens source through that ID. `context-brief.json` (schema version 1) is
the budgeted brief built from the same evidence catalog. Relation states keep
budget omissions (`omitted`), unresolved calls (`unresolved`), and missing
discovery (`unavailable`) distinct. Review mode reuses `ReviewContext` and
`review-context.json` v1 from `context_package.h` for the selected symbol.

The UI mock contract is a separate schema. The compiler graph declares an
explicit `minikv-ui` adapter and schema versions instead of silently treating
the indexer graph shape as the UI shape.

The agreed request, graph, and brief fixture lives in
`backend/tests/fixtures/context_compiler/`, and `test_context_contract` checks
it byte-for-byte. Regenerate it only after an intentional contract change:

```bash
make -C backend .build/test_context_contract
cd backend && .build/test_context_contract --write-fixtures
```

### Compile one symbol

`chronos_context` is the end-to-end slice: it resolves one changed symbol,
builds the base/head indexes, collects direct callers and callees, ranks and
budgets the evidence, and writes `review-context.json` v1.

```bash
make -C backend .build/chronos_context
backend/.build/chronos_context <repo> <base> <head> <path> <qualifiedName> \
  [maxItems] [maxSourceBytes] [output.json]
```

For example:

```bash
backend/.build/chronos_context . HEAD^ HEAD src/kv.c kv_resize 8 4096
```

Without an output path it writes to stdout. Added targets have an unavailable
`previous` source, deleted targets have an unavailable `current` source, and
modified targets include both. Direct call evidence keeps ambiguous and
unresolved calls as evidence with unavailable snippets instead of dropping
them. `make -C backend test` runs the CLI twice against the same commit pair
and requires byte-identical output.

### Flow discovery and bridges

`backend/include/context_flow.h` adds deterministic flow discovery on top of
the index. Onboarding seeds recognized entry points and walks callees;
task mode walks callers before callees from explicit symbols, paths, or changed
symbols. Rank combines hop proximity, caller direction, cross-module
transitions, and a fan-in penalty, so a ubiquitous helper cannot dominate.
Cycles collapse at the first visited node. Flow IDs are derived from the seed
and target symbol IDs.

`context_discover_bridges` recognizes the Chronos path from an
`invoke`/wrapper callsite through a `generate_handler!` registration and Rust
dispatch to a C FFI symbol. Every bridge edge carries an evidence ID and the
pinned callsite or registration range. The fixtures under
`backend/tests/fixtures/context_flow/` cover a cycle, a high-fan-in helper,
same-name symbols, and the real Chronos command/wrapper naming pattern.

### Both views

`backend/include/context_views.h` builds the graph and brief from one flow
request. The graph keeps the project root as a container and starts at module
scope, expanding to files and symbols. It contains contains-edges and
resolved/unresolved/ambiguous call edges, but no source text. Every edge has an
evidence ID, and a client opens the callsite behind an edge through that ID.
The brief contains template-rendered entry points, top flows, likely edit and
test locations, and unresolved calls, with evidence IDs for retrieving source.

Both documents share one evidence catalog, so the same evidence ID resolves to
the same pinned location from either view. The brief uses a separate item and
source budget. Evidence skipped by the brief is still present in the graph as
`omitted`, so expanding the graph can reveal relationships excluded from the
prompt. `test_context_views` covers the shared catalog, template text, tight
budgets, omitted graph edges, and task-mode caller ranking.

The Tauri app exposes `compile_views` and `read_source`. The Context compiler
panel compiles a brief and opens its matching graph; the Brief and Graph tabs
resolve evidence through the same catalog, and an evidence button loads the
pinned callsite range with `read_source`.

Multi-symbol review is available through `compile_multi_views` and the
multi-target rows in the panel. Task mode accepts up to 64 exact
path/qualified-name targets. All targets share one evidence catalog, one
combined graph, and one global item/source budget. The brief gains a `targets`
section so each requested symbol has its own evidence-backed item, while top
flows and edit locations are ranked across the combined set.

### Evaluation and supported resolution

`test_context_eval` is the hand-labeled evaluation set. It covers onboarding,
change impact, symbol review, and the Chronos bridge fixture. Golden JSON under
`backend/tests/fixtures/context_eval/golden/` is byte-compared, and semantic
assertions check required evidence retained, unresolved relationships, brief
budgets, and source-free graph payloads. The report prints compiler/baseline
token estimates (bytes / 4) for each task.

Supported resolution is deliberately syntactic and deterministic:

- Symbols match by exact repository-relative path and qualified name.
- A call resolves only when its callee spelling has one indexed definition in
  the caller's language.
- Multiple definitions make the call ambiguous; no definition makes it
  unresolved. Neither is guessed.
- Imports, module aliases, overloads, dynamic dispatch, and function pointers
  are not resolved.
- Cross-language edges come only from the explicit Tauri/FFI bridge pattern:
  a frontend `invoke` or wrapper string, a `generate_handler!` registration,
  Rust `ffi::` dispatch, and a matching C symbol.
- Unsupported or partial parse coverage is reported as incomplete coverage,
  never as a resolved relationship.

## PR Bug Check

PR Bug Check reviews GitHub pull requests for logic bugs, state leaks, unit mismatches, security, concurrency and error-handling bugs with the local Qwen 3.5 model. It shows each finding with an explanation and a suggested fix, and posts the findings you select as inline review comments. Run it per PR from the **PR Bug Check** panel, or turn on auto review to check, while the app runs, open PRs that have no up-to-date check: at first every open PR not checked yet (up to 50), then PRs that are opened or get new commits (posting stays manual unless you turn on auto-post, which never posts the same finding on a PR twice).

PR code is analysed only on this machine; GitHub is reached only through the [GitHub CLI](https://cli.github.com), and only the comments you post are sent to GitHub. It needs the Ollama setup above plus a logged-in `gh`:

```bash
gh auth login
npm run tauri:dev
```

See [docs/pr-bug-check.md](docs/pr-bug-check.md) for how checks and auto review work, what is sent where, posting, limitations, troubleshooting, tests (including a real read-only test) and reuse from TypeScript and Rust.

## Adding a C function

1. Declare it in `backend/include/avatar.h` and implement it in `backend/src/`. New `.c` files are picked up automatically.
2. Mirror the declaration in the `unsafe extern "C"` block in `src-tauri/src/ffi.rs`, and add a safe wrapper next to the existing ones.
3. Expose the wrapper as a `#[tauri::command]` in `src-tauri/src/lib.rs` and add it to `generate_handler!`.
4. Add a typed wrapper in `src/backend.ts` and call it from React.

The FFI conventions are documented at the top of `avatar.h`:

- Strings go into C as (pointer, length) pairs of UTF-8 bytes. Most strings come back through caller-provided buffers: query the length first, then fill an exactly sized buffer, as with `snprintf`.
- Heap-returning APIs such as blame, git command output, compiled views, and source reads return a string that must be freed with `chronos_free_string()`.
- A negative return value is an error code, and `chronos_last_error()` describes it. Rust turns it into `BackendError { code, message }`, which rejects the promise on the JavaScript side.

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode), [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) and [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) extensions.