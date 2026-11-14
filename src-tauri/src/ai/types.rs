//! The JSON shapes exchanged with the frontend (mirrored in `src/ai/types.ts`).
//!
//! Everything is camelCase. Optional fields are left out when `None`, except
//! where a doc comment says the field is always present (as `null`).

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::AiError;
use super::model::KnownTag;

/// A request to generate text with the local model.
#[derive(Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    /// Caller-chosen id (1..=64 chars of `[A-Za-z0-9_-]`) used to cancel the
    /// request. Generated when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Qwen 3.5 tag to use; defaults to the selected model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional system prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// The user prompt. Must not be blank.
    pub prompt: String,
    /// Sampling and length options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<GenerationOptions>,
    /// Enables (`true`) or disables (`false`) Qwen 3.5's reasoning output.
    /// When left out, Ollama's default for the model applies (on for Qwen 3.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub think: Option<bool>,
    /// Structured output: `"json"`, or a JSON Schema object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<Value>,
}

/// Prompt text is never printed, not even in debug output.
impl fmt::Debug for GenerateRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GenerateRequest")
            .field("request_id", &self.request_id)
            .field("model", &self.model)
            .field("system_bytes", &self.system.as_ref().map(String::len))
            .field("prompt_bytes", &self.prompt.len())
            .field("options", &self.options)
            .field("think", &self.think)
            .field("format", &self.format.as_ref().map(|_| "<set>"))
            .finish()
    }
}

/// Generation options, mapped to Ollama's snake_case option names.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationOptions {
    /// `0..=2`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// `0..=1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    /// `1..=1000`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<i64>,
    /// Max tokens to generate: `-1` (no limit) or `1..=32768`. Reasoning
    /// tokens count too, so leave room when `think` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_predict: Option<i64>,
    /// Context window in tokens, `512..=262144`. Changing it reloads the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_ctx: Option<i64>,
    /// Fixed seed for reproducible output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    /// Stop sequences: at most 8, each at most 64 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
    /// `0..=2`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_penalty: Option<f64>,
}

/// The result of a finished generation.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResponse {
    pub request_id: String,
    /// The model that answered.
    pub model: String,
    /// The answer text.
    pub content: String,
    /// Reasoning text, when `think` was on and the model produced some.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// Why generation stopped: `stop`, `length`, ...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_reason: Option<String>,
    pub stats: GenerationStats,
}

/// Timing and token counts reported by Ollama.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_duration_ms: Option<u64>,
    /// Time spent loading the model (large on the first request).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_eval_duration_ms: Option<u64>,
    /// Generated tokens, reasoning included.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_per_second: Option<f64>,
}

/// One event of a streamed generation, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    /// The request was accepted and sent to Ollama.
    Started { request_id: String, model: String },
    /// New output. `content` may be empty while the model is reasoning.
    Delta {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
    },
    /// Generation finished; the command resolves with the same response.
    Done { response: GenerateResponse },
    /// The request was cancelled; the command rejects with kind `cancelled`.
    Cancelled { request_id: String },
    /// Generation failed; the command rejects with the same error.
    Error { error: AiError },
}

/// One event of a model download, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PullEvent {
    Started {
        request_id: String,
        model: String,
    },
    /// A progress line from Ollama, e.g. `pulling <digest>` with byte counts.
    Progress {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        digest: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        completed: Option<u64>,
        /// `completed / total * 100` for the current layer, when both are known.
        #[serde(skip_serializing_if = "Option::is_none")]
        percent: Option<f64>,
    },
    Done {
        model: String,
    },
    Cancelled {
        request_id: String,
    },
    Error {
        error: AiError,
    },
}

/// The result of a finished download.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    pub model: String,
    /// Ollama's final status, `success`.
    pub status: String,
}

/// Whether the Ollama server answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub reachable: bool,
    /// Ollama's version, when reachable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Whether Ollama is installed on this machine. Always present: `null`
    /// when unknown (a remote server).
    pub installed: Option<bool>,
    pub base_url: String,
    /// Whether the server is on this machine (loopback).
    pub is_local: bool,
    /// Why the server is not reachable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AiError>,
}

/// A model in Ollama's local store.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub name: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    pub is_qwen35: bool,
    /// Cloud models run on ollama.com and are never used by this app.
    pub is_cloud: bool,
}

/// Details of one model, from Ollama's `/api/show`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    /// The model's native context window in tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// E.g. `completion`, `vision`, `tools`, `thinking`.
    pub capabilities: Vec<String>,
    pub supports_thinking: bool,
}

/// Everything the UI needs to show the state of the integration.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub connection: ConnectionStatus,
    /// Set when an `OLLAMA_*` variable is invalid (kind `invalid_config`;
    /// every other command then rejects with it), or when Ollama lists the
    /// configured or selected model as a cloud model running on a remote host
    /// (kind `unsupported_model`; generating with it is rejected).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_error: Option<AiError>,
    /// The model from `OLLAMA_MODEL` (or the default).
    pub configured_model: String,
    /// The model used when a request names none.
    pub selected_model: String,
    /// Always present: `null` when Ollama is unreachable.
    pub selected_model_installed: Option<bool>,
    /// Installed local Qwen 3.5 models (cloud tags filtered out).
    pub installed_qwen35_models: Vec<ModelSummary>,
    /// Models currently loaded in memory.
    pub loaded_models: Vec<String>,
    pub active_generations: usize,
    pub known_qwen35_tags: &'static [KnownTag],
    /// Whether prompts stay on this machine: the Ollama server is on loopback
    /// (the same as `connection.is_local`; `false` while the config is invalid).
    /// Cloud models are rejected either way.
    pub local_only: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::error::AiErrorKind;
    use serde_json::json;

    #[test]
    fn generate_request_reads_camel_case() {
        let request: GenerateRequest = serde_json::from_value(json!({
            "requestId": "abc",
            "prompt": "hi",
            "options": { "topP": 0.5, "numPredict": 32, "repeatPenalty": 1.1, "stop": ["\n"] },
            "think": false,
            "format": "json",
        }))
        .unwrap();
        assert_eq!(request.request_id.as_deref(), Some("abc"));
        let options = request.options.unwrap();
        assert_eq!(options.top_p, Some(0.5));
        assert_eq!(options.num_predict, Some(32));
        assert_eq!(options.repeat_penalty, Some(1.1));
        assert_eq!(request.think, Some(false));
        assert_eq!(request.format, Some(json!("json")));
    }

    #[test]
    fn debug_output_never_contains_the_prompt() {
        let request = GenerateRequest {
            prompt: "secret source code".into(),
            system: Some("secret system".into()),
            ..Default::default()
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("secret"), "{debug}");
        assert!(debug.contains("prompt_bytes: 18"));
    }

    #[test]
    fn stream_events_are_tagged() {
        let started = StreamEvent::Started { request_id: "r1".into(), model: "qwen3.5:9b".into() };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            json!({ "type": "started", "requestId": "r1", "model": "qwen3.5:9b" })
        );

        let delta = StreamEvent::Delta { content: "Hi".into(), thinking: None };
        assert_eq!(serde_json::to_value(delta).unwrap(), json!({ "type": "delta", "content": "Hi" }));
        let delta = StreamEvent::Delta { content: String::new(), thinking: Some("hmm".into()) };
        assert_eq!(serde_json::to_value(delta).unwrap(), json!({ "type": "delta", "content": "", "thinking": "hmm" }));

        let response = GenerateResponse {
            request_id: "r1".into(),
            model: "qwen3.5:9b".into(),
            content: "Hi".into(),
            done_reason: Some("stop".into()),
            stats: GenerationStats { eval_tokens: Some(2), tokens_per_second: Some(10.0), ..Default::default() },
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(StreamEvent::Done { response }).unwrap(),
            json!({
                "type": "done",
                "response": {
                    "requestId": "r1", "model": "qwen3.5:9b", "content": "Hi", "doneReason": "stop",
                    "stats": { "evalTokens": 2, "tokensPerSecond": 10.0 },
                },
            })
        );

        let cancelled = StreamEvent::Cancelled { request_id: "r1".into() };
        assert_eq!(serde_json::to_value(cancelled).unwrap(), json!({ "type": "cancelled", "requestId": "r1" }));

        let error = StreamEvent::Error { error: AiError::new(AiErrorKind::Timeout, "slow") };
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({ "type": "error", "error": { "kind": "timeout", "message": "slow" } })
        );
    }

    #[test]
    fn pull_events_are_tagged() {
        let progress = PullEvent::Progress {
            status: "pulling abc".into(),
            digest: Some("sha256:abc".into()),
            total: Some(200),
            completed: Some(50),
            percent: Some(25.0),
        };
        assert_eq!(
            serde_json::to_value(progress).unwrap(),
            json!({ "type": "progress", "status": "pulling abc", "digest": "sha256:abc", "total": 200, "completed": 50, "percent": 25.0 })
        );
        let bare = PullEvent::Progress {
            status: "pulling manifest".into(),
            digest: None,
            total: None,
            completed: None,
            percent: None,
        };
        assert_eq!(serde_json::to_value(bare).unwrap(), json!({ "type": "progress", "status": "pulling manifest" }));
        assert_eq!(
            serde_json::to_value(PullEvent::Started { request_id: "p1".into(), model: "qwen3.5:4b".into() }).unwrap(),
            json!({ "type": "started", "requestId": "p1", "model": "qwen3.5:4b" })
        );
        assert_eq!(
            serde_json::to_value(PullEvent::Done { model: "qwen3.5:4b".into() }).unwrap(),
            json!({ "type": "done", "model": "qwen3.5:4b" })
        );
        assert_eq!(
            serde_json::to_value(PullEvent::Cancelled { request_id: "p1".into() }).unwrap(),
            json!({ "type": "cancelled", "requestId": "p1" })
        );
    }

    #[test]
    fn connection_status_always_has_installed() {
        let status = ConnectionStatus {
            reachable: false,
            version: None,
            installed: None,
            base_url: "http://gpu-box:11434".into(),
            is_local: false,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({ "reachable": false, "installed": null, "baseUrl": "http://gpu-box:11434", "isLocal": false })
        );
    }
}
