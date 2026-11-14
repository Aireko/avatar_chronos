# PR Bug Check

PR Bug Check reviews GitHub pull requests for real bugs with a local Qwen 3.5 model. It reads the diff of a PR, asks the model to look only for bugs (not style), shows each finding with an explanation and, where the model is sure enough, a suggested fix. You can then post the findings you pick as inline review comments on the PR.

It runs in two ways:

- **Manually:** click **Run bug check** next to a PR.
- **Automatically (opt-in):** a watcher polls the repository while the app is running and checks open PRs that have no up-to-date check. On the first poll that is every open PR not checked yet (up to 50); after that, only PRs that are opened or get new commits.

- [What it looks for](#what-it-looks-for)
- [Requirements](#requirements)
- [Run a check manually](#run-a-check-manually)
- [Post findings to GitHub](#post-findings-to-github)
- [Auto review](#auto-review)
- [What is sent where](#what-is-sent-where)
- [Settings](#settings)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [Reuse it in code](#reuse-it-in-code)

## How it fits together

```text
React panel (src/bugcheck/BugCheckPanel.tsx)
   |  bugCheckService.ts: invoke() + Channel, listen('pr-bug-check://event')
   v
Tauri commands (src-tauri/src/review/commands.rs)
   |
BugCheckEngine (src-tauri/src/review/engine.rs)  ----  watcher.rs (auto review, one PR at a time)
   |                 |                 |
   |  gh CLI         |  diff.rs        |  AiService (src-tauri/src/ai/)
   v                 v                 v
GitHub (github.rs)   chunks of the     Ollama on 127.0.0.1  -->  qwen3.5 model
                     annotated diff
Reports and settings: <app data>/pr-bug-check/ (store.rs)
```

A check goes through these steps:

1. Fetch the PR (title, head commit) and its changed files with their patches through the `gh` CLI.
2. Skip files that are not worth reviewing (lock files, minified, generated, vendored, images, files without a patch) and split the rest into chunks of about 24 KiB of annotated diff (less when the context window is small, see [Settings](#settings)).
3. Send each chunk to the local model with a strict JSON schema for the answer.
4. Check every finding against the diff the model was shown: its file must be in the chunk and its line must be a line GitHub can comment on (an added or context line on the new side) that this chunk actually showed (not a hunk of another chunk, and not a line cut off by a truncation). A line that is slightly off is moved to the nearest such line within 3 lines; otherwise the finding is kept but marked **not inline-postable**. Low-confidence findings and duplicates are dropped.
5. Save the report, so it is still there after a restart. If no part of the PR got a usable answer from the model, nothing is saved and the check fails, so an empty report never reads as "no bugs".

## What it looks for

The model is told to report only real bugs, few and with high confidence, and to ignore style, naming, formatting and nitpicks. Every finding must name a line of the new code and quote the evidence.

| Category | Examples |
| --- | --- |
| Logic bug | Wrong condition, inverted check, off-by-one, wrong variable, unreachable branch |
| State leak | Files, handles, sockets, listeners or timers not released; memory not freed; stale state kept between uses |
| Unit mismatch | Milliseconds vs seconds, bytes vs KiB, degrees vs radians, a value in one unit passed where another is expected |
| Security | Injection (SQL, shell, path), missing validation of untrusted input, secrets in code, unsafe deserialization |
| Concurrency | Data races, missing locks, lock ordering, await while holding a lock, check-then-act races |
| Error handling | Ignored errors, swallowed exceptions, `unwrap` on input that can fail, wrong error propagated |
| Performance | Only clear problems, such as an accidental quadratic loop over large input |
| Other | A real bug that fits none of the above |

Each finding has a severity (critical, high, medium, low), a title, an explanation, a confidence from 0 to 1, and optionally a suggested fix that replaces the lines it points at.

## Requirements

1. **Ollama with a Qwen 3.5 model.** Follow [docs/ollama.md](ollama.md): install Ollama, run `ollama pull qwen3.5:9b` (or another Qwen 3.5 tag that fits your machine), and check that the **Local AI test panel** says Connected. PR Bug Check uses the selected model of the AI service.
2. **The GitHub CLI, logged in.** Install `gh` from <https://cli.github.com>, then log in:

   ```bash
   gh auth login
   ```

   Pick GitHub.com and HTTPS, and accept the default scopes (they include `repo`, which reading private repositories and posting review comments need). Check it with `gh auth status`. The app uses whatever account `gh` is logged in as, so comments are posted under your name. It never asks for or stores a token itself.
3. **Enough time per model call.** Each part of a PR is one model request. A review call may take `max(OLLAMA_TIMEOUT, 10 minutes)`, so the 2-minute `OLLAMA_TIMEOUT` default that suits chat does not cut reviews short. On the CPU or a GPU that holds only part of the model, raise it before starting the app, for example to 30 minutes:

   ```powershell
   $env:OLLAMA_TIMEOUT = "1800000"
   ```

   ```bash
   export OLLAMA_TIMEOUT=1800000
   ```

## Run a check manually

1. Start the app with `npm run tauri:dev`. The **PR Bug Check** panel is below the Local AI test panel.
2. The first line shows whether `gh` is installed and signed in, with a hint when it is not.
3. Enter the repository as `owner/name` (default `Aireko/avatar`) and click **Load open PRs**. The app remembers the repository.
4. Each open PR shows its number, title, author, a draft badge, `+additions -deletions`, and its last check: never checked, up to date with N findings, or outdated (the PR got new commits since).
5. Click **Run bug check**. The progress area shows which chunk of how many is being reviewed, which files are in it, and how many findings there are so far. **Cancel** stops the run, including the model request in progress.
6. When it finishes, the findings appear grouped by file, with a severity badge, category, title, line, confidence, explanation and suggested fix.

To check a closed or merged PR, or one that is not in the first 50 open PRs, type its number under **Check another PR #**. **View report** opens the last stored report of a PR.

### Double-check

A small local model reports many false alarms. So by default every finding is checked a second time before it is shown: a separate model call gets the bug report and the diff of its file, is told to assume the report is wrong until the code proves it, traces the cited code with concrete values, and answers `confirmed`, `refuted` or `uncertain` with a short reason.

- **Confirmed** findings are shown and can be posted. The card shows **double-checked** and the reason (the input or state that triggers the bug).
- **Refuted** and **uncertain** findings are filtered out. They are listed, with the reason, under **N findings filtered out by the double-check**, and are never posted. Auto review and auto-post use the same filter.
- If the double-check itself fails (the model's answer is not usable, or the call fails), the finding is kept and marked **not double-checked**, so a failure never hides a finding.

It costs one extra model call per finding (much shorter than a review call: about 1.5K output tokens). Turn it off with **Double-check each finding** under Check options, or `verify: false` in code. The double-check reduces false alarms but cannot remove them all, and it can occasionally filter a real bug.

**Check options** change how the model is used: **Double-check each finding** (above, on by default), **Think first** lets Qwen 3.5 reason before it answers (slower, sometimes more accurate; its reasoning uses up output tokens, so it reserves 8192 of them and leaves less room for the diff), **Context window** sets `numCtx` (default 16K tokens; more needs more memory, less splits the PR into more, smaller parts), and **Minimum confidence** drops findings below a threshold (default 50%).

## Post findings to GitHub

Nothing is posted unless you ask for it.

1. Every inline-postable finding that was not posted yet is selected by default. Untick the ones you do not want. Findings marked **not inline-postable** point at a line outside the diff, so GitHub cannot take an inline comment there; they stay visible in the app only. Findings marked **posted** or **posted on an earlier commit** (same file and title as a finding posted for an earlier check of the PR) cannot be selected: the app never posts a finding twice.
2. Click **Post N comments to GitHub**. A confirmation names the repository, PR number and comment count, which is exactly the number of comments GitHub gets. Click **Post N comments** to send.
3. The app posts one review (event `COMMENT`, so it neither approves nor requests changes) with one inline comment per finding, and shows a link to it.

Before posting, the app fetches the PR again. If its head commit changed since the check, posting is refused with `stale_report`, because line numbers may no longer match: run the check again, then post. While a check of the same PR is running (manually or by auto review), posting is refused with `busy`, and a check cannot start while its PR is being posted, so a post never overwrites a newer report.

A new check of the same head commit keeps the record of what was posted. A check of a new commit starts a new record but remembers what was posted on the PR before, so the same bug is not posted again after a push, even if it moved to another line.

Each comment looks like this:

```text
**High · Unit mismatch** — Timeout passed in seconds where milliseconds are expected

<explanation>

<suggested fix>

<sub>Generated locally by Qwen 3.5 through Ollama. Check before applying.</sub>
```

How the suggested fix is posted:

- When the fix replaces a validated contiguous range of new-side lines inside one hunk (`startLine..line`), or is a single line that replaces `line`, it is posted as a GitHub **suggestion** block, so the PR author can apply it with one click.
- Otherwise it is posted as a plain code block labelled **Possible fix**: when the line was moved to the nearest commentable line, when the model gave a range that is not valid (start after the line, in another hunk, or not shown), or when a multi-line fix has no range (as a suggestion it would replace one line with several).
- Backticks inside a fix cannot break the block: the app uses a longer fence than any run of backticks in the fix.

The title and explanation are written by the model, which reads text from the PR author, so they are neutralised before posting: lines that would open or close a code block are escaped (an explanation cannot add its own suggestion block or swallow the real one), `@mentions` and `#123` references get a zero-width space so nobody is notified, links, images, `http://` autolinks and raw HTML are shown as plain text. Inline `code` stays as it is, and the fix itself is posted unchanged.

A review holds at most 50 comments.

## Auto review

The **Auto review** section watches one repository:

- **Enabled** starts or stops the watcher. The setting is saved, and the watcher resumes when the app starts again.
- **Check every N minutes** (1 to 120, default 5) sets how often it lists the open PRs.
- **Include drafts** also checks draft PRs (off by default).
- **Post findings automatically** posts the postable findings of each check without asking (off by default). A warning reminds you that comments then go to GitHub without your review, also on existing open PRs that have no check yet. A finding already posted on the PR (same file and title, also for an earlier commit) is not posted again, so a PR does not collect the same comment after every push. Turning auto review off, or applying new settings, also stops a post that has not been sent yet.
- **Context window** and **Minimum confidence** from Check options are used by auto review too. Changing them while auto review runs shows **Settings changed**; press **Apply** to restart the watcher with them.

How "new or updated" is detected: on every poll the watcher compares each open PR's head commit with the head commit of its stored report. A PR without a report, or whose head commit differs, is queued. So enabling auto review first works through every open PR that has no check yet (up to 50), one by one, which can take a long time on a small GPU; after that, only PRs that are opened or get new commits are queued. PRs are checked one at a time, and a PR whose report is up to date is not checked again. A check that failed, or that you cancelled, saves nothing and is retried on the next poll; a check where no part got a usable answer counts as failed. The panel shows the last poll time, the queue, the PR being checked with its progress, recent activity and the last error.

Auto review only runs while the app is open. It is not a GitHub App or a server, so nothing is checked while the app is closed. When polling fails (for example offline, or `gh` logged out), the watcher reports the error and waits longer before the next try (doubling up to 30 minutes), then returns to the normal interval once polling works again.

## What is sent where

| Data | Goes to |
| --- | --- |
| PR metadata, changed files and patches | Fetched from GitHub by the `gh` CLI on this machine |
| PR title, up to the first 2 KiB of the PR description, and the diff | The local AI service, which only talks to Ollama on loopback (see [docs/ollama.md](ollama.md#security-and-privacy)). Cloud models are rejected |
| Findings and reports | Saved as JSON under the app data directory, in `pr-bug-check/` |
| Comments you post (or that auto-post posts) | GitHub, as a review on the PR, through `gh` |

Nothing else leaves the machine. There is no cloud AI, the app does not log PR code, prompts or model output (at most a one-line diagnostic with ids, counts and durations), and error messages never include code.

PR content is untrusted. The prompt contains the PR title, an excerpt of up to 2 KiB of the PR description, and the diff. The prompt marks all of this as data and tells the model to ignore any instructions inside it, and the chunk size is capped so this framing always fits the context window (Ollama would otherwise silently drop the start of the prompt). A PR can still try to steer the model, which is one more reason to read findings before posting them; posted text is neutralised so it cannot mention people, link or embed content (see [Post findings to GitHub](#post-findings-to-github)).

## Settings

| Setting | Where | Default |
| --- | --- | --- |
| Repository | Panel; remembered in the webview's local storage | `Aireko/avatar` |
| Double-check each finding (`verify`) | Check options; auto review always double-checks | on |
| Think first | Check options | off |
| Context window (`numCtx`, at least 8192 in practice) | Check options; also used by auto review (applied when auto review is turned on or **Apply** is pressed) | 16384 tokens |
| Minimum confidence | Check options; also used by auto review (same) | 0.5 |
| Chunk size (`chunkBytes`, 4096 to 196608) | `bugCheckService.run(..., { options: { chunkBytes } })` | 24576 bytes |
| Auto review interval, drafts, auto-post | Auto review section; saved in `pr-bug-check/settings.json` | 5 minutes, off, off |
| Model | The AI service's selected model (`OLLAMA_MODEL`, see [docs/ollama.md](ollama.md#4-configure-the-app)) | `qwen3.5:9b` |
| Time per model call | `max(OLLAMA_TIMEOUT, 10 minutes)` | 10 minutes |

The chunk size is capped by the context window: `numCtx` minus the answer budget (4096 tokens, or 8192 with Think first, at most half the window) minus about 2.2K tokens for the system prompt, title and description, at about 3 bytes per token. At the 16K default that leaves the full 24 KiB; with Think first about 17 KB; at 8K about 5 KB, so a small window splits a PR into more, smaller parts (more model calls). A context window too small for a 4096-byte part (4096 tokens) is rejected with `invalid_request`. When a requested `chunkBytes` is lowered, the report says so in its notes.

Reports are stored per PR as `<app data>/pr-bug-check/<owner>__<repo>/pr-<number>.json`. Only the latest report of each PR is kept. The app data directory is `%APPDATA%\<app identifier>` on Windows, `~/Library/Application Support/<app identifier>` on macOS and `~/.local/share/<app identifier>` on Linux.

## Limitations

- **Diff only.** The model sees the changed hunks with a few lines of context, not the whole file or the rest of the repository. Bugs that depend on code outside the diff can be missed, and some findings may be wrong because of missing context.
- **Chunking.** Large PRs are split into chunks that are reviewed separately, so a bug that spans two files in different chunks can be missed. A hunk larger than one chunk is truncated, with a note in the report. A run makes at most 40 model calls, so a very large PR is only partly reviewed; the report says which files were left out.
- **Skipped files.** Lock files (`package-lock.json`, `Cargo.lock`, `yarn.lock`, `go.sum`, ...), minified files and source maps (`*.min.js`, `*.map`), vendored or build output (`node_modules/`, `vendor/`, `dist/`, `build/`, `target/`, `third_party/`), generated files (`*.generated.*`, `*.pb.go`, `src-tauri/gen/`), images and binary files (`*.png`, `*.svg`, `*.woff2`, `*.dll`, ...), deleted files, and files GitHub returns no patch for (binary files, very large diffs) are not reviewed. The report lists them with the reason. The full list is `skip_reason` in `src-tauri/src/review/diff.rs`.
- **The model can be wrong.** It can miss bugs and report false ones. The [double-check](#double-check) filters out most false alarms, but not all, and it can occasionally filter a real bug (see the filtered list). Read every finding before posting it, and check suggested fixes before applying them.
- **Speed.** Each chunk is one model request, which may take up to `max(OLLAMA_TIMEOUT, 10 minutes)`. On a small GPU or on the CPU, a large PR can take many minutes. Think first makes it slower still. If the first part times out, or two parts in a row do, the check stops with a `timeout` error instead of waiting through every part: raise `OLLAMA_TIMEOUT`, use a smaller context window or model (`qwen3.5:4b` on GPUs with 4 to 6 GB of VRAM).
- **Output limit.** An answer is at most 4096 tokens (8192 with Think first, which also counts its reasoning). The model is asked for at most 10 findings with short explanations. An answer cut off at the limit keeps its complete findings and the report notes that some were lost.
- **Line numbers** are new-side lines of the diff. A bug caused by a removed line (for example a missing `close()`) is reported on the nearest added or context line where the code should be.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `gh_not_installed` | Install the GitHub CLI from <https://cli.github.com>, open a new terminal so `PATH` is updated, then restart the app |
| `gh_not_authenticated` | Run `gh auth login`, then click **Check again** |
| `not_found` | Check the repository name (`owner/name`) and the PR number, and that your `gh` account can see the repository (`gh repo view owner/name`) |
| `github_failed` | Read the message: it carries the first line of `gh`'s error, for example a rate limit or a missing scope. For posting, `gh auth refresh -s repo` adds the `repo` scope |
| `ai_failed` | The local AI failed. The message and hint come from the AI service, and the error shows the AI kind, for example `ollama_unreachable` (start Ollama) or `model_not_installed` (`ollama pull qwen3.5:9b`). See [docs/ollama.md](ollama.md#error-kinds) |
| `busy` | A check of the same PR is already running (perhaps by auto review), or its findings are being posted. Wait or cancel it |
| `ai_failed` with `timeout`, or "Part N failed: ... did not respond within" in the notes | The model took longer than a review call may take. Raise `OLLAMA_TIMEOUT` (milliseconds, e.g. `1800000`, see [Requirements](#requirements)), use a smaller context window, or use `qwen3.5:4b` on GPUs with 4 to 6 GB of VRAM |
| `stale_report` | The PR got new commits after the check. Run the check again, then post |
| `invalid_request` | A field is invalid, such as a repository that is not `owner/name` or a PR number out of range |
| A chunk shows in the notes as unparseable | The model returned something that was not the expected JSON. The other chunks still count. Run again, or try a larger model |
| A chunk "hit the output limit" | The answer was cut off at the token limit, so some findings were lost. Turn Think first off (its reasoning uses up output tokens and needs a larger context window, so it does not help here), or use a smaller chunk size |
| `ai_failed`: "No part of the PR got a usable answer" | Every part was unparseable, cut off or failed, so nothing was saved (auto review retries it on the next poll). Run again, turn Think first off, or use a smaller chunk size |
| `ai_failed` with `insufficient_resources` and "llama-server process has terminated ... CUDA error" | Ollama's model runner crashed while loading the model. On small GPUs (seen on a 4 GB laptop GPU) this is often transient: the check retries that part once on its own, and running it again usually works once the model has loaded. If it keeps happening, close other GPU-heavy apps, choose a smaller context window, or use `qwen3.5:4b` |
| The check takes very long | Use a smaller PR, a smaller model, or a GPU. Raise `OLLAMA_TIMEOUT` if parts time out. See [Hardware and memory](ollama.md#hardware-and-memory) |
| "PR Bug Check is only available inside the desktop app" | You opened the Vite page in a browser. Use `npm run tauri:dev` |

## Tests

```bash
npm test
```

The PR Bug Check tests live in `src-tauri/src/review/`. They are mocked: a fake `gh` runner returns recorded outputs and records every call (so tests can check the exact JSON a post would send, and nothing reaches GitHub), and the mocked Ollama server from the AI tests returns model answers. They need neither `gh`, network access, Ollama nor a model. They cover diff parsing and chunking (including which lines each chunk shows), finding validation, JSON extraction from noisy and cut-off model output, context-window budgets, a full run with its events, the double-check (confirmed, refuted, uncertain, failed, turned off, cancelled mid-check), cancellation, retry after a model-runner crash, timeouts, the post payload and comment neutralisation, posting history across commits, runs and posts excluding each other, error mapping, the report store, and the watcher (decision logic, a cancelled review, stopping a pending auto-post).

To run only them:

```bash
cargo test --manifest-path src-tauri/Cargo.toml review::
```

A real, read-only test runs the whole check against a real PR with your `gh` login and your local Ollama, and prints a summary. It is ignored by default, only runs when `PR_BUG_CHECK_REAL=1` is set, and never posts anything. `PR_BUG_CHECK_REPO` (default `Aireko/avatar`) and `PR_BUG_CHECK_PR` (default `1`) choose the PR.

bash:

```bash
PR_BUG_CHECK_REAL=1 PR_BUG_CHECK_REPO=Aireko/avatar PR_BUG_CHECK_PR=1 \
  cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_pr_bug_check_readonly --nocapture
```

PowerShell:

```powershell
$env:PR_BUG_CHECK_REAL = "1"; $env:PR_BUG_CHECK_REPO = "Aireko/avatar"; $env:PR_BUG_CHECK_PR = "1"
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_pr_bug_check_readonly --nocapture
```

It needs a logged-in `gh` and an installed Qwen 3.5 model, and can take several minutes on a large PR.

## Reuse it in code

### From TypeScript

`src/bugcheck/bugCheckService.ts` is the only frontend entry point, and `src/bugcheck/types.ts` mirrors every shape. Every method rejects with a `BugCheckError` (`{ kind, message, hint?, aiKind? }`); `bugCheckErrorMessage(error)` turns one into a readable line.

```ts
import { bugCheckErrorMessage, bugCheckService } from "./bugcheck/bugCheckService";

const controller = new AbortController();
cancelButton.onclick = () => controller.abort(); // cancels the run, also before it has an id

try {
  const report = await bugCheckService.run("Aireko/avatar", 12, {
    options: { numCtx: 16384, minConfidence: 0.6 },
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "chunkStarted") showProgress(event.index + 1, event.files);
      if (event.type === "finding") addFinding(event.finding);
    },
  });
  console.log(report.findings.length, report.filesSkipped);

  // Only after the user confirmed:
  const ids = report.findings.filter((f) => f.postable).map((f) => f.id);
  const posted = await bugCheckService.post(report.repo, report.number, ids);
  console.log(posted.reviewUrl);
} catch (error) {
  showError(bugCheckErrorMessage(error)); // e.g. "... Start Ollama ..." for ai_failed
}
```

Other calls: `ghStatus()`, `listPrs(repo)`, `getReport(repo, number)`, `cancel(runId)`, `watchGet()`, `watchStart(config)`, `watchStop()`, and `onWatcherEvent(handler)`, which subscribes to the app-wide `pr-bug-check://event` and returns an unlisten function (call it when your component unmounts).

### From Rust

`BugCheckEngine` in `src-tauri/src/review/engine.rs` does a whole check and can be used without the commands, for example by another feature that wants bug findings for a PR. It takes the shared `AiService`, a `GhRunner` (the real `gh`, or a fake in tests) and a `ReportStore`. `src-tauri/src/review/mod.rs` documents its API and how to construct it. Two rules apply to any code that reuses it: send PR code only to the local `AiService`, and never log PR code, prompts or model output.
