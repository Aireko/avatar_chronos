//! A small HTTP client for Ollama's native REST API.
//!
//! It speaks only the endpoints this app needs (`/api/version`, `/api/tags`,
//! `/api/show`, `/api/ps`, `/api/pull`, `/api/chat`) and turns every failure
//! into an [`AiError`]. Streaming endpoints answer with NDJSON (one JSON object
//! per line); [`LineBuffer`] reassembles lines that arrive split across, or
//! packed into, network chunks.
//!
//! Cancelling: every call races a [`CancellationToken`]. When it fires, the
//! response is dropped, which closes the connection, and Ollama stops
//! generating as soon as it notices the client has gone.

use std::future::Future;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::config::display_url;
use super::error::{AiError, Operation};

/// Longest wait for a TCP connection to the Ollama server.
const MAX_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Talks to one Ollama server. Cheap to clone (the connection pool is shared).
#[derive(Debug, Clone)]
pub struct OllamaClient {
    http: Client,
    base_url: Url,
}

impl OllamaClient {
    /// A client for the server at `base_url`. Connecting gives up after
    /// `min(5 s, timeout)`. System proxies are ignored, so requests go straight
    /// to Ollama and never through a proxy. Redirects are never followed:
    /// Ollama does not redirect API calls, and following one could send a
    /// prompt to a host other than the checked `base_url`.
    pub fn new(base_url: Url, timeout: Duration) -> Result<Self, AiError> {
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeout.min(MAX_CONNECT_TIMEOUT))
            .build()
            .map_err(|err| AiError::internal(format!("Could not create the HTTP client: {err}")))?;
        Ok(Self { http, base_url })
    }

    /// The server's base URL, without the trailing `/`.
    pub fn base_url(&self) -> String {
        display_url(&self.base_url)
    }

    /// `GET /api/version`: the server's version string.
    pub async fn version(&self, timeout: Duration) -> Result<String, AiError> {
        #[derive(Deserialize)]
        struct Version {
            version: String,
        }
        let request = self.http.get(self.endpoint("api/version"));
        let version: Version = self.fetch_json(request, timeout, Operation::Query, None).await?;
        Ok(version.version)
    }

    /// `GET /api/tags`: the models in the local store.
    pub async fn tags(&self, timeout: Duration) -> Result<Vec<WireModel>, AiError> {
        #[derive(Deserialize)]
        struct Tags {
            #[serde(default)]
            models: Vec<WireModel>,
        }
        let request = self.http.get(self.endpoint("api/tags"));
        let tags: Tags = self.fetch_json(request, timeout, Operation::Query, None).await?;
        Ok(tags.models)
    }

    /// `GET /api/ps`: the models currently loaded in memory.
    pub async fn ps(&self, timeout: Duration) -> Result<Vec<WireRunningModel>, AiError> {
        #[derive(Deserialize)]
        struct Ps {
            #[serde(default)]
            models: Vec<WireRunningModel>,
        }
        let request = self.http.get(self.endpoint("api/ps"));
        let ps: Ps = self.fetch_json(request, timeout, Operation::Query, None).await?;
        Ok(ps.models)
    }

    /// `POST /api/show`: details of `model`. A missing model is `model_not_installed`.
    pub async fn show(&self, model: &str, timeout: Duration) -> Result<WireShow, AiError> {
        let body = serde_json::json!({ "model": model, "verbose": false });
        let request = self.http.post(self.endpoint("api/show")).json(&body);
        self.fetch_json(request, timeout, Operation::Query, Some(model)).await
    }

    /// `POST /api/chat` with `stream: false`. `timeout` bounds the whole call.
    pub async fn chat(
        &self,
        request: &ChatRequest,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<ChatChunk, AiError> {
        debug_assert!(!request.stream);
        let builder = self.http.post(self.endpoint("api/chat")).json(request);
        let chunk: ChatChunk =
            race(self.fetch_json(builder, timeout, Operation::Inference, Some(&request.model)), Duration::MAX, cancel)
                .await?;
        match chunk.error.as_deref() {
            Some(message) => {
                Err(AiError::from_ollama_message(None, message, Operation::Inference, Some(&request.model)))
            }
            None => Ok(chunk),
        }
    }

    /// `POST /api/chat` with `stream: true`.
    ///
    /// Calls `on_chunk` for every line (including the final one) and returns
    /// the final `done: true` line, which carries the stats. `timeout` bounds
    /// the wait for the first chunk and every gap between chunks.
    pub async fn chat_stream(
        &self,
        request: &ChatRequest,
        timeout: Duration,
        cancel: &CancellationToken,
        mut on_chunk: impl FnMut(&ChatChunk),
    ) -> Result<ChatChunk, AiError> {
        debug_assert!(request.stream);
        let model = Some(request.model.as_str());
        let builder = self.http.post(self.endpoint("api/chat")).json(request);
        let response = race(self.send(builder, Operation::Inference, model), timeout, cancel).await?;

        let mut last = None;
        read_ndjson(response, timeout, cancel, Operation::Inference, model, |chunk: ChatChunk| {
            on_chunk(&chunk);
            let done = chunk.done;
            if done {
                last = Some(chunk);
            }
            done
        })
        .await?;
        last.ok_or_else(|| AiError::stream_ended(Operation::Inference))
    }

    /// `POST /api/pull` with `stream: true`, calling `on_status` for each
    /// progress line until Ollama reports `success`. `idle_timeout` bounds the
    /// gap between lines; there is no overall limit (downloads are large).
    pub async fn pull(
        &self,
        model: &str,
        idle_timeout: Duration,
        cancel: &CancellationToken,
        mut on_status: impl FnMut(&PullStatus),
    ) -> Result<(), AiError> {
        let body = serde_json::json!({ "model": model, "stream": true });
        let builder = self.http.post(self.endpoint("api/pull")).json(&body);
        let response = race(self.send(builder, Operation::Pull, Some(model)), idle_timeout, cancel).await?;
        read_ndjson(response, idle_timeout, cancel, Operation::Pull, Some(model), |status: PullStatus| {
            on_status(&status);
            status.status.as_deref() == Some("success")
        })
        .await
    }

    /// The absolute URL of an API path such as `api/tags`.
    fn endpoint(&self, path: &str) -> Url {
        // The base URL is a validated http origin, so joining a static relative path cannot fail.
        self.base_url.join(path).expect("API paths join onto a validated base URL")
    }

    /// Sends a request, turning transport failures and error statuses into [`AiError`]s.
    async fn send(
        &self,
        request: RequestBuilder,
        operation: Operation,
        model: Option<&str>,
    ) -> Result<Response, AiError> {
        let response =
            request.send().await.map_err(|err| AiError::from_transport(&err, operation, &self.base_url()))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        if status.is_redirection() {
            // Not followed (see `new`): whatever answered is not behaving like Ollama.
            return Err(AiError::unexpected_response(operation).with_status(status.as_u16()));
        }
        let body = response.text().await.unwrap_or_default();
        Err(AiError::from_ollama_response(status.as_u16(), &body, operation, model))
    }

    /// Sends a request and decodes its JSON body, all within `timeout`.
    async fn fetch_json<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
        timeout: Duration,
        operation: Operation,
        model: Option<&str>,
    ) -> Result<T, AiError> {
        let fetch = async {
            let response = self.send(request, operation, model).await?;
            let bytes =
                response.bytes().await.map_err(|err| AiError::from_transport(&err, operation, &self.base_url()))?;
            serde_json::from_slice(&bytes).map_err(|_| AiError::unexpected_response(operation))
        };
        race(fetch, timeout, &CancellationToken::new()).await
    }
}

/// Runs `work` unless `cancel` fires (-> `cancelled`) or `limit` passes (-> `timeout`) first.
async fn race<T>(
    work: impl Future<Output = Result<T, AiError>>,
    limit: Duration,
    cancel: &CancellationToken,
) -> Result<T, AiError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(AiError::cancelled()),
        result = tokio::time::timeout(limit, work) => result.unwrap_or_else(|_| Err(AiError::timeout(limit))),
    }
}

/// A line of an NDJSON stream that may carry an `{"error": "..."}` instead of data.
pub trait NdjsonLine: DeserializeOwned {
    fn error(&self) -> Option<&str>;
}

/// Reads `response` as NDJSON, calling `on_line` for each line until it returns
/// `true` (finished). Fails when an `error` line arrives, when no data arrives
/// for `idle`, when `cancel` fires, or when the stream ends before `on_line`
/// reports the end.
async fn read_ndjson<T: NdjsonLine>(
    response: Response,
    idle: Duration,
    cancel: &CancellationToken,
    operation: Operation,
    model: Option<&str>,
    mut on_line: impl FnMut(T) -> bool,
) -> Result<(), AiError> {
    let mut body = response.bytes_stream();
    let mut lines = LineBuffer::default();
    let mut handle = |line: &[u8]| -> Result<bool, AiError> {
        let line = line.trim_ascii();
        if line.is_empty() {
            return Ok(false);
        }
        let parsed: T = serde_json::from_slice(line).map_err(|_| AiError::unexpected_response(operation))?;
        if let Some(message) = parsed.error() {
            return Err(AiError::from_ollama_message(None, message, operation, model));
        }
        Ok(on_line(parsed))
    };

    loop {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(AiError::cancelled()),
            next = tokio::time::timeout(idle, body.next()) => next.map_err(|_| AiError::timeout(idle))?,
        };
        match next {
            Some(Ok(bytes)) => {
                lines.push(&bytes);
                while let Some(line) = lines.next_line() {
                    if handle(&line)? {
                        return Ok(());
                    }
                }
            }
            Some(Err(err)) => return Err(AiError::from_transport(&err, operation, "Ollama")),
            None => {
                // A final line without a trailing newline still counts.
                if let Some(rest) = lines.take_rest()
                    && handle(&rest)?
                {
                    return Ok(());
                }
                return Err(AiError::stream_ended(operation));
            }
        }
    }
}

/// Splits a byte stream into `\n`-terminated lines, keeping partial lines
/// until the rest arrives.
#[derive(Debug, Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    /// Appends newly received bytes.
    pub fn push(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
    }

    /// Removes and returns the next complete line, without its `\n`.
    pub fn next_line(&mut self) -> Option<Vec<u8>> {
        let end = self.pending.iter().position(|&byte| byte == b'\n')?;
        let mut line: Vec<u8> = self.pending.drain(..=end).collect();
        line.pop();
        Some(line)
    }

    /// Returns the unterminated remainder, if it holds anything but whitespace.
    pub fn take_rest(&mut self) -> Option<Vec<u8>> {
        let rest = std::mem::take(&mut self.pending);
        (!rest.trim_ascii().is_empty()).then_some(rest)
    }
}

// ---- Wire types: Ollama's JSON. Every field is optional or defaulted, because
// ---- the API is unversioned and adds fields over time.

/// An entry of `/api/tags`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WireModel {
    pub name: String,
    pub modified_at: Option<String>,
    pub size: u64,
    pub details: WireDetails,
    /// Set for cloud models, which run on that host instead of this machine,
    /// whatever their local name (`ollama cp` or a Modelfile can alias one).
    pub remote_host: Option<String>,
    /// The model's name on `remote_host`, also only set for cloud models.
    pub remote_model: Option<String>,
}

impl WireModel {
    /// Whether this entry runs somewhere else (a cloud model), judged by the
    /// remote fields Ollama reports and by the tag name.
    pub fn is_remote(&self) -> bool {
        self.remote_host.is_some() || self.remote_model.is_some() || super::model::is_cloud(&self.name)
    }
}

/// The `details` object of `/api/tags`, `/api/ps` and `/api/show`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WireDetails {
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
    /// Only on newer servers.
    pub context_length: Option<u64>,
}

/// An entry of `/api/ps`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WireRunningModel {
    pub name: String,
}

/// The parts of `/api/show` this app uses.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WireShow {
    pub details: WireDetails,
    pub model_info: serde_json::Map<String, Value>,
    pub capabilities: Vec<String>,
}

impl WireShow {
    /// The native context length: `model_info["<architecture>.context_length"]`,
    /// falling back to `details.context_length`.
    pub fn context_length(&self) -> Option<u64> {
        let architecture = self.model_info.get("general.architecture").and_then(Value::as_str);
        architecture
            .and_then(|arch| self.model_info.get(&format!("{arch}.context_length")))
            .and_then(Value::as_u64)
            .or(self.details.context_length)
    }
}

/// The body of `POST /api/chat`.
#[derive(Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<OllamaOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub think: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<Value>,
}

/// One chat message.
#[derive(Clone, Serialize)]
pub struct ChatMessage {
    pub role: &'static str,
    pub content: String,
}

/// Ollama's `options` object (snake_case names).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OllamaOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_predict: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_ctx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_penalty: Option<f64>,
}

/// A `/api/chat` response object, or one line of its stream.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChatChunk {
    pub model: Option<String>,
    pub message: Option<ChatChunkMessage>,
    pub done: bool,
    pub done_reason: Option<String>,
    /// Durations are in nanoseconds.
    pub total_duration: Option<u64>,
    pub load_duration: Option<u64>,
    pub prompt_eval_count: Option<u64>,
    pub prompt_eval_duration: Option<u64>,
    pub eval_count: Option<u64>,
    pub eval_duration: Option<u64>,
    pub error: Option<String>,
}

/// The `message` of a chat chunk.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChatChunkMessage {
    pub content: String,
    pub thinking: Option<String>,
}

impl NdjsonLine for ChatChunk {
    fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

/// One progress line of `/api/pull`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PullStatus {
    pub status: Option<String>,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
    pub error: Option<String>,
}

impl NdjsonLine for PullStatus {
    fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn line_buffer_reassembles_split_lines() {
        let mut lines = LineBuffer::default();
        lines.push(b"{\"a\":");
        assert_eq!(lines.next_line(), None);
        lines.push(b"1}\n{\"b\":2}\n{\"c\"");
        assert_eq!(lines.next_line().unwrap(), b"{\"a\":1}");
        assert_eq!(lines.next_line().unwrap(), b"{\"b\":2}");
        assert_eq!(lines.next_line(), None);
        lines.push(b":3}\r\n");
        assert_eq!(lines.next_line().unwrap(), b"{\"c\":3}\r");
        assert_eq!(lines.take_rest(), None);
    }

    #[test]
    fn line_buffer_keeps_an_unterminated_last_line() {
        let mut lines = LineBuffer::default();
        lines.push(b"{\"done\":true}");
        assert_eq!(lines.next_line(), None);
        assert_eq!(lines.take_rest().unwrap(), b"{\"done\":true}");
        lines.push(b"  \n");
        lines.next_line();
        assert_eq!(lines.take_rest(), None);
    }

    #[test]
    fn line_buffer_handles_multibyte_characters_split_across_chunks() {
        let text = "{\"content\":\"héllo 🙂\"}\n".as_bytes();
        let mut lines = LineBuffer::default();
        for byte in text {
            lines.push(std::slice::from_ref(byte));
        }
        let line = lines.next_line().unwrap();
        let chunk: ChatChunkMessage = serde_json::from_slice(&line).unwrap();
        assert_eq!(chunk.content, "héllo 🙂");
    }

    #[test]
    fn chat_chunks_tolerate_missing_and_unknown_fields() {
        let chunk: ChatChunk = serde_json::from_value(json!({
            "model": "qwen3.5:9b", "created_at": "2026-11-13T19:32:57Z",
            "message": { "role": "assistant", "content": "1" }, "done": false, "new_field": [1, 2],
        }))
        .unwrap();
        assert_eq!(chunk.message.unwrap().content, "1");
        assert!(!chunk.done);

        let error: ChatChunk = serde_json::from_value(json!({ "error": "boom" })).unwrap();
        assert_eq!(NdjsonLine::error(&error), Some("boom"));
    }

    #[test]
    fn show_reads_the_architecture_context_length() {
        let show: WireShow = serde_json::from_value(json!({
            "details": { "family": "qwen35", "context_length": 4096 },
            "model_info": { "general.architecture": "qwen35", "qwen35.context_length": 262_144 },
            "capabilities": ["completion", "thinking"],
        }))
        .unwrap();
        assert_eq!(show.context_length(), Some(262_144));

        let fallback: WireShow = serde_json::from_value(json!({ "details": { "context_length": 8192 } })).unwrap();
        assert_eq!(fallback.context_length(), Some(8192));
    }

    #[test]
    fn options_serialize_with_ollama_names() {
        let options =
            OllamaOptions { top_p: Some(0.9), num_predict: Some(32), repeat_penalty: Some(1.1), ..Default::default() };
        assert_eq!(
            serde_json::to_value(options).unwrap(),
            json!({ "top_p": 0.9, "num_predict": 32, "repeat_penalty": 1.1 })
        );
    }
}
