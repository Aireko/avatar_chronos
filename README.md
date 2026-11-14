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
lexical parents. Supported extensions cover C, Rust, JavaScript, TypeScript, TSX,
Python, and Java. Working-tree edits are outside the selected commit.

`index_map_calls` projects direct callsites between any two scopes. Resolution
uses unique syntactic names in the indexed language. Python module-level imports
and aliases are resolved statically; dynamic dispatch, wildcard imports, and
function pointers require additional semantic analysis. Partial parse coverage
is reported alongside the relationships that could be extracted.

`chronos_coverage <repo> <revision>` reports the source inventory and the
`language-coverage` diagnostic. It exits nonzero when no supported source files
are indexed so CI can reject empty context graphs. Run the mixed-language
regression directly with `make -C backend coverage-diagnostic`.

`index_compare_revisions` matches symbols by exact path and qualified name and
compares their pinned bytes. `index_collect_context` supplies phase two with
the target source, direct call evidence, and available snippets. Keep the index
alive while consuming that evidence.

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