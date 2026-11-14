# Chronos

Chronos is a desktop Git explorer that works at the level of files and functions, not just commits. You open a repository, see its history drawn as a hand-sketched commit graph, and then narrow it down: show only the commits that touched one file, or one function inside that file. From there you can compare a function at an older commit with how it looks now, or roll a single function back to an older version. Finding out who wrote a file and having a local model check pull requests for bugs are built too, but the UI doesn't open them yet (see below).

It started as a hackathon project. The repository and package are still called `avatar`, which is why you'll see that name in paths and in `package.json`.

## What it does today

- **Commit graph.** Branches and merges drawn on paper (or a blackboard, if you switch themes), with zoom keys and a collapsible branch legend.
- **File and function scope.** The Project / File / Function tabs in the toolbar cut the graph down to the history of one file or one function. The C backend reads each commit's diff and works out which function each changed line belongs to. It does that with a line-based guess at definitions plus the function names in Git's hunk headers, not a full parse, so now and then it misses or misnames a function.
- **Call map.** With a function in scope, the History | Calls switch next to the scope chip swaps the commit graph for a map of who calls it and what it calls, built from the latest commit. Callers sit on the left, callees on the right, and arrows run from caller to callee. Click a box or an arrow to see the call sites in the caller's source. Double-click a box (or use "Centre here") to follow the chain, and use Back to return. Calls the indexer can't tie to one function are drawn as dashed boxes rather than dropped. It reads C, Rust, JavaScript and TypeScript only, and only direct calls by name, so imports, dynamic dispatch and function pointers aren't followed. It reflects the commit, not uncommitted edits.
- **Commit details.** Click a commit to see what changed since then, open a side-by-side comparison in the editor, or rebase onto it. With a file or function in scope, "rebase" means something narrower: that one file or function is put back the way it was at that commit and saved as a new commit. Nothing else in the repo is touched and history is never rewritten.
- **Code editor and terminal.** A built-in editor for the files in the repo folder (it skips hidden files, `node_modules` and `target`), with a side-by-side diff and its own pannable commit map in the corner. A terminal docks along the bottom and runs in the repo folder.
- **Themes and reload.** Switch between paper and blackboard, and reload the history after you commit from somewhere else.

### Built, but not in the UI yet

These are finished on the backend and have their own panels, but on `main` nothing in the UI opens them. [PR #14](https://github.com/Aireko/avatar_chronos/pull/14) (`feature/toolbar-tools`) adds toolbar buttons for the first three, which open in a drawer on the right, along with a folder picker and a button to show the repo in File Explorer.

- **People.** Runs `git blame` on a file and lists who wrote it, most lines first. You can draft an email to any of them with the context already filled in. It opens in your normal mail app and nothing is sent for you.
- **Local AI.** A panel for talking to a Qwen 3.5 model running in [Ollama](https://ollama.com) on your own machine. No API key, and by default nothing leaves localhost.
- **PR reviews.** Pulls open pull requests through the `gh` CLI, has the local model read each diff looking only for real bugs (not style), and lets you post the findings you agree with as inline review comments. There's an opt-in watcher that checks new PRs while the app is open.
- **Context views.** Shows the brief the context compiler builds around a function, plus the calls in and out of it, as a tree with a table of call edges. No toolbar button for this one yet.

## Where it's headed

The aim is a function-level code review tool. You pick two commits, and Chronos tells you which functions were added, changed or removed, what calls them and what they call, which tests cover them, and how each one got to where it is. A reviewer, either a person or the local model, then gets exactly that context and nothing more, and every finding it reports points at a real function and line.

A lot of the backend for that is already here. The C indexer parses two revisions with Tree-sitter, matches symbols between them and maps direct calls. The context compiler packages a ranked, size-limited brief around a target function. What's missing is mostly the wiring: feeding that brief to the reviewer instead of a raw diff, opening the context panel (`src/context/ContextViewsPanel.tsx`) from the UI, moving the commit graph's function history onto the Tree-sitter index, and linking review findings back to nodes in the graph.

Left out on purpose for now: tracking functions across renames, call resolution beyond plain names (imports, dynamic dispatch and function pointers aren't followed), and any kind of database. The index is rebuilt from Git each time.

## How it's built

| Layer | What we use |
| --- | --- |
| Desktop shell | [Tauri 2](https://tauri.app) (Rust) |
| UI | React 19, TypeScript, Vite. Plain CSS with theme variables, no component library. The hand-drawn font is Patrick Hand, and code uses the system monospace font |
| Backend | C11, compiled into the app by Cargo through the [`cc`](https://docs.rs/cc) crate |
| Parsing | [Tree-sitter](https://tree-sitter.github.io) with the C, Rust, JavaScript, TypeScript and TSX grammars |
| Git | The `git` command line, called from C and Rust |
| AI | Ollama serving `qwen3.5` models, called from Rust with `reqwest` |
| GitHub | The `gh` CLI, for PR reviews |
| Tests | Plain C test programs and a Makefile, `cargo test`, Vitest, and GitHub Actions on Ubuntu |

```text
React (src/)  --invoke()-->  Tauri commands (src-tauri/src/lib.rs)
                                   |              \
                                   |               +-- ai/         Ollama client
                                   |               +-- review/     PR bug check, gh CLI
                                   |               +-- history.rs  file and function rebase
                                   v
                    C backend (backend/) through ffi.rs, built by src-tauri/build.rs
                    parser, index, mapper, git history, context compiler
```

The webview never talks to Ollama, GitHub or the shell directly. All of that goes through Rust commands, and the AI rules (localhost only, Qwen 3.5 only, input limits, cancellation) are enforced there in one place. Shell commands are not restricted, though: `run_shell_command` runs whatever the terminal sends it.

### Layout

| Path | What's there |
| --- | --- |
| `backend/include/`, `backend/src/` | The C library. Every `.c` file in `src/` is compiled automatically |
| `backend/tests/` | C tests, the small CLIs they drive, and fixtures |
| `src-tauri/src/lib.rs` | Tauri commands the frontend can call |
| `src-tauri/src/ffi.rs` | `extern "C"` bindings and the safe wrappers around them |
| `src-tauri/src/ai/` | Ollama client and model rules |
| `src-tauri/src/review/` | PR bug check engine, GitHub calls, saved reports, watcher |
| `src/graph/` | Commit graph, scope bar, commit details, code editor, terminal |
| `src/ai/`, `src/bugcheck/`, `src/blame/` | The Local AI, PR reviews and People panels |
| `src/context/` | The context views panel |
| `docs/` | Longer guides for the AI and PR review features |

## Running it

You'll need:

- Node.js 22.12+ or 24+ (20.19+ runs the app, but not the Vitest tests)
- Rust stable, from [rustup](https://rustup.rs)
- A C compiler. On Windows that's the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. On macOS, `xcode-select --install`. On Linux, `build-essential` plus the WebKitGTK packages from the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- `git` on your PATH
- Optional: Ollama with a Qwen 3.5 model for the AI features, and the `gh` CLI (signed in) for PR reviews

```bash
npm ci --ignore-scripts
```

```bash
npm run tauri:dev
```

Don't drop `--ignore-scripts`. The `tree-sitter` npm packages try to build a Node addon on install, which tends to fail on Windows, and we don't use it anyway. We only need their C sources, and Cargo compiles those itself.

`npm run tauri:dev` also watches `backend/`, so saving a C file rebuilds and restarts the app. Plain `npm run tauri dev` only watches `src-tauri/`. `npm run dev` starts just the Vite server: the UI loads in a browser, but it can't reach the backend from there.

To build an installer (it ends up in `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

### Setting up the local model

```bash
ollama pull qwen3.5:9b
```

That's the default. On a machine with less memory, `qwen3.5:4b` is fine. Set `OLLAMA_MODEL` to use a different tag and `OLLAMA_BASE_URL` if Ollama isn't on its usual port. Cloud tags and non-Qwen models are refused on purpose. [docs/ollama.md](docs/ollama.md) has every setting, model sizes and troubleshooting, and [docs/pr-bug-check.md](docs/pr-bug-check.md) covers PR reviews, including exactly what gets sent to GitHub.

## Tests

```bash
npm test
```

```bash
npm run test:ui
```

`npm test` runs `cargo test`, which calls the C code through the same bindings the app uses and also covers the AI and review modules. `npm run test:ui` runs the frontend's Vitest tests.

The C suite builds with gcc and runs under the undefined-behaviour sanitizer:

```bash
make -C backend test
```

It compiles Tree-sitter out of `node_modules`, so run `npm ci --ignore-scripts` first. On Windows, run it in WSL. CI runs the C suite and `cargo test` on every push and pull request. The Vitest tests aren't in CI yet.

## Adding a C function

1. Declare it in `backend/include/avatar.h` and implement it in `backend/src/`.
2. Mirror the declaration in the `extern "C"` block in `src-tauri/src/ffi.rs` and add a safe wrapper next to the others.
3. Expose the wrapper as a `#[tauri::command]` in `src-tauri/src/lib.rs` and add it to `generate_handler!`.
4. Add a typed wrapper in `src/backend.ts` and call it from React.

Follow the patterns already in `avatar.h`:

- Export it with `CHRONOS_API` and give it the `chronos_` prefix.
- Strings go into C as NUL-terminated UTF-8 `const char*`. Results come back as a heap-allocated JSON string, either returned directly or through a `char** out_json` parameter.
- C allocates the strings it returns. The Rust wrapper copies each one and then frees it with `chronos_free_string()`, so a new function that returns a string needs the same treatment.
- A negative return value is an `AVATAR_ERR_*` code, and `chronos_last_error()` holds the matching message. Rust wraps both as `BackendError { code, message }`, which rejects the promise in JavaScript.

## Logo

- The logo was created using figma with the help of some shapes from the Material 3 Design Kit community library.

## Worth knowing

- Function history in the graph is a best guess. It comes from Git's diffs and a line-based detector, so unusual formatting can put a change under the wrong function or miss it. The function list in the Function picker comes from Tree-sitter when it can parse the file, and from the same line-based detector when it can't.
- A file or function rebase won't run if that file has uncommitted changes, so it can't eat your work. A branch rebase is a real `git rebase`; if it stops on a conflict, the commit panel offers to abort it.
- The editor and terminal work on your actual checkout. They aren't sandboxed.
- The app only talks to an Ollama server on loopback unless you set `OLLAMA_ALLOW_REMOTE=true` and point `OLLAMA_BASE_URL` at another host. Your code stays on your machine unless you choose to post review comments to GitHub.
- Release builds on Windows are served from `http://tauri.localhost`, which Ollama's default CORS policy rejects. That's another reason model calls go through Rust and not the webview.
