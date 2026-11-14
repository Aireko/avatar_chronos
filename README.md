# Chronos

Chronos is a desktop Git explorer that works at the level of files and functions, not just commits. You open a repository, see its history drawn as a hand-sketched commit graph, and then narrow it down: show only the commits that touched one file, or one function inside that file. From there you can compare a function at an older commit with how it looks now, roll a single function back to an older version, or ask a local model to explain a commit. It can also show who wrote a file, check pull requests for bugs with a local model, and map what a change touches before you push it.

It started as a hackathon project. The repository and package are still called `avatar`, which is why you'll see that name in paths, in `package.json` and in the Tauri config. The window and the toolbar say Chronos.

## What it does today

- **Commit graph.** Branches and merges drawn on paper (or a blackboard, if you switch themes), with zoom keys and a collapsible branch legend.
- **File and function scope.** The Project / File / Function tabs in the toolbar cut the graph down to the history of one file or one function. The C backend reads each commit's diff and works out which function each changed line belongs to. It does that with a line-based guess at definitions plus the function names in Git's hunk headers, not a full parse, so now and then it misses or misnames a function.
- **Call map.** With a function in scope, the History | Calls switch next to the scope chip swaps the commit graph for a map of who calls it and what it calls, built from the latest commit. Callers sit on the left, callees on the right, and arrows run from caller to callee. Click a box or an arrow to see the call sites in the caller's source. Double-click a box (or use "Centre here") to follow the chain, and use Back to return. The map draws in from the left, drags to pan, and zooms like the history map (+/− keys, Ctrl/⌘-wheel or the buttons); Fit shows the whole map at once. Calls the indexer can't tie to one function are drawn as dashed boxes rather than dropped. It reads C, Rust, JavaScript and TypeScript only, and only direct calls by name, so imports, dynamic dispatch and function pointers aren't followed. It reflects the commit, not uncommitted edits.
- **Commit details.** Click a commit to see what changed since then, open a side-by-side comparison in the editor, or rebase onto it. With a file or function in scope, "rebase" means something narrower: that one file or function is put back the way it was at that commit and saved as a new commit. Nothing else in the repo is touched and history is never rewritten.
- **Code editor and terminal.** A built-in editor for the files in the repo folder (it skips hidden files, `node_modules` and `target`), with a side-by-side diff and its own pannable commit map in the corner. A terminal docks along the bottom and runs in the repo folder.
- **Themes and reload.** Switch between paper and blackboard, and reload the history after you commit from somewhere else.
### Opening a repository

- **Path field.** Type a path and press Open (or Enter). Its dropdown lists the last 8 repositories that opened successfully, newest first. Use Up/Down and Enter to open one, and Shift+Delete or the × on a row to forget it.
- **Browse….** Opens your system's folder picker and loads the folder you choose. The start screen has the same button.
- **Explorer.** Shows the open repository folder in your file manager.
- **Reload.** Reads the history again after you commit from somewhere else.

The graph loads the newest 500 commits across all branches, tags and remotes.

### Browsing history

- **Commit graph.** Branches and merges drawn on paper (or a blackboard, if you switch themes). Drag or scroll to pan, Ctrl/Cmd+scroll or the `+` and `-` keys to zoom, and Ctrl/Cmd+0 to reset. The branch legend is collapsible: hover a branch to fade the others, click it to jump to its newest commit.
- **File and function scope.** The Project / File / Function tabs in the toolbar cut the graph down to the history of one file or one function. File opens a filterable file picker. Function asks for the file first, then lists its functions. The C backend reads each commit's diff and works out which function each changed line belongs to. It does that with a line-based guess at definitions plus the function names in Git's hunk headers, not a full parse, so now and then it misses or misnames a function.
- **Find.** Ctrl+F (Cmd+F on macOS), or the Find button on the map, searches the first line of each commit message, authors and hash prefixes in the current scope. `author:jane` or `author:"Jane Doe"` matches the author only, and `"a quoted phrase"` matches as one phrase. Enter and Shift+Enter step through the matches.
- **Keyboard.** Tab to a commit and press Enter to select it. Left goes to the parent, Right to a child on the same lane.

### Working with a commit

Click a commit and a small bubble offers **Details**, **Diff** and **Rebase**.

- **Diff** shows what changed since that commit: the whole branch in Project scope, just the file in File scope, or just the function's text in Function scope.
- **Details** opens the commit panel on the right: message, author, date, commit ID (click to copy), links to the commits before and after, and the files it changed with the functions it touched. Click the author to highlight their commits and fade everyone else's. Esc or the × on the "Highlighting" chip turns it off.
- **View in editor** (in Details) opens a side-by-side comparison of that commit against your working tree.
- **Explain this commit** (in Details) opens the Local AI drawer and asks the model to explain the commit in plain language. It runs right away if Ollama and a model are ready. If they aren't, it tells you what's missing, and you press Generate once they are.
- **Rebase** in Project scope is a real `git rebase` onto that commit. With a file or function in scope it means something narrower: that one file or function is put back the way it was at that commit and saved as a new commit. Nothing else in the repo is touched and history is never rewritten.

### Branches and pushing

- **Branch switcher.** The toolbar dropdown runs `git switch` as soon as you pick a branch. **+ Branch** creates a new one with `git switch -c` and takes your uncommitted changes along.
- **Push to Git.** Opens a dialog with a commit message and a target branch (an existing one or a new one). **View blast radius** commits everything in the working tree (`git add -A`, then commit), takes the functions changed in that commit, and draws a map of their direct callers and callees using the context compiler. The local model then reviews the change with that context and the diff, looking only for real bugs, and the map colours each function by what it found. **Push** (or **Push anyway**, if there are findings) runs `git push -u origin HEAD:<branch>`. Push only shows up after the map, so you can't push from here without that commit. If a push to your current branch is rejected because the branch moved on, the dialog offers a Pull.

### Docked views

Three buttons in the bottom-left corner open these. They need a repository open first.

- **Code editor.** Replaces the map with an editor for the files in the repo folder (it skips hidden files, `node_modules` and `target`). Ctrl/Cmd+S saves and Ctrl/Cmd+P jumps to the file search. Side by side mode compares a commit with your working tree: the left side is read-only, the right side is editable, and Alt+Up / Alt+Down jump between changes. A small commit map sits in the corner; drag its bar to move it and its top-left corner to resize it.
- **Terminal.** Docks along the bottom and runs commands in the repo folder (`cmd /C` on Windows, `sh -lc` elsewhere). Up/Down recall earlier commands and Ctrl+L clears. Any command that starts with `git` refreshes the graph when it finishes.
- **Context compiler.** Replaces the map with the context compiler. Pick a revision and a mode: onboarding (entry points and main flows) or task / change impact (up to 64 functions you name by path and qualified name). Set a budget for brief items and source bytes, then press Compile views. The Brief tab shows the ranked brief. The Graph tab shows modules, files, symbols and calls, loaded one level at a time as you open them, with a table of relationships. Clicking an evidence ID loads the source it points at.

### Tools on the right

The Local AI, PR reviews and People buttons in the toolbar each open a drawer on the right. Only one drawer is open at a time, and the commit details panel shares the same space.

- **People.** Runs `git blame` on a file, or on one function or line range in it, and lists who wrote it, most lines first. You can draft an email to any of them with your question and the context filled in. It opens in your normal mail app and nothing is sent for you.
- **Local AI.** A panel for a Qwen 3.5 model running in [Ollama](https://ollama.com) on your own machine: connection status, picking or downloading a model, and a test prompt. No API key, and by default nothing leaves localhost. It's more of a test panel than a finished feature, but it's also where Explain this commit shows up.
- **PR reviews.** Pulls pull requests through the `gh` CLI, has the local model read each diff looking only for real bugs (not style), and lets you post the findings you agree with as inline review comments. You type the GitHub repository (`owner/name`) yourself; it doesn't follow the repo open in Chronos. There's an opt-in watcher that checks new PRs every few minutes while the app is open.

### Themes

Paper (light) and blackboard (dark). Chronos follows your system's light or dark setting until you flip the switch in the toolbar, and after that it remembers your pick. The window cross-fades when it switches. Animations are turned off if your system asks for reduced motion.

### Keys

| Key | What it does |
| --- | --- |
| Ctrl/Cmd+F | Find a commit (while the map is showing) |
| Enter / Shift+Enter | Next / previous match in Find |
| `+` / `-`, Ctrl/Cmd+0 | Zoom the map in / out, reset to 100% |
| Left / Right | Parent / child of the selected commit |
| Esc | Close the top-most panel, then clear the author highlight, then the selection |
| Ctrl/Cmd+S, Ctrl/Cmd+P | Save, search files (code editor) |
| Alt+Up / Alt+Down | Previous / next change (side-by-side editor) |
| Up / Down, Ctrl+L | Command history, clear (terminal) |

## Where it's headed

The aim is a function-level code review tool. You pick two commits, and Chronos tells you which functions were added, changed or removed, what calls them and what they call, which tests cover them, and how each one got to where it is. A reviewer, either a person or the local model, then gets exactly that context and nothing more, and every finding it reports points at a real function and line.

A lot of that is already here. The C indexer parses a revision with Tree-sitter, matches symbols between revisions and maps direct calls. The context compiler packages a ranked, size-limited brief around target functions, and the Context compiler view can browse it. Push to Git's blast radius already hands that brief, plus the diff, to the local model before you push, and draws the result as a map.

What's still missing: picking two commits in the app and comparing them (the backend can, but nothing calls it), feeding the brief to PR reviews (they still read raw diff chunks), moving the commit graph's function history onto the Tree-sitter index, and linking PR review findings back to nodes in the graph.

Left out on purpose for now: tracking functions across renames, full type inference, dynamic dispatch and function pointers, and any kind of database. The index is rebuilt from Git each time you compile a brief.

## How it's built

| Layer | What we use |
| --- | --- |
| Desktop shell | [Tauri 2](https://tauri.app) (Rust), with the opener and dialog plugins |
| UI | React 19, TypeScript, Vite. Plain CSS with theme variables, no component library. The hand-drawn font is Patrick Hand, and code uses the system monospace font |
| Backend | C11, compiled into the app by Cargo through the [`cc`](https://docs.rs/cc) crate |
| Parsing | [Tree-sitter](https://tree-sitter.github.io) with the C, Rust, JavaScript, TypeScript, TSX, Python and Java grammars |
| Git | The `git` command line, called from C and Rust |
| AI | Ollama serving `qwen3.5` models, called from Rust with `reqwest` |
| GitHub | The `gh` CLI, for PR reviews |
| Tests | Plain C test programs and a Makefile, `cargo test`, Vitest, and GitHub Actions on Ubuntu |

```text
React (src/)  --invoke()-->  Tauri commands (src-tauri/src/lib.rs)
     |                             |              \
     |                             |               +-- ai/         Ollama client
     |                             |               +-- review/     PR bug check, gh CLI
     |                             |               +-- history.rs  file and function rebase
     |                             v
     |              C backend (backend/) through ffi.rs, built by src-tauri/build.rs
     |              parser, index, mapper, git history, context compiler, context sessions
     |
     +-- Tauri plugins: dialog (folder picker), opener (show in file manager, mailto links)
```

The webview never talks to Ollama, GitHub or the shell directly. All of that goes through Rust commands, and the AI rules (localhost only, Qwen 3.5 only, input limits, cancellation) are enforced there in one place. Git commands from the UI (switch, commit, push, pull, rebase and so on) go through the C backend, which only allows a fixed list of subcommands. Shell commands are not restricted, though: `run_shell_command` runs whatever the terminal sends it.

### Layout

| Path | What's there |
| --- | --- |
| `backend/include/`, `backend/src/` | The C library. Every `.c` file in `src/` is compiled automatically |
| `backend/tests/` | C tests, the small CLIs they drive, and fixtures |
| `src-tauri/src/lib.rs` | Tauri commands the frontend can call, and the list that registers them all |
| `src-tauri/src/history.rs` | File and function rebase |
| `src-tauri/src/ffi.rs` | `extern "C"` bindings and the safe wrappers around them |
| `src-tauri/src/ai/` | Ollama client and model rules |
| `src-tauri/src/review/` | PR bug check engine, GitHub calls, saved reports, watcher |
| `src/graph/` | Commit graph, scope bar, Find, commit details, code editor and its mini map, terminal |
| `src/push/` | Push to Git dialog, blast radius map, branch switcher |
| `src/tools/` | Toolbar pieces: path field and recent repositories, the right-hand drawer, theme, animations, icons |
| `src/ai/`, `src/bugcheck/`, `src/blame/` | The Local AI, PR reviews and People panels, and the Explain this commit prompt |
| `src/context/` | The Context compiler view |
| `docs/` | Guides for the AI and PR review features, the Java support plan, and a diagram of how context pages load |

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

`npm test` runs `cargo test`, which calls the C code through the same bindings the app uses and also covers the AI and review modules. It uses a mocked Ollama and a fake `gh`, so it runs offline. `npm run test:ui` runs the frontend's Vitest tests.

The C suite builds with gcc and runs under the undefined-behaviour sanitizer:

```bash
make -C backend test
```

That runs every C test program and then two end-to-end scripts: one for the `chronos_context` CLI (C, Python and Java cases, each run twice to check the output is identical) and one for language coverage. Two more targets run parts of it on their own:

```bash
make -C backend coverage-diagnostic
```

```bash
make -C backend metrics
```

`metrics` prints the size, limits and load time of each context page against a large synthetic index, and fails if a page goes over budget.

The C suite compiles Tree-sitter out of `node_modules`, so run `npm ci --ignore-scripts` first. On Windows, run it in WSL. CI runs on every push and pull request (and by hand). One job builds the frontend (`npm run build`, which type-checks too) and runs `make -C backend all`, `test`, `coverage-diagnostic` and `metrics`. The other runs `cargo test`. The Vitest tests aren't in CI yet.

### Repository index

These are internal C functions in `backend/include/index.h`, not app features. The app reaches the index only through the context compiler.

`index_build_revision` reads a pinned Git revision. The tree contains the project
root, tracked source directories, supported files, and parsed symbols with their
lexical parents. Supported extensions are `.c`/`.h`, `.rs`, `.ts`, `.tsx`,
`.js`/`.jsx`/`.mjs`/`.cjs`, `.py`/`.pyi` and `.java`. Working-tree edits are
outside the selected commit.

`index_map_calls` projects direct callsites between any two scopes. How a call
is resolved depends on the language:

- C, Rust, JavaScript and TypeScript use unique syntactic names in the same language.
- Python follows module-level imports, from-imports, aliases and relative imports, or a top-level function in the same file. A bare name that isn't imported or defined in the file stays unresolved, and wildcard imports are ignored.
- Java checks the same file, then imports (including static and wildcard imports), the package and the receiver's type. If none of those match, a method name that is unique in the repo still resolves, and a name shared by several methods is marked ambiguous.

Dynamic dispatch and function pointers need more semantic analysis than this.
Partial parse coverage is reported alongside the relationships that could be
extracted.

`chronos_coverage <repo> <revision>` is a test CLI (built to
`backend/.build/chronos_coverage`) that reports the source inventory and the
`language-coverage` diagnostic. Files in a known list of other languages count
as unsupported source. It exits 1 when no supported source files are indexed, so
CI can reject empty context graphs, and 2 on a usage error.

`index_compare_revisions` matches symbols by exact path and qualified name and
compares their pinned bytes. Nothing in the app calls it yet.
`index_collect_context` supplies the target source, direct call evidence, and
available snippets. Keep the index alive while consuming that evidence.

The Context compiler view uses a session instead of compiling everything at
once: `chronos_views_open` builds the index once and returns a session handle,
`chronos_views_brief` returns the brief, `chronos_views_page` loads one level of the graph at a time (project, module,
file, symbol) and `chronos_views_source` fetches the source for one piece of
evidence. Pages never contain source text. Up to 4 sessions can be open, and
each one must be closed with `chronos_views_close`.

## Adding a C function

1. Declare it in `backend/include/avatar.h` and implement it in `backend/src/`.
2. Mirror the declaration in the `extern "C"` block in `src-tauri/src/ffi.rs` and add a safe wrapper next to the others.
3. Expose the wrapper as a `#[tauri::command]` in `src-tauri/src/lib.rs` and add it to `generate_handler!`.
4. Add a typed wrapper in `src/backend.ts` and call it from React.

Follow the patterns already in `avatar.h`:

- Export it with `CHRONOS_API` and give it the `chronos_` prefix.
- Strings go into C as NUL-terminated UTF-8 `const char*`. Results usually come back as a heap-allocated JSON string, either returned directly or through a `char** out_json` parameter. A few differ: the graph export and merge analysis write to a file path, and `chronos_views_open` hands back a `uint64_t` session handle.
- C allocates the strings it returns. The Rust wrapper copies each one and then frees it with `chronos_free_string()`, so a new function that returns a string needs the same treatment.
- A negative return value is an `AVATAR_ERR_*` code, and `chronos_last_error()` holds the matching message. Rust wraps both as `BackendError { code, message }`, which rejects the promise in JavaScript. The context compiler functions are the exception: they pass through their own status codes, where `1` means a partial result (still a success) and some negative numbers mean something different from the `AVATAR_ERR_*` code with the same value.

## Logo

- The logo was created using figma with the help of some shapes from the Material 3 Design Kit community library.

## Worth knowing

- Function history in the graph is a best guess. It comes from Git's diffs and a line-based detector, so unusual formatting can put a change under the wrong function or miss it. The Function picker lists the functions Tree-sitter finds in the file at HEAD (or the line-based detector, when Tree-sitter can't parse it), followed by names from the history that are no longer in the file.
- Only the newest 500 commits are loaded, so a file or function whose changes are all older shows "No loaded commit touches this file" (or "this function"), with a button to go back to the whole project.
- A file or function rebase won't run if that file has uncommitted changes, so it can't eat your work. A branch rebase is a real `git rebase`; if it stops on a conflict, the commit panel offers to abort it.
- View blast radius commits everything in your working tree before you decide whether to push. The branch dropdown switches branches the moment you pick one.
- The editor and terminal work on your actual checkout. They aren't sandboxed.
- The app only talks to an Ollama server on loopback unless you set `OLLAMA_ALLOW_REMOTE=true` and point `OLLAMA_BASE_URL` at another host. Your code stays on your machine unless you push it or post review comments to GitHub. The PR review watcher can post findings without asking, but only if you turn on that option.
- Release builds on Windows are served from `http://tauri.localhost`, which Ollama's default CORS policy rejects. That's another reason model calls go through Rust and not the webview.
