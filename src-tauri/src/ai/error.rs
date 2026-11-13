//! The single error type of the AI module.
//!
//! Every command rejects with an [`AiError`], which serializes to a predictable
//! JSON object the frontend can switch on:
//!
//! ```json
//! { "kind": "model_not_installed", "message": "...", "hint": "...", "status": 404 }
//! ```
//!
//! `hint` and `status` are left out when there is nothing to say. Messages are
//! built from metadata only (model names, sizes, durations, Ollama's own error
//! text) and never contain prompt or output text.

use std::fmt;
use std::time::Duration;

use serde::Serialize;

use super::config::ConfigError;

/// Longest Ollama error text copied into a message, in characters.
const MAX_UPSTREAM_MESSAGE_CHARS: usize = 500;

/// Hint for a server that is installed but not answering.
const HINT_START_OLLAMA: &str = "Start Ollama (open the Ollama app, or run 'ollama serve') and check OLLAMA_BASE_URL";
/// Hint for a machine without Ollama.
const HINT_INSTALL_OLLAMA: &str =
    "Install Ollama from https://ollama.com/download, then start it (open the Ollama app, or run 'ollama serve')";

/// What went wrong, as a stable machine-readable tag (`snake_case` in JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorKind {
    /// Ollama is not running and no Ollama binary was found on this machine.
    OllamaNotInstalled,
    /// Ollama is installed (or remote) but its server could not be reached.
    OllamaUnreachable,
    /// The requested model is not in Ollama's local model store.
    ModelNotInstalled,
    /// The model is not a local Qwen 3.5 tag (wrong family, or a cloud tag).
    UnsupportedModel,
    /// The request itself is invalid (empty prompt, bad option, bad id, ...).
    InvalidRequest,
    /// An `OLLAMA_*` environment variable has an invalid value.
    InvalidConfig,
    /// Ollama did not answer within the configured time.
    Timeout,
    /// The request was cancelled by the caller.
    Cancelled,
    /// Not enough RAM/VRAM (or similar) to load or run the model.
    InsufficientResources,
    /// Ollama failed while generating.
    InferenceFailed,
    /// Downloading a model failed.
    PullFailed,
    /// Too many concurrent requests, here or in Ollama's queue.
    Busy,
    /// A bug or an unexpected response; not the caller's fault.
    Internal,
}

impl AiErrorKind {
    /// The `snake_case` name used in JSON, for one-line log messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OllamaNotInstalled => "ollama_not_installed",
            Self::OllamaUnreachable => "ollama_unreachable",
            Self::ModelNotInstalled => "model_not_installed",
            Self::UnsupportedModel => "unsupported_model",
            Self::InvalidRequest => "invalid_request",
            Self::InvalidConfig => "invalid_config",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::InsufficientResources => "insufficient_resources",
            Self::InferenceFailed => "inference_failed",
            Self::PullFailed => "pull_failed",
            Self::Busy => "busy",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for AiErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The kind of Ollama call that failed. It decides how a generic failure is
/// classified (`inference_failed` vs `pull_failed` vs `internal`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Metadata calls: version, tags, show, ps.
    Query,
    /// Chat / generation.
    Inference,
    /// Model download.
    Pull,
}

impl Operation {
    /// The kind reported for a failure with no more specific classification.
    fn failure_kind(self) -> AiErrorKind {
        match self {
            Self::Query => AiErrorKind::Internal,
            Self::Inference => AiErrorKind::InferenceFailed,
            Self::Pull => AiErrorKind::PullFailed,
        }
    }
}

/// An error returned by every AI command. Serializes as camelCase JSON
/// `{ kind, message, hint?, status? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    /// Machine-readable category.
    pub kind: AiErrorKind,
    /// Human-readable description. Never contains prompt or output text.
    pub message: String,
    /// An actionable next step for the user, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// The HTTP status Ollama answered with, when the error came from Ollama.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl AiError {
    /// An error with no hint and no status.
    pub fn new(kind: AiErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), hint: None, status: None }
    }

    /// Adds an actionable hint.
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Records the HTTP status Ollama answered with.
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    /// Ollama could not be reached at `base_url`.
    pub fn unreachable(base_url: &str) -> Self {
        Self::new(AiErrorKind::OllamaUnreachable, format!("Could not connect to Ollama at {base_url}"))
            .with_hint(HINT_START_OLLAMA)
    }

    /// Ollama could not be reached and no Ollama binary exists on this machine.
    pub fn not_installed(base_url: &str) -> Self {
        Self::new(
            AiErrorKind::OllamaNotInstalled,
            format!("Ollama does not appear to be installed (nothing is listening at {base_url})"),
        )
        .with_hint(HINT_INSTALL_OLLAMA)
    }

    /// `model` is not in Ollama's local model store.
    pub fn model_not_installed(model: &str) -> Self {
        Self::new(AiErrorKind::ModelNotInstalled, format!("Model '{model}' is not installed in Ollama"))
            .with_hint(format!("Run 'ollama pull {model}' or use Download model in the app"))
    }

    /// The request field `field` is invalid; `problem` says why.
    pub fn invalid_request(field: &str, problem: impl fmt::Display) -> Self {
        Self::new(AiErrorKind::InvalidRequest, format!("Invalid {field}: {problem}"))
    }

    /// `model` is a well-formed name, but not a local Qwen 3.5 tag.
    pub fn unsupported_model(model: &str, reason: &str) -> Self {
        Self::new(AiErrorKind::UnsupportedModel, format!("Model '{model}' is not supported: {reason}"))
            .with_hint("Use a local Qwen 3.5 tag such as qwen3.5:9b (see 'ollama list')")
    }

    /// Ollama did not answer within `limit`.
    pub fn timeout(limit: Duration) -> Self {
        Self::new(AiErrorKind::Timeout, format!("Ollama did not respond within {}", format_duration(limit))).with_hint(
            "The model may still be loading or the machine may be busy; try again, \
                 increase OLLAMA_TIMEOUT (milliseconds), or use a smaller model",
        )
    }

    /// The caller cancelled the request.
    pub fn cancelled() -> Self {
        Self::new(AiErrorKind::Cancelled, "The request was cancelled")
    }

    /// Too much concurrent work; `what` names the limit that was hit.
    pub fn busy(what: impl Into<String>) -> Self {
        Self::new(AiErrorKind::Busy, what).with_hint("Wait for the running request to finish, or cancel it")
    }

    /// An unexpected failure that is not the caller's fault.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(AiErrorKind::Internal, message)
    }

    /// A stream that closed before Ollama sent its final (`done`) line.
    pub fn stream_ended(operation: Operation) -> Self {
        Self::new(operation.failure_kind(), "Ollama's stream ended unexpectedly")
            .with_hint("Ollama may have stopped or crashed; check that it is still running and try again")
    }

    /// A response body that is not the JSON Ollama is expected to send.
    pub fn unexpected_response(operation: Operation) -> Self {
        Self::new(operation.failure_kind(), "Ollama sent a response this app does not understand")
            .with_hint("Check that OLLAMA_BASE_URL points to an Ollama server and that Ollama is up to date")
    }

    /// Classifies a transport-level failure (no HTTP response, or a broken body).
    ///
    /// A refused connection is reported as `ollama_unreachable`; the service
    /// upgrades it to `ollama_not_installed` when no Ollama binary exists.
    pub fn from_transport(err: &reqwest::Error, operation: Operation, base_url: &str) -> Self {
        if err.is_connect() {
            Self::unreachable(base_url)
        } else if err.is_timeout() {
            Self::new(AiErrorKind::Timeout, "The connection to Ollama timed out").with_hint(HINT_START_OLLAMA)
        } else if err.is_decode() {
            Self::unexpected_response(operation)
        } else {
            Self::new(operation.failure_kind(), "The connection to Ollama failed")
                .with_hint("Ollama may have stopped or crashed; check that it is still running and try again")
        }
    }

    /// Classifies an Ollama error response: `status` is the HTTP status and
    /// `body` the raw body (usually `{"error":"..."}`, sometimes plain text).
    pub fn from_ollama_response(status: u16, body: &str, operation: Operation, model: Option<&str>) -> Self {
        match upstream_error_text(body) {
            Some(message) => Self::from_ollama_message(Some(status), &message, operation, model),
            // A non-JSON 404 is Gin's "404 page not found": the route does not exist.
            None if status == 404 => {
                Self::new(operation.failure_kind(), "Ollama does not know this API endpoint (HTTP 404)")
                    .with_hint("Check that OLLAMA_BASE_URL points to an Ollama server and update Ollama")
                    .with_status(status)
            }
            None => {
                let message = format!("Ollama answered with HTTP {status}: {}", truncate(body.trim()));
                let kind = if status == 503 { AiErrorKind::Busy } else { operation.failure_kind() };
                Self::new(kind, message).with_status(status)
            }
        }
    }

    /// Classifies an Ollama error message, from an error response or from a
    /// mid-stream `{"error":"..."}` line (`status` is `None` then).
    pub fn from_ollama_message(status: Option<u16>, message: &str, operation: Operation, model: Option<&str>) -> Self {
        let lower = message.to_ascii_lowercase();
        let text = format!("Ollama: {}", truncate(message.trim()));
        let error = if is_memory_error(&lower) {
            Self::new(AiErrorKind::InsufficientResources, text).with_hint(
                "Not enough memory to run this model: close other apps, lower numCtx, \
                 or use a smaller Qwen 3.5 tag such as qwen3.5:4b",
            )
        } else if operation == Operation::Pull {
            Self::new(AiErrorKind::PullFailed, text).with_hint(
                "Check your internet connection and free disk space, and that the tag exists \
                 at https://ollama.com/library/qwen3.5/tags, then retry",
            )
        } else if status == Some(404) || lower.contains("not found") {
            let model = model.unwrap_or("the model");
            let mut error = Self::model_not_installed(model);
            error.message = format!("{} ({text})", error.message);
            error
        } else if status == Some(503) || lower.contains("server busy") {
            Self::busy(text)
        } else if status == Some(400) {
            Self::new(AiErrorKind::InvalidRequest, text)
        } else {
            Self::new(operation.failure_kind(), text).with_hint(
                "Check the Ollama server log (Windows: %LOCALAPPDATA%\\Ollama\\server.log, \
                 macOS: ~/.ollama/logs/server.log, Linux: journalctl -u ollama)",
            )
        };
        match status {
            Some(status) => error.with_status(status),
            None => error,
        }
    }

    /// An invalid `OLLAMA_*` environment variable.
    pub fn invalid_config(err: &ConfigError) -> Self {
        Self::new(AiErrorKind::InvalidConfig, err.to_string())
            .with_hint(format!("Fix or unset {} and restart the app", err.variable))
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.kind)?;
        if let Some(hint) = &self.hint {
            write!(f, ". {hint}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AiError {}

impl From<&ConfigError> for AiError {
    fn from(err: &ConfigError) -> Self {
        Self::invalid_config(err)
    }
}

/// Extracts `error` from an `{"error":"..."}` body, or `None` if the body is not that.
fn upstream_error_text(body: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct ErrorBody {
        error: String,
    }
    serde_json::from_str::<ErrorBody>(body).ok().map(|body| body.error)
}

/// Whether an (ASCII-lowercased) Ollama message describes a memory problem.
fn is_memory_error(lower: &str) -> bool {
    const NEEDLES: [&str; 6] = [
        "requires more system memory",
        "out of memory",
        "insufficient",
        "cuda error",
        "failed to allocate",
        "unable to load full model on gpu",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

/// Shortens upstream text so one error cannot flood the UI.
fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_UPSTREAM_MESSAGE_CHARS) {
        Some((cut, _)) => format!("{}...", &text[..cut]),
        None => text.to_owned(),
    }
}

/// `1500 ms` -> "1.5 s", `120000 ms` -> "120 s".
fn format_duration(duration: Duration) -> String {
    let millis = duration.as_millis();
    if millis < 1000 {
        format!("{millis} ms")
    } else if millis.is_multiple_of(1000) {
        format!("{} s", millis / 1000)
    } else {
        format!("{:.1} s", duration.as_secs_f64())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_to_the_documented_shape() {
        let error = AiError::model_not_installed("qwen3.5:9b").with_status(404);
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({
                "kind": "model_not_installed",
                "message": "Model 'qwen3.5:9b' is not installed in Ollama",
                "hint": "Run 'ollama pull qwen3.5:9b' or use Download model in the app",
                "status": 404,
            })
        );
    }

    #[test]
    fn omits_missing_hint_and_status() {
        let value = serde_json::to_value(AiError::cancelled()).unwrap();
        assert_eq!(value, json!({ "kind": "cancelled", "message": "The request was cancelled" }));
    }

    #[test]
    fn every_kind_serializes_to_its_snake_case_name() {
        use AiErrorKind::*;
        let kinds = [
            OllamaNotInstalled,
            OllamaUnreachable,
            ModelNotInstalled,
            UnsupportedModel,
            InvalidRequest,
            InvalidConfig,
            Timeout,
            Cancelled,
            InsufficientResources,
            InferenceFailed,
            PullFailed,
            Busy,
            Internal,
        ];
        for kind in kinds {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
        }
        assert_eq!(serde_json::to_value(OllamaNotInstalled).unwrap(), json!("ollama_not_installed"));
        assert_eq!(serde_json::to_value(InsufficientResources).unwrap(), json!("insufficient_resources"));
    }

    #[test]
    fn hints_are_actionable() {
        assert!(AiError::unreachable("http://127.0.0.1:11434").hint.unwrap().contains("ollama serve"));
        assert!(AiError::not_installed("http://127.0.0.1:11434").hint.unwrap().contains("https://ollama.com/download"));
    }

    #[test]
    fn maps_404_to_model_not_installed() {
        let body = r#"{"error":"model 'qwen3.5:27b' not found"}"#;
        let error = AiError::from_ollama_response(404, body, Operation::Inference, Some("qwen3.5:27b"));
        assert_eq!(error.kind, AiErrorKind::ModelNotInstalled);
        assert_eq!(error.status, Some(404));
        assert!(error.message.contains("qwen3.5:27b"));
        assert!(error.hint.unwrap().contains("ollama pull qwen3.5:27b"));
    }

    #[test]
    fn maps_memory_errors_to_insufficient_resources() {
        for message in [
            "model requires more system memory (12.0 GiB) than is available (6.1 GiB)",
            "llama runner process has terminated: CUDA error: out of memory",
            "failed to allocate buffer",
            "insufficient VRAM",
        ] {
            let body = serde_json::to_string(&json!({ "error": message })).unwrap();
            let error = AiError::from_ollama_response(500, &body, Operation::Inference, Some("qwen3.5:9b"));
            assert_eq!(error.kind, AiErrorKind::InsufficientResources, "{message}");
            assert_eq!(error.status, Some(500));
        }
    }

    #[test]
    fn maps_other_server_errors_by_operation() {
        let body = r#"{"error":"an error was encountered while running the model"}"#;
        let inference = AiError::from_ollama_response(500, body, Operation::Inference, None);
        assert_eq!(inference.kind, AiErrorKind::InferenceFailed);
        let pull = AiError::from_ollama_response(500, body, Operation::Pull, None);
        assert_eq!(pull.kind, AiErrorKind::PullFailed);
        let busy = r#"{"error":"server busy, please try again.  maximum pending requests exceeded"}"#;
        assert_eq!(AiError::from_ollama_response(503, busy, Operation::Inference, None).kind, AiErrorKind::Busy);
        let bad = r#"{"error":"\"gemma3:1b\" does not support thinking"}"#;
        assert_eq!(
            AiError::from_ollama_response(400, bad, Operation::Inference, None).kind,
            AiErrorKind::InvalidRequest
        );
    }

    #[test]
    fn handles_plain_text_bodies() {
        let error = AiError::from_ollama_response(404, "404 page not found", Operation::Query, None);
        assert_eq!(error.kind, AiErrorKind::Internal);
        assert!(error.hint.unwrap().contains("OLLAMA_BASE_URL"));
        let error = AiError::from_ollama_response(502, "Bad Gateway", Operation::Inference, None);
        assert_eq!(error.kind, AiErrorKind::InferenceFailed);
        assert!(error.message.contains("Bad Gateway"));
    }

    #[test]
    fn truncates_long_upstream_messages() {
        let long = "x".repeat(2000);
        let error = AiError::from_ollama_message(Some(500), &long, Operation::Inference, None);
        assert!(error.message.len() < 600);
        assert!(error.message.ends_with("..."));
    }

    #[test]
    fn formats_durations() {
        assert_eq!(format_duration(Duration::from_millis(250)), "250 ms");
        assert_eq!(format_duration(Duration::from_millis(120_000)), "120 s");
        assert_eq!(format_duration(Duration::from_millis(1500)), "1.5 s");
    }
}
