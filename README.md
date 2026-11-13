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

## Adding a C function

1. Declare it in `backend/include/avatar.h` and implement it in `backend/src/`. New `.c` files are picked up automatically.
2. Mirror the declaration in the `unsafe extern "C"` block in `src-tauri/src/ffi.rs`, and add a safe wrapper next to the existing ones.
3. Expose the wrapper as a `#[tauri::command]` in `src-tauri/src/lib.rs` and add it to `generate_handler!`.
4. Add a typed wrapper in `src/backend.ts` and call it from React.

The FFI conventions are documented at the top of `avatar.h`:

- Strings go into C as (pointer, length) pairs of UTF-8 bytes. Strings come back through caller-provided buffers: query the length first, then fill an exactly sized buffer, as with `snprintf`.
- A negative return value is an error code, and `avatar_status_message()` describes it. Rust turns it into `BackendError { code, message }`, which rejects the promise on the JavaScript side.
- C never allocates memory for the caller, so nothing has to be freed across the boundary.

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode), [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) and [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) extensions.