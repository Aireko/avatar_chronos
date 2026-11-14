# Local AI with Ollama and Qwen 3.5

Avatar runs its AI features on your own machine. [Ollama](https://ollama.com) serves the model and Qwen 3.5 is the model family. This guide covers installing both, configuring the app, testing the integration, and calling it from TypeScript or Rust.

- [Why Ollama](#why-ollama)
- [1. Install Ollama](#1-install-ollama)
- [2. Choose and download a Qwen 3.5 model](#2-choose-and-download-a-qwen-35-model)
- [3. Start and verify Ollama](#3-start-and-verify-ollama)
- [4. Configure the app](#4-configure-the-app)
- [5. Run the app and the test panel](#5-run-the-app-and-the-test-panel)
- [6. Run the tests](#6-run-the-tests)
- [7. Use the AI service in code](#7-use-the-ai-service-in-code)
- [Error kinds](#error-kinds)
- [Security and privacy](#security-and-privacy)
- [Hardware and memory](#hardware-and-memory)
- [Troubleshooting](#troubleshooting)

## Why Ollama

- **Local.** The model runs on this machine. By default the app only connects to an Ollama server on the loopback interface (`127.0.0.1`, `localhost` or `::1`).
- **Private.** By default (loopback only), prompts, source code and answers never leave the machine. The app does not log them.
- **Free.** You need no account, API key or subscription.
- **Simple.** Ollama downloads, stores and runs models, and exposes them through a small HTTP API on port 11434.

## How it fits together

```text
React (src/ai/aiService.ts)  --invoke() / Channel-->  Tauri commands (src-tauri/src/ai/commands.rs)
                                                            |
                                                      AiService (src-tauri/src/ai/service.rs)
                                                            |  HTTP, NDJSON streaming (reqwest)
                                                            v
                                                      Ollama  http://127.0.0.1:11434  -->  qwen3.5 model
```

The webview never talks to Ollama directly. Every Ollama request is made from Rust. This keeps CORS out of the picture: release builds on Windows are served from `http://tauri.localhost`, which Ollama's default CORS policy rejects. It also lets Rust enforce the local-only rule, the Qwen-3.5-only rule, input limits and cancellation in one place.

## 1. Install Ollama

You need Ollama **0.17.5 or newer**, the first release that runs the Qwen 3.5 models. Later releases fixed Qwen 3.5 bugs (tool calls inside thinking text in 0.19.0, long-context scaling in 0.40.15), so install the latest version.

**Windows**

- Download and run the installer from <https://ollama.com/download>, or
- use winget:

  ```powershell
  winget install Ollama.Ollama
  ```

The installer adds `ollama` to your `PATH` (under `%LOCALAPPDATA%\Programs\Ollama`) and starts Ollama in the system tray. Open a new terminal afterwards so the updated `PATH` is picked up.

**macOS**

- Download the app from <https://ollama.com/download>, move it to Applications and open it once (it adds the `ollama` command), or
- use Homebrew:

  ```bash
  brew install ollama
  ```

  The Homebrew formula does not start a server for you. Run `ollama serve` in a terminal, or `brew services start ollama` to run it in the background.

**Linux**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

The script installs `ollama` and, on systemd distributions, an `ollama` service that starts automatically. Check it with `systemctl status ollama`.

## 2. Choose and download a Qwen 3.5 model

The default model is **`qwen3.5:9b`** (9B parameters, usually the Q4_K_M build, about 6.6-7.6 GB download depending on platform). It is a good balance of quality and speed on a typical developer machine: it fits an 8 GB GPU at moderate context lengths, or runs on CPU on a machine with 16 GB of RAM. To use a different tag, set `OLLAMA_MODEL` (see [Configure the app](#4-configure-the-app)).

Download it:

```bash
ollama pull qwen3.5:9b
```

Alternatively, start the app and click **Download** in the AI test panel. The app never downloads a model on its own; a download always starts from an explicit click.

### Which variant to pick

All Qwen 3.5 tags have a 256K-token context window, accept text and images, and support tools and thinking. Download sizes are taken from the [Ollama library](https://ollama.com/library/qwen3.5/tags). Memory figures are rough estimates for an 8K-32K context: the weights plus KV cache plus runtime overhead.

| Tag | Download | Approx. memory | Good for |
| --- | --- | --- | --- |
| `qwen3.5:0.8b` | 1.2-1.3 GB | 1.5-2.5 GB | Smoke tests, very weak machines. Low quality |
| `qwen3.5:2b` | 2.7-3.1 GB | 2.5-4 GB | Machines with 8 GB RAM and no GPU |
| `qwen3.5:4b` | 3.3-4.0 GB | 4-5.5 GB | **Low-memory choice:** 12 GB RAM, or a GPU with 4-6 GB VRAM |
| `qwen3.5:9b` | 6.6-7.6 GB | 7.5-9.5 GB | Default (see above). 16 GB RAM, or a GPU with 8 GB VRAM or more |
| `qwen3.5:27b` | 17-20 GB | 19-23 GB | 24 GB+ GPU, or 40 GB+ RAM (slow on CPU) |
| `qwen3.5:35b` (= `35b-a3b`, MoE) | 22 GB | 24-27 GB | Fast for its size (about 3B active parameters), but all weights must fit |
| `qwen3.5:122b` | 81 GB | more than 85 GB | Workstations only |

Pinned quantizations exist too, for example `qwen3.5:4b-q4_K_M` (3.3 GB), `qwen3.5:9b-q4_K_M` (6.6 GB) and `qwen3.5:9b-q8_0` (10 GB, higher quality, about 11-13 GB memory). The bare `qwen3.5:9b` tag can resolve to a platform-specific build, which is why its listed size is a range. If you need byte-for-byte reproducibility across machines, pin `qwen3.5:9b-q4_K_M`.

Avoid these as a general default:

- `-mlx`, `-mxfp8`, `-nvfp4` and `-bf16` builds. The MLX builds target Apple Silicon, and bf16 builds are 2-3 times larger.
- Any **cloud** tag (a tag ending in `cloud`, such as `qwen3.5:cloud`), or a local copy or alias of one. Cloud models run on ollama.com servers, not locally, so the app rejects them everywhere.
- Models from another namespace or registry (`someuser/qwen3.5:9b`, `example.com/x/qwen3.5:9b`). The app only accepts the official `qwen3.5` library model.

How to pick:

1. If you have a dedicated GPU, choose the largest model whose memory figure starts (its low end) within your VRAM. Near the high end, use a shorter context (`numCtx`) or let Ollama split the model between GPU and CPU, which works but makes the CPU part much slower.
2. Without a GPU, choose the largest model whose memory figure (its high end) is at most about 60% of your RAM, so the OS, the IDE and the app still have room.
3. If answers are too slow, step down one size. If they are too weak, step up one.

## 3. Start and verify Ollama

Ollama has to be running for the app to work.

- **Windows and macOS app:** open the Ollama app; it stays in the tray or menu bar.
- **Linux:** the `ollama` systemd service starts automatically.
- **Anywhere:** run `ollama serve` in a terminal and leave it open.

Verify each step:

```bash
ollama --version                               # Ollama is installed and on PATH
ollama list                                    # the server is running; your model is listed
curl http://127.0.0.1:11434/api/version        # the HTTP API answers, e.g. {"version":"0.40.16"}
ollama run qwen3.5:9b "hello"                  # the model loads and answers
```

On Windows PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe http://127.0.0.1:11434/api/version` or `Invoke-RestMethod http://127.0.0.1:11434/api/version` instead.

The first `ollama run` after a restart can take a minute or more while the model loads into memory. Later requests are fast until Ollama unloads the model after 5 idle minutes.

## 4. Configure the app

The app reads these environment variables once, at startup. Restart the app after changing them. An empty value counts as unset. An invalid value does not crash the app: every AI call then fails with an `invalid_config` error that names the variable, the bad value and what is expected, and the test panel shows it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Where the app finds Ollama. Must be a plain `http://` origin with no path, query or user info (a trailing `/` is fine). `https://` is rejected, because the app is built without TLS. The host must be loopback (`localhost`, `127.x.x.x`, `::1`) unless `OLLAMA_ALLOW_REMOTE` is set |
| `OLLAMA_MODEL` | The default model ([section 2](#2-choose-and-download-a-qwen-35-model)) | The model used when a request names none. Must be a Qwen 3.5 tag (`qwen3.5:<tag>`) and not a cloud tag. If Ollama lists it as a cloud model (an alias), generation with it is refused and the panel shows why |
| `OLLAMA_TIMEOUT` | `120000` | Milliseconds, 1000-3600000. For generation: the maximum wait for a non-streamed answer; for streamed answers, the maximum wait for the first chunk (which covers model loading) and the maximum gap between chunks. Metadata calls and connecting are capped at `min(5 s, OLLAMA_TIMEOUT)`, and a download only times out after `max(OLLAMA_TIMEOUT, 300 s)` without progress |
| `OLLAMA_MAX_PROMPT_BYTES` | `262144` (256 KiB) | Limit on the system prompt plus prompt per request, in UTF-8 bytes, 1024-8388608 |
| `OLLAMA_ALLOW_REMOTE` | `false` | `true` or `1` allows a non-loopback `OLLAMA_BASE_URL`. Prompts and code then leave this machine over plain, unencrypted http, so only use it for a server you control on a trusted network, or through an SSH tunnel (then the URL is loopback again). The panel shows a warning instead of the privacy note |

Do not confuse the app's variables with Ollama's own server variables:

- `OLLAMA_MODEL` (this app) picks **which model the app uses**. `OLLAMA_MODELS` (Ollama, with an **S**) sets **the directory where Ollama stores model files**. Set it for the Ollama server if your system drive is short on space (see [Disk](#hardware-and-memory) for where the server reads it).
- `OLLAMA_HOST` (Ollama) sets **the address the Ollama server binds to**. The app does not read it. If you move the server to another port, set `OLLAMA_BASE_URL` for the app to match.

PowerShell (applies to this terminal session):

```powershell
$env:OLLAMA_MODEL = "qwen3.5:4b"
$env:OLLAMA_TIMEOUT = "300000"
npm run tauri:dev
```

bash or zsh:

```bash
OLLAMA_MODEL=qwen3.5:4b OLLAMA_TIMEOUT=300000 npm run tauri:dev
```

You can also switch between installed Qwen 3.5 models at runtime with the panel's **Select** button (`aiService.selectModel`). That choice lives in memory only. After a restart the app uses `OLLAMA_MODEL` again.

## 5. Run the app and the test panel

```bash
npm install
npm run tauri:dev
```

The **Local AI test panel** below the demo content exercises the whole integration:

- **Connection:** whether Ollama is reachable, its version and base URL, and a hint when something is wrong.
- **Privacy note:** says that prompts stay on this machine when `OLLAMA_BASE_URL` is loopback, or warns that they go unencrypted to a remote server.
- **Model:** the configured and the selected model, a list of installed Qwen 3.5 models with a **Select** button, and, when the selected model is missing, a **Download qwen3.5:… (~size)** button with a progress bar, **Cancel** and **Retry download**.
- **Test prompt:** an optional system prompt, a **Think** toggle, **Generate** (streaming) and **Stop**. The answer streams in as it is generated. The model's reasoning is shown separately in a collapsed section, and a stats line shows tokens, tokens per second, load time and why generation stopped.

`npm run dev` (Vite only, in a browser) renders the panel, but every AI call fails with "Local AI is only available inside the desktop app", because Tauri commands only exist inside the app.

## 6. Run the tests

```bash
npm test
```

`npm test` runs `cargo test`. The AI tests in `src-tauri/src/ai/` run against a **mocked Ollama**: a small HTTP server inside the test process that replays recorded Ollama responses, including streams split across network chunks, mid-stream errors, slow chunks for timeout tests, and cancellation. They need neither Ollama nor a model, and run offline.

A real smoke test checks the integration against your installed Ollama and model. It is ignored by default and only runs when `OLLAMA_SMOKE_TEST=1` is set. It uses the configured model (`OLLAMA_MODEL`, or the default), sends a tiny prompt with thinking off and a small token limit, and also exercises streaming and cancellation. It never downloads a model, so pull the model first.

bash:

```bash
OLLAMA_SMOKE_TEST=1 cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_ollama
```

PowerShell:

```powershell
$env:OLLAMA_SMOKE_TEST = "1"; cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_ollama
```

The first run can take a minute or two while the model loads.

## 7. Use the AI service in code

### From TypeScript

`src/ai/aiService.ts` is the only frontend entry point. Its types are in `src/ai/types.ts`. Do not call Ollama with `fetch()` from the frontend. Every method rejects with an `AiError` (`{ kind, message, hint?, status? }`), and `aiErrorMessage(error)` turns one into a readable line.

One-shot answer:

```ts
import { aiErrorMessage, aiService, isAiError } from "./ai/aiService";

try {
  const response = await aiService.generate({
    system: "You are a concise code reviewer.",
    prompt: `Review this function:\n\n${code}`,
    think: false,
    options: { temperature: 0.2, numCtx: 16384 },
  });
  console.log(response.content, response.stats.tokensPerSecond);
} catch (error) {
  showError(aiErrorMessage(error)); // message plus an actionable hint
}
```

Streaming with a Stop button:

```ts
const controller = new AbortController();
stopButton.onclick = () => controller.abort();

try {
  const response = await aiService.generateStream(
    { prompt: "Explain this diff", think: false },
    {
      signal: controller.signal, // abort() cancels generation in Ollama
      onDelta: (content, thinking) => {
        if (content) appendAnswer(content);
        if (thinking) appendReasoning(thinking);
      },
    },
  );
  console.log(response.doneReason); // "stop", or "length" if numPredict / the context was hit
} catch (error) {
  if (isAiError(error) && error.kind === "cancelled") return; // the user pressed Stop
  throw error;
}
```

`generateStream`, `pullModel` and `generate` with a `signal` create a request id with `crypto.randomUUID()` when you do not pass one. If you set `requestId` yourself, you can also cancel with `aiService.cancelGeneration(requestId)`. A cancel that arrives just before its request starts still cancels it, and an aborted call always rejects with `cancelled`.

Structured JSON output: pass `format` as `"json"` or a JSON Schema object, turn thinking off, and parse `content` yourself. Ollama's docs also recommend describing the schema in the prompt and using temperature 0.

```ts
const schema = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
  },
  required: ["severity", "summary"],
};

const response = await aiService.generate({
  prompt: `Rate this change and answer as JSON with "severity" and "summary":\n\n${diff}`,
  format: schema,
  think: false,
  options: { temperature: 0 },
});
const review = JSON.parse(response.content) as { severity: string; summary: string };
```

Other calls: `status()` (everything the UI needs in one call), `checkConnection()`, `listModels()`, `getModelInfo(model?)`, `selectModel(tag)` and `pullModel(tag, { onProgress, signal })`. Only call `pullModel` from an explicit user action, because downloads are several GB.

Notes for Qwen 3.5:

- **Thinking is on by default** when `think` is omitted. The model then reasons first, and those tokens arrive in `thinking`, not `content`. They also count toward `numPredict`, so a small `numPredict` with thinking on can stop (`doneReason: "length"`) before any answer appears. Pass `think: false` unless you want the reasoning.
- **Set `numCtx` for large inputs.** Without it, Ollama picks a context size based on available VRAM (it can be as small as 4096 tokens), and longer prompts are truncated. Changing `numCtx` reloads the model, so keep it consistent across a feature.
- **No model fallback.** If the requested model is not installed, the call fails with `model_not_installed`. The service never substitutes another model.

### From Rust

Other Rust features (parser, indexer, reviewer) use the same `AiService` that backs the commands. It is registered as managed Tauri state, and `src-tauri/src/ai/mod.rs` documents its API.

```rust
use tauri::Manager;
use crate::ai::{AiService, GenerateRequest};

async fn summarize(app: &tauri::AppHandle, text: String) -> Result<String, crate::ai::AiError> {
    let ai = app.state::<AiService>();
    let response = ai
        .generate(GenerateRequest {
            prompt: format!("Summarize:\n\n{text}"),
            think: Some(false),
            ..Default::default()
        })
        .await?;
    Ok(response.content)
}
```

In a command, take it as a parameter instead: `ai: tauri::State<'_, AiService>`. Like the frontend, Rust code must not log prompts, outputs or file contents.

## Error kinds

Every failure is an `AiError { kind, message, hint?, status? }`. `status` is Ollama's HTTP status when there was one. Messages never contain prompt text.

| Kind | Meaning | What to do |
| --- | --- | --- |
| `ollama_not_installed` | Ollama is not reachable and no `ollama` binary was found on this machine | Install Ollama from <https://ollama.com/download> |
| `ollama_unreachable` | Ollama is installed but nothing answers at `OLLAMA_BASE_URL` | Open the Ollama app or run `ollama serve`, and check `OLLAMA_BASE_URL` |
| `model_not_installed` | The model is not in `ollama list` | Run `ollama pull <tag>`, or use **Download** in the test panel |
| `unsupported_model` | A requested, selected or downloaded tag is not a Qwen 3.5 tag, or is a cloud tag (including a model Ollama lists as running on a remote host) | Use a local `qwen3.5:<tag>` |
| `invalid_request` | A request field is invalid: empty prompt, prompt too large, option out of range, bad or duplicate request id, bad `format` | Fix the named field. Limits are listed in `src/ai/types.ts` |
| `invalid_config` | An `OLLAMA_*` variable is invalid, including an `OLLAMA_MODEL` that is not a local Qwen 3.5 tag | Fix the named variable and restart the app |
| `timeout` | Generation: no answer within `OLLAMA_TIMEOUT` when not streamed; no first chunk, or too long a gap between chunks, when streamed. Metadata calls (status, model list, show, version, and the model check before a request) and connecting are capped at `min(5 s, OLLAMA_TIMEOUT)`. Downloads time out after `max(OLLAMA_TIMEOUT, 300 s)` without progress | For generation: usually a slow first model load. Retry, raise `OLLAMA_TIMEOUT`, or use a smaller model. Raising `OLLAMA_TIMEOUT` does not lengthen the metadata cap, so a metadata timeout usually means Ollama is hung or overloaded: restart it |
| `cancelled` | The request was cancelled (Stop, `AbortSignal`, `cancelGeneration`) | Nothing to do |
| `insufficient_resources` | Ollama could not load or run the model for lack of RAM or VRAM | Close other apps, lower `numCtx`, or use a smaller tag |
| `inference_failed` | Ollama failed during generation, or the stream ended unexpectedly | Retry. Check the Ollama server log (see [Troubleshooting](#troubleshooting)) |
| `pull_failed` | A model download failed | Check the network and disk space, then retry. Ollama resumes partial downloads |
| `busy` | Too many requests at once: the app allows 2 concurrent generations and 1 download. Ollama itself can also report it is busy (HTTP 503, "server busy") when its own queue (`OLLAMA_MAX_QUEUE`) is full, for example because other clients use the same server | Wait for the running request, or cancel it. If Ollama reported it, wait and retry |
| `internal` | An unexpected error, or the AI service was called outside the desktop app | Run the app with `npm run tauri:dev`. If it persists, report it |

## Security and privacy

- **Loopback only by default.** `OLLAMA_BASE_URL` must point at this machine unless `OLLAMA_ALLOW_REMOTE` is explicitly set. The panel shows `(local)` or `(remote)` next to the URL.
- **Cloud models are rejected.** Ollama can proxy "cloud" models that run on ollama.com. The app refuses any tag ending in `cloud` by name for configuration, selection, model info, download and generation. A local copy or alias of a cloud model (for example one made with `ollama cp qwen3.5:397b-cloud qwen3.5:big`) has an ordinary name, so before every generation the app also looks the model up in Ollama's model list (`/api/tags`) and refuses it when Ollama marks it as remote (`remote_host`). Selection refuses it the same way, and the panel reports a configured or selected model like that as a problem.
- **Qwen 3.5 only, no silent substitution.** The app only uses the official `qwen3.5` library model (`qwen3.5:<tag>`, optionally written as `library/qwen3.5:<tag>` or `registry.ollama.ai/library/qwen3.5:<tag>`). Other namespaces and registry hosts are rejected, so the app never asks Ollama to download from another host. A missing model is an error, never a fallback to something else.
- **No redirects, no leaked credentials.** The HTTP client does not follow redirects, so a prompt can only go to `OLLAMA_BASE_URL`. A user name or password in `OLLAMA_BASE_URL` is rejected and shown as `***` in errors and in the panel.
- **No prompt logging.** Prompts, outputs and file contents are never logged. Error messages never include prompt text. At most, a one-line diagnostic with the request id, model, error kind and duration goes to stderr.
- **No direct webview access.** The frontend has no network path to Ollama; everything goes through the Rust commands.
- **Limits.** Prompts are capped at `OLLAMA_MAX_PROMPT_BYTES`, options are range-checked, and concurrency is capped (2 generations, 1 download).
- **Explicit downloads.** Models are downloaded only when you click Download or run `ollama pull`.

Ollama itself listens on `127.0.0.1` by default. If you set Ollama's `OLLAMA_HOST=0.0.0.0`, anyone on your network can use your Ollama server. Leave it on loopback unless you mean to share it.

## Hardware and memory

- **Memory is the main constraint.** A model needs roughly its download size plus the KV cache for its context plus runtime overhead (see [the table above](#which-variant-to-pick)). If it does not fit in VRAM, Ollama splits it between GPU and CPU. That works, but it is much slower.
- **Check where a model runs.** After a request, `ollama ps` lists loaded models and shows the GPU/CPU split in its `PROCESSOR` column, for example `100% GPU` or `45%/55% CPU/GPU`.
- **Context costs memory.** Qwen 3.5 mixes linear-attention and standard attention layers, so its KV cache grows more slowly than in a classic transformer. Very long contexts (128K-256K tokens) still add several GB. Use 8K-32K unless you need more.
- **The first request is slow.** Loading a 9B model from disk can take tens of seconds, or more than a minute with a partial CPU offload. The default `OLLAMA_TIMEOUT` (120 s) allows for this. On slow machines, raise it.
- **Models stay loaded for 5 minutes** after the last request (Ollama's `OLLAMA_KEEP_ALIVE`), then free their memory.
- **Disk:** Ollama stores models in `~/.ollama/models` on macOS, `%USERPROFILE%\.ollama\models` on Windows and `/usr/share/ollama/.ollama/models` on Linux with the install script's systemd service (`~/.ollama/models` if you run `ollama serve` yourself). Remove one with `ollama rm <tag>`. To store them elsewhere, set Ollama's `OLLAMA_MODELS` where the server reads it: on Linux, `sudo systemctl edit ollama` (add `Environment="OLLAMA_MODELS=/path"` under `[Service]`), then `sudo systemctl daemon-reload && sudo systemctl restart ollama`, and make sure the `ollama` user can read and write the directory. On Windows and macOS, set it as a user environment variable and restart the Ollama app. Setting it in your own shell does not affect a server that is already running.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Panel says "Not connected", kind `ollama_unreachable` | Start Ollama (the app, or `ollama serve`). Run `curl http://127.0.0.1:11434/api/version`. If Ollama runs on another port (Ollama's `OLLAMA_HOST`), set `OLLAMA_BASE_URL` to match |
| Kind `ollama_not_installed`, but Ollama is installed | The binary is not on `PATH` or in a standard location. Open a new terminal after installing, or start Ollama manually |
| `model_not_installed` | `ollama list` does not show the tag. Run `ollama pull <tag>` with the tag from the error message. Check for typos: `qwen3.5`, not `qwen3-5` or `qwen35` |
| `unsupported_model` | The request, Select or Download names a non-Qwen-3.5 or cloud tag, or Ollama lists the model as a cloud model (an alias of one). (A bad `OLLAMA_MODEL` is reported as `invalid_config` instead.) |
| `invalid_config` at startup | Read the message. It names the variable and the expected value, for example an `OLLAMA_MODEL` that is not a local Qwen 3.5 tag. Fix it and restart the app |
| `timeout` on the first request | The model is still loading. Retry, or raise `OLLAMA_TIMEOUT` (for example `300000`) |
| `insufficient_resources`, or Ollama's runner crashes | Use a smaller tag (`qwen3.5:4b`), lower `numCtx`, close memory-heavy apps, and check `ollama ps` |
| Empty answer with `doneReason: "length"` | Thinking used up `numPredict`. Pass `think: false` or raise `numPredict` |
| Long input seems ignored or truncated | Set `options.numCtx` large enough for the prompt |
| `busy` | Two generations (or one download) are already running: wait or cancel. If the message comes from Ollama (HTTP 503, "server busy"), its own queue is full, for example because other clients use the same server: wait and retry |
| "Local AI is only available inside the desktop app" | You opened the Vite page in a browser. Use `npm run tauri:dev` |
| `ollama pull` fails or stalls | Check the network and disk space, and retry. Ollama resumes partial downloads |

Ollama server logs:

- **Windows:** `%LOCALAPPDATA%\Ollama\server.log`
- **macOS:** `~/.ollama/logs/server.log`
- **Linux (systemd):** `journalctl -u ollama`
