//! The single error type of PR Bug Check.
//!
//! Every `bug_check_*` command rejects with a [`BugCheckError`], which
//! serializes to camelCase JSON the frontend can switch on:
//!
//! ```json
//! { "kind": "ai_failed", "message": "...", "hint": "Start Ollama ...", "aiKind": "ollama_unreachable" }
//! ```
//!
//! `hint` and `aiKind` are left out when there is nothing to say.
//!
//! # Errors from the local AI
//!
//! An [`AiError`] is wrapped as kind `ai_failed`, keeping its `message` and
//! `hint` (for example "Start Ollama ...") and recording the original AI kind
//! in `aiKind`. The one exception is an AI `cancelled`, which becomes
//! `cancelled` here so a cancelled run always reports the same kind.
//!
//! Messages never contain PR code, prompts or model output: GitHub failures
//! carry the first line of `gh`'s stderr (at most 300 characters).

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ai::{AiError, AiErrorKind};

/// Longest piece of `gh` error text copied into a message, in characters.
pub(crate) const MAX_GH_ERROR_CHARS: usize = 300;

/// What went wrong, as a stable machine-readable tag (`snake_case` in JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BugCheckErrorKind {
    /// The `gh` CLI is not installed (or not on `PATH`).
    GhNotInstalled,
    /// `gh` is installed but not logged in to GitHub.
    GhNotAuthenticated,
    /// The repository, pull request or stored report does not exist.
    NotFound,
    /// Any other GitHub / `gh` failure.
    GithubFailed,
    /// Invalid input (repo name, PR number, options, finding ids, ...).
    InvalidRequest,
    /// A check of the same pull request is already running.
    Busy,
    /// The run was cancelled.
    Cancelled,
    /// The pull request changed since the report was made; run the check again.
    StaleReport,
    /// The local AI (Ollama) failed; `aiKind`, `message` and `hint` say why.
    AiFailed,
    /// A bug or an unexpected response; not the caller's fault.
    Internal,
}

impl BugCheckErrorKind {
    /// The `snake_case` name used in JSON, for one-line log messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GhNotInstalled => "gh_not_installed",
            Self::GhNotAuthenticated => "gh_not_authenticated",
            Self::NotFound => "not_found",
            Self::GithubFailed => "github_failed",
            Self::InvalidRequest => "invalid_request",
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::StaleReport => "stale_report",
            Self::AiFailed => "ai_failed",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for BugCheckErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An error returned by every PR Bug Check command. Serializes as camelCase
/// JSON `{ kind, message, hint?, aiKind? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugCheckError {
    /// Machine-readable category.
    pub kind: BugCheckErrorKind,
    /// Human-readable description. Never contains PR code or model output.
    pub message: String,
    /// An actionable next step for the user, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// For `ai_failed`: the original [`AiErrorKind`] (`ollama_unreachable`,
    /// `model_not_installed`, `timeout`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_kind: Option<String>,
}

impl BugCheckError {
    /// An error with no hint.
    pub fn new(kind: BugCheckErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), hint: None, ai_kind: None }
    }

    /// Adds an actionable hint.
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// The field `field` is invalid; `problem` says why.
    pub fn invalid_request(field: &str, problem: impl fmt::Display) -> Self {
        Self::new(BugCheckErrorKind::InvalidRequest, format!("Invalid {field}: {problem}"))
    }

    /// `gh` is not installed.
    pub fn gh_not_installed() -> Self {
        Self::new(BugCheckErrorKind::GhNotInstalled, "The GitHub CLI (gh) is not installed or not on PATH")
            .with_hint("Install it from https://cli.github.com and run 'gh auth login'")
    }

    /// `gh` is not logged in.
    pub fn gh_not_authenticated() -> Self {
        Self::new(BugCheckErrorKind::GhNotAuthenticated, "The GitHub CLI (gh) is not logged in to GitHub")
            .with_hint("Run 'gh auth login' (with the 'repo' scope) and try again")
    }

    /// GitHub answered 404 (or `gh` could not resolve the repo / PR).
    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new(BugCheckErrorKind::NotFound, what)
            .with_hint("Check the repository name (owner/name) and the PR number, and that your gh account can see it")
    }

    /// Another GitHub failure; `detail` is already trimmed metadata.
    pub fn github_failed(detail: impl Into<String>) -> Self {
        Self::new(BugCheckErrorKind::GithubFailed, detail)
    }

    /// A check of the same PR is already running.
    pub fn busy(repo: &str, number: u64) -> Self {
        Self::new(BugCheckErrorKind::Busy, format!("A bug check of {repo}#{number} is already running"))
            .with_hint("Wait for it to finish, or cancel it")
    }

    /// The run was cancelled.
    pub fn cancelled() -> Self {
        Self::new(BugCheckErrorKind::Cancelled, "The bug check was cancelled")
    }

    /// The PR's head commit moved since the report was made.
    pub fn stale_report(repo: &str, number: u64) -> Self {
        Self::new(
            BugCheckErrorKind::StaleReport,
            format!("{repo}#{number} changed since this check (new commits were pushed)"),
        )
        .with_hint("The PR changed since this check; run it again")
    }

    /// An unexpected failure that is not the caller's fault.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(BugCheckErrorKind::Internal, message)
    }

    /// Whether this is the `cancelled` error.
    pub fn is_cancelled(&self) -> bool {
        self.kind == BugCheckErrorKind::Cancelled
    }
}

impl fmt::Display for BugCheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.kind)?;
        if let Some(hint) = &self.hint {
            write!(f, ". {hint}")?;
        }
        Ok(())
    }
}

impl std::error::Error for BugCheckError {}

/// Wraps an AI error as `ai_failed` (keeping message, hint and kind), except
/// `cancelled`, which stays `cancelled`.
impl From<AiError> for BugCheckError {
    fn from(err: AiError) -> Self {
        if err.kind == AiErrorKind::Cancelled {
            return Self::cancelled();
        }
        Self {
            kind: BugCheckErrorKind::AiFailed,
            message: err.message,
            hint: err.hint,
            ai_kind: Some(err.kind.as_str().to_owned()),
        }
    }
}

/// Shortens `text` to at most `max` characters, adding `...` when cut.
pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}...", &text[..cut]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unit_serializes_to_the_documented_shape() {
        assert_eq!(
            serde_json::to_value(BugCheckError::gh_not_installed()).unwrap(),
            json!({
                "kind": "gh_not_installed",
                "message": "The GitHub CLI (gh) is not installed or not on PATH",
                "hint": "Install it from https://cli.github.com and run 'gh auth login'",
            })
        );
        assert_eq!(
            serde_json::to_value(BugCheckError::cancelled()).unwrap(),
            json!({ "kind": "cancelled", "message": "The bug check was cancelled" })
        );
    }

    #[test]
    fn unit_every_kind_serializes_to_its_snake_case_name() {
        use BugCheckErrorKind::*;
        for kind in [
            GhNotInstalled,
            GhNotAuthenticated,
            NotFound,
            GithubFailed,
            InvalidRequest,
            Busy,
            Cancelled,
            StaleReport,
            AiFailed,
            Internal,
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
        }
    }

    #[test]
    fn unit_wraps_ai_errors_keeping_the_hint() {
        let error: BugCheckError = AiError::unreachable("http://127.0.0.1:11434").into();
        assert_eq!(error.kind, BugCheckErrorKind::AiFailed);
        assert_eq!(error.ai_kind.as_deref(), Some("ollama_unreachable"));
        assert!(error.hint.as_deref().unwrap().contains("ollama serve"));
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["aiKind"], "ollama_unreachable");

        let cancelled: BugCheckError = AiError::cancelled().into();
        assert_eq!(cancelled, BugCheckError::cancelled());
    }

    #[test]
    fn unit_truncates_by_characters() {
        assert_eq!(truncate_chars("héllo", 3), "hél...");
        assert_eq!(truncate_chars("abc", 3), "abc");
    }
}
