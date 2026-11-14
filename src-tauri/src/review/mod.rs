//! PR Bug Check: background AI code review of GitHub pull requests, run by
//! the local Qwen 3.5 model through [`crate::ai::AiService`].
//!
//! It scans a PR's diff for real bugs (logic bugs, state leaks, unit
//! mismatches, security, concurrency and error-handling bugs), shows findings
//! with explanations and suggested fixes, and posts the ones the user selects
//! as inline review comments. It runs on demand (`bug_check_run`) or in auto
//! mode (the [`watcher`]), which, while the app runs, reviews open PRs that
//! have no up-to-date report: at first every open PR not checked yet, then
//! PRs that are opened or get new commits.
//!
//! # Architecture
//!
//! ```text
//! commands.rs ── bug_check_* Tauri commands (src/bugcheck/bugCheckService.ts)
//!   ├─ engine.rs  BugCheckEngine: fetch PR -> chunk diff -> model per chunk -> validate -> store; post
//!   │    ├─ github.rs   GitHub through the `gh` CLI (GhRunner trait: RealGh / FakeGh in tests)
//!   │    ├─ diff.rs     unified-diff parsing, new-side line numbers, chunking, skip list
//!   │    ├─ prompt.rs   system prompt, untrusted-data framing, JSON Schema of the answer
//!   │    ├─ findings.rs JSON extraction, finding validation (snap / postable / clamp / dedup ids)
//!   │    ├─ comment.rs  Markdown of the review and its comments (suggestion blocks)
//!   │    └─ store.rs    reports and settings as JSON under <app data>/pr-bug-check
//!   └─ watcher.rs auto mode: poll open PRs, review new/updated ones one at a time, optional auto-post
//! ```
//!
//! `lib.rs` creates one [`BugCheck`] in `.setup()` (it needs the app data
//! directory and an `AppHandle` to emit watcher events as
//! [`WATCHER_EVENT`]) and registers it as managed state.
//!
//! # Privacy
//!
//! * PR code goes only to the local [`AiService`], which only talks to a
//!   local Ollama and rejects cloud models. No cloud AI is involved.
//! * GitHub is reached only through the user's own `gh` login; nothing is
//!   posted unless the user posts findings (or enables auto-post).
//! * PR code, prompts and model output are never logged; at most one line of
//!   metadata per run or post goes to stderr. Error messages never quote code.
//! * PR content is untrusted: the prompt frames it as data and tells the model
//!   to ignore instructions inside it, the model's answer is validated
//!   against the lines of the diff the model was shown, and its prose is
//!   neutralised before posting (no mentions, links, images, HTML or extra
//!   suggestion blocks; see [`comment`]).
//!
//! # Reusing the engine from Rust
//!
//! ```ignore
//! use tauri::Manager;
//! use tokio_util::sync::CancellationToken;
//! use crate::review::{BugCheck, BugCheckOptions};
//!
//! let bug_check = app.state::<BugCheck>();
//! let report = bug_check
//!     .engine
//!     .run("owner/repo", 42, BugCheckOptions::default(), |_event| {}, CancellationToken::new())
//!     .await?;
//! for finding in &report.findings {
//!     println!("{}:{} {}", finding.path, finding.line, finding.title);
//! }
//! ```
//!
//! [`BugCheckEngine`] is `Clone`; build your own with
//! [`BugCheckEngine::new`] (an [`AiService`], a [`GhRunner`] such as
//! [`RealGh`], and a [`ReportStore`]) to use it without the app.

pub mod clock;
pub mod commands;
pub mod comment;
pub mod diff;
pub mod engine;
pub mod error;
pub mod findings;
pub mod github;
pub mod prompt;
pub mod store;
pub mod types;
pub mod watcher;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use crate::ai::AiService;

pub use engine::BugCheckEngine;
pub use error::{BugCheckError, BugCheckErrorKind};
pub use github::{GhRunner, GitHub, RealGh};
pub use store::ReportStore;
pub use types::{
    BugCheckEvent, BugCheckOptions, BugCheckReport, Category, Finding, GhStatus, PostResult, PrWithStatus,
    PullRequestSummary, Severity, WatchConfig, WatchState, WatcherEvent,
};
pub use watcher::{Emitter, Watcher};

/// The app-wide Tauri event carrying [`WatcherEvent`]s.
pub const WATCHER_EVENT: &str = "pr-bug-check://event";

/// The managed state behind the `bug_check_*` commands.
pub struct BugCheck {
    pub engine: BugCheckEngine,
    pub watcher: Watcher,
}

impl BugCheck {
    /// The engine (real `gh`, reports under `store_root`) and a stopped watcher
    /// emitting through `emit`. Call `watcher.resume()` to restore auto mode.
    pub fn new(ai: AiService, store_root: PathBuf, emit: Emitter) -> Self {
        let engine = BugCheckEngine::new(ai, Arc::new(RealGh), ReportStore::new(store_root));
        let watcher = Watcher::new(engine.clone(), emit);
        Self { engine, watcher }
    }
}
