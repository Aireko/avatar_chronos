//! Local AI inference: Qwen 3.5 running in [Ollama](https://ollama.com) on this machine.
//!
//! All Ollama HTTP traffic happens here, in Rust. The webview never talks to
//! Ollama directly: it calls the `ai_*` Tauri commands in [`commands`]
//! (through `src/ai/aiService.ts`), which delegate to [`AiService`].
//!
//! # Privacy
//!
//! * The Ollama server must be on a loopback address unless
//!   `OLLAMA_ALLOW_REMOTE=true` (see [`config`]).
//! * Only local tags of the official `qwen3.5` library model are used; cloud
//!   tags (`...cloud`) are rejected everywhere (see [`model`]), and so is any
//!   model Ollama lists as running on a remote host, such as a local alias of
//!   a cloud model (checked before every generation, see [`AiService`]).
//! * Redirects are never followed, so requests only go to `OLLAMA_BASE_URL`.
//! * Prompts, outputs and file contents are never logged or put in error messages.
//!
//! # Using it from other Rust features
//!
//! `lib.rs` registers one [`AiService`] as managed state. A command (for example
//! a reviewer, parser or indexer feature) borrows it with `State`:
//!
//! ```ignore
//! use crate::ai::{AiError, AiService, GenerateRequest, GenerationOptions};
//!
//! #[tauri::command]
//! async fn summarize_file(ai: tauri::State<'_, AiService>, text: String) -> Result<String, AiError> {
//!     let request = GenerateRequest {
//!         system: Some("Summarize the code in two sentences.".into()),
//!         prompt: text,
//!         think: Some(false),
//!         options: Some(GenerationOptions { temperature: Some(0.2), ..Default::default() }),
//!         ..Default::default()
//!     };
//!     Ok(ai.generate(request).await?.content)
//! }
//! ```
//!
//! Outside a command, use `app.state::<AiService>()` (from `tauri::Manager`).
//! `AiService` is `Clone` (an `Arc` inside), so it can be moved into spawned
//! tasks. Use [`AiService::generate_stream`] for incremental output and
//! [`AiService::cancel`] with the request's `request_id` to stop it.

pub mod client;
pub mod commands;
pub mod config;
pub mod error;
pub mod model;
pub mod service;
pub mod types;

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

pub use config::{AiConfig, ConfigError};
pub use error::{AiError, AiErrorKind};
pub use model::{DEFAULT_MODEL, KNOWN_QWEN35_TAGS, KnownTag};
pub use service::AiService;
pub use types::{
    AiStatus, ConnectionStatus, GenerateRequest, GenerateResponse, GenerationOptions, GenerationStats, ModelInfo,
    ModelSummary, PullEvent, PullSummary, StreamEvent,
};
