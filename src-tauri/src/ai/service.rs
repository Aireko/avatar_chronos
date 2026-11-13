//! [`AiService`]: the one entry point for local inference.
//!
//! It owns the configuration, the Ollama client, the selected model and the
//! registry of running requests (so they can be cancelled by id). It is cheap
//! to clone (everything lives behind an `Arc`) and safe to share across tasks.
//!
//! Limits: at most [`MAX_CONCURRENT_GENERATIONS`] generations and
//! [`MAX_CONCURRENT_PULLS`] download at a time; more are rejected as `busy`.
//!
//! Local only: before every generation, the model is looked up in Ollama's
//! `/api/tags`. A model Ollama marks as remote (`remote_host`, i.e. a cloud
//! model, even under a local-looking alias made with `ollama cp` or a
//! Modelfile) is rejected as `unsupported_model`, so prompts never reach it.
//!
//! Privacy: nothing here logs prompts, outputs or file contents. At most one
//! line of metadata (request id, model, outcome, duration) goes to stderr.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::client::{ChatChunk, ChatMessage, ChatRequest, OllamaClient, OllamaOptions, WireModel};
use super::config::{self, AiConfig, ConfigError};
use super::error::{AiError, AiErrorKind};
use super::model::{self, DEFAULT_MODEL, KNOWN_QWEN35_TAGS};
use super::types::{
    AiStatus, ConnectionStatus, GenerateRequest, GenerateResponse, GenerationOptions, GenerationStats, ModelInfo,
    ModelSummary, PullEvent, PullSummary, StreamEvent,
};

/// Generations that may run at once (Ollama itself runs one at a time by default).
pub const MAX_CONCURRENT_GENERATIONS: usize = 2;
/// Model downloads that may run at once.
pub const MAX_CONCURRENT_PULLS: usize = 1;
/// Upper bound for quick metadata calls (version, tags, show, ps).
const QUERY_TIMEOUT_CAP: Duration = Duration::from_secs(5);
/// How long a cancel for a request id that is not running yet is remembered,
/// so a cancel that overtakes its own request still cancels it.
const PENDING_CANCEL_TTL: Duration = Duration::from_secs(10);
/// Most early cancels remembered at once (older ones are dropped first).
const MAX_PENDING_CANCELS: usize = 256;
/// Lower bound for the gap between two download progress lines.
const MIN_PULL_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// Longest accepted request id.
const MAX_REQUEST_ID_LEN: usize = 64;
/// Most stop sequences per request, and longest stop sequence (characters).
const MAX_STOP_SEQUENCES: usize = 8;
const MAX_STOP_SEQUENCE_CHARS: usize = 64;

/// Local inference through Ollama. Register it with `.manage(AiService::from_env())`.
#[derive(Clone)]
pub struct AiService {
    inner: Arc<Inner>,
}

struct Inner {
    /// The validated config and its client, or why the config is unusable.
    ready: Result<Ready, AiError>,
    /// The base URL to show while the config is invalid.
    raw_base_url: String,
    /// The model used when a request names none. In memory only.
    selected_model: RwLock<String>,
    /// Running generations and downloads, and early cancels.
    registry: Mutex<Registry>,
    /// Whether an Ollama binary exists on this machine (replaced in tests).
    install_probe: fn() -> bool,
    /// Counter for generated request ids.
    next_id: AtomicU64,
}

struct Ready {
    config: AiConfig,
    client: OllamaClient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestKind {
    Generation,
    Pull,
}

struct ActiveRequest {
    kind: RequestKind,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Registry {
    /// Running generations and downloads, by request id.
    active: HashMap<String, ActiveRequest>,
    /// Cancels that arrived before their request registered (`ai_generate`
    /// and `ai_cancel` are separate IPC calls and can overtake each other),
    /// with the time they arrived.
    pending_cancels: HashMap<String, Instant>,
}

impl Registry {
    /// Remembers a cancel for `request_id`, which is not running (yet).
    fn remember_cancel(&mut self, request_id: &str) {
        let now = Instant::now();
        self.pending_cancels.retain(|_, at| now.duration_since(*at) < PENDING_CANCEL_TTL);
        if self.pending_cancels.len() >= MAX_PENDING_CANCELS
            && let Some(oldest) = self.pending_cancels.iter().min_by_key(|(_, at)| **at).map(|(id, _)| id.clone())
        {
            self.pending_cancels.remove(&oldest);
        }
        self.pending_cancels.insert(request_id.to_owned(), now);
    }

    /// Whether a recent cancel is waiting for `request_id` (consumes it).
    fn take_pending_cancel(&mut self, request_id: &str) -> bool {
        self.pending_cancels.remove(request_id).is_some_and(|at| at.elapsed() < PENDING_CANCEL_TTL)
    }
}

impl AiService {
    /// A service using a validated config.
    pub fn new(config: AiConfig) -> Self {
        let raw_base_url = config.base_url_display();
        Self::build(Ok(config), raw_base_url, detect_ollama_installed)
    }

    /// A service configured from the `OLLAMA_*` environment variables. Never
    /// panics: with an invalid config, every call fails with `invalid_config`
    /// (and [`AiService::status`] reports it).
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Like [`AiService::from_env`], reading variables through `lookup`.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let raw_base_url = config::raw_base_url(&lookup);
        Self::build(AiConfig::from_lookup(lookup), raw_base_url, detect_ollama_installed)
    }

    fn build(config: Result<AiConfig, ConfigError>, raw_base_url: String, install_probe: fn() -> bool) -> Self {
        let ready = config.map_err(|err| AiError::invalid_config(&err)).and_then(|config| {
            let client = OllamaClient::new(config.base_url.clone(), config.timeout)?;
            Ok(Ready { config, client })
        });
        if let Err(err) = &ready {
            eprintln!("[ai] configuration error: {}", err.message);
        }
        let selected = ready.as_ref().map_or(DEFAULT_MODEL, |ready| ready.config.model.as_str()).to_owned();
        Self {
            inner: Arc::new(Inner {
                ready,
                raw_base_url,
                selected_model: RwLock::new(selected),
                registry: Mutex::new(Registry::default()),
                install_probe,
                next_id: AtomicU64::new(1),
            }),
        }
    }

    /// Replaces the "is Ollama installed?" check (tests only).
    #[cfg(test)]
    pub(crate) fn with_install_probe(config: AiConfig, install_probe: fn() -> bool) -> Self {
        let raw_base_url = config.base_url_display();
        Self::build(Ok(config), raw_base_url, install_probe)
    }

    /// The active configuration, or the `invalid_config` error.
    pub fn config(&self) -> Result<&AiConfig, AiError> {
        self.ready().map(|ready| &ready.config)
    }

    /// The model used when a request names none.
    pub fn selected_model(&self) -> String {
        self.inner.selected_model.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Number of generations currently running.
    pub fn active_generations(&self) -> usize {
        self.count_active(RequestKind::Generation)
    }

    /// Everything the UI shows: connection, models, selection and config errors.
    /// Never fails; problems are reported inside the status.
    pub async fn status(&self) -> AiStatus {
        let selected_model = self.selected_model();
        let base = AiStatus {
            connection: ConnectionStatus {
                reachable: false,
                version: None,
                installed: None,
                base_url: self.inner.raw_base_url.clone(),
                is_local: false,
                error: None,
            },
            config_error: None,
            configured_model: selected_model.clone(),
            selected_model,
            selected_model_installed: None,
            installed_qwen35_models: Vec::new(),
            loaded_models: Vec::new(),
            active_generations: self.active_generations(),
            known_qwen35_tags: KNOWN_QWEN35_TAGS,
            local_only: false,
        };
        let ready = match self.ready() {
            Ok(ready) => ready,
            Err(err) => {
                let mut status = base;
                status.connection.error = Some(err.clone());
                status.config_error = Some(err);
                return status;
            }
        };

        let connection = self.probe_connection(ready).await;
        let local_only = connection.is_local;
        let mut status = AiStatus { configured_model: ready.config.model.clone(), connection, local_only, ..base };
        if !status.connection.reachable {
            return status;
        }
        let timeout = self.query_timeout();
        let (tags, ps) = tokio::join!(ready.client.tags(timeout), ready.client.ps(timeout));
        if let Ok(models) = tags {
            status.selected_model_installed = Some(find_local(&models, &status.selected_model).is_some());
            // A cloud model under a local-looking name: generation with it is refused.
            let remote = [&status.selected_model, &status.configured_model]
                .into_iter()
                .find(|name| listed_as_remote(&models, name))
                .cloned();
            if let Some(name) = remote {
                status.config_error = Some(remote_model_error(&name));
            }
            status.installed_qwen35_models =
                models.iter().map(model_summary).filter(|summary| summary.is_qwen35 && !summary.is_cloud).collect();
        }
        if let Ok(running) = ps {
            status.loaded_models = running.into_iter().map(|model| model.name).collect();
        }
        status
    }

    /// Checks whether Ollama answers. An unreachable server is reported in the
    /// returned status (with `error`), not as an `Err`.
    pub async fn check_connection(&self) -> Result<ConnectionStatus, AiError> {
        let ready = self.ready()?;
        Ok(self.probe_connection(ready).await)
    }

    /// All models in Ollama's local store, flagged as Qwen 3.5 and/or cloud.
    pub async fn list_models(&self) -> Result<Vec<ModelSummary>, AiError> {
        let ready = self.ready()?;
        let models = ready.client.tags(self.query_timeout()).await.map_err(|err| self.explain(err))?;
        Ok(models.iter().map(model_summary).collect())
    }

    /// Details of `model` (default: the selected model). Like every other
    /// model-taking call, it only accepts local Qwen 3.5 tags.
    pub async fn get_model_info(&self, model: Option<String>) -> Result<ModelInfo, AiError> {
        let ready = self.ready()?;
        let name = model.unwrap_or_else(|| self.selected_model());
        model::ensure_supported(&name, "model")?;
        let show = ready.client.show(&name, self.query_timeout()).await.map_err(|err| self.explain(err))?;
        Ok(ModelInfo {
            context_length: show.context_length(),
            family: show.details.family,
            parameter_size: show.details.parameter_size,
            quantization: show.details.quantization_level,
            supports_thinking: show.capabilities.iter().any(|capability| capability == "thinking"),
            capabilities: show.capabilities,
            name,
        })
    }

    /// Makes `model` the default for requests that name none. It must be a
    /// well-formed, local (non-cloud) Qwen 3.5 tag that is installed; nothing
    /// is ever substituted. Returns the name as Ollama lists it.
    pub async fn select_model(&self, model: String) -> Result<String, AiError> {
        let ready = self.ready()?;
        model::ensure_supported(&model, "model")?;
        let models = ready.client.tags(self.query_timeout()).await.map_err(|err| self.explain(err))?;
        if listed_as_remote(&models, &model) {
            return Err(remote_model_error(&model));
        }
        let installed = find_local(&models, &model).ok_or_else(|| AiError::model_not_installed(&model))?;
        let name = installed.name.clone();
        *self.inner.selected_model.write().unwrap_or_else(PoisonError::into_inner) = name.clone();
        Ok(name)
    }

    /// Downloads `model` (default: the selected model) with Ollama, reporting
    /// progress through `on_progress`. Only local Qwen 3.5 tags are allowed.
    /// Only ever called on an explicit user action, never automatically.
    pub async fn pull_model(
        &self,
        model: Option<String>,
        request_id: String,
        mut on_progress: impl FnMut(PullEvent),
    ) -> Result<PullSummary, AiError> {
        let started = Instant::now();
        let model = model.unwrap_or_else(|| self.selected_model());
        let result = self.run_pull(&model, &request_id, &mut on_progress).await;
        match &result {
            Ok(summary) => on_progress(PullEvent::Done { model: summary.model.clone() }),
            Err(err) if err.kind == AiErrorKind::Cancelled => {
                on_progress(PullEvent::Cancelled { request_id: request_id.clone() });
            }
            Err(err) => on_progress(PullEvent::Error { error: err.clone() }),
        }
        log_outcome("pull", &request_id, &model, &result, started);
        result
    }

    /// Generates a complete answer in one response.
    pub async fn generate(&self, request: GenerateRequest) -> Result<GenerateResponse, AiError> {
        let started = Instant::now();
        let request_id = self.resolve_request_id(&request);
        let result = self.run_generate(&request, &request_id).await;
        log_outcome("generate", &request_id, &self.model_for_log(&request), &result, started);
        result
    }

    /// Generates an answer, reporting it piece by piece through `on_event`:
    /// `started`, then `delta`s, then exactly one of `done`, `cancelled` or
    /// `error`. Resolves with the same response as `done`, or rejects with
    /// the same error as `error` (kind `cancelled` after `cancelled`).
    pub async fn generate_stream(
        &self,
        request: GenerateRequest,
        mut on_event: impl FnMut(StreamEvent),
    ) -> Result<GenerateResponse, AiError> {
        let started = Instant::now();
        let request_id = self.resolve_request_id(&request);
        let result = self.run_generate_stream(&request, &request_id, &mut on_event).await;
        match &result {
            Ok(response) => on_event(StreamEvent::Done { response: response.clone() }),
            Err(err) if err.kind == AiErrorKind::Cancelled => {
                on_event(StreamEvent::Cancelled { request_id: request_id.clone() });
            }
            Err(err) => on_event(StreamEvent::Error { error: err.clone() }),
        }
        log_outcome("stream", &request_id, &self.model_for_log(&request), &result, started);
        result
    }

    /// The model a request runs on: its own, or the selected one.
    fn model_for_log(&self, request: &GenerateRequest) -> String {
        request.model.clone().unwrap_or_else(|| self.selected_model())
    }

    /// Cancels the running generation or download `request_id`. Returns
    /// whether such a request was running.
    ///
    /// A cancel for an id that is not running is remembered for a few
    /// seconds: if a request with that id starts in that time, it fails at
    /// once with `cancelled`. This covers a cancel that overtakes its own
    /// request (they are separate IPC calls).
    pub fn cancel(&self, request_id: &str) -> bool {
        let mut registry = self.lock_registry();
        match registry.active.get(request_id) {
            Some(request) => {
                request.cancel.cancel();
                true
            }
            None => {
                if validate_request_id(request_id).is_ok() {
                    registry.remember_cancel(request_id);
                }
                false
            }
        }
    }

    // ---- internals ----

    fn ready(&self) -> Result<&Ready, AiError> {
        self.inner.ready.as_ref().map_err(Clone::clone)
    }

    fn lock_registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.inner.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Timeout for metadata calls: `min(5 s, OLLAMA_TIMEOUT)`.
    fn query_timeout(&self) -> Duration {
        self.config().map_or(QUERY_TIMEOUT_CAP, |config| config.timeout.min(QUERY_TIMEOUT_CAP))
    }

    async fn probe_connection(&self, ready: &Ready) -> ConnectionStatus {
        let is_local = ready.config.is_local();
        let base_url = ready.client.base_url();
        match ready.client.version(self.query_timeout()).await {
            Ok(version) => ConnectionStatus {
                reachable: true,
                version: Some(version),
                // A local server that answers is installed, whatever its install path.
                installed: is_local.then_some(true),
                base_url,
                is_local,
                error: None,
            },
            Err(err) => {
                let installed = is_local.then(|| (self.inner.install_probe)());
                let error = upgrade_unreachable(err, installed, &base_url);
                ConnectionStatus { reachable: false, version: None, installed, base_url, is_local, error: Some(error) }
            }
        }
    }

    /// Turns "unreachable" into "not installed" when no Ollama binary exists here.
    fn explain(&self, err: AiError) -> AiError {
        if err.kind != AiErrorKind::OllamaUnreachable {
            return err;
        }
        match self.ready() {
            Ok(ready) if ready.config.is_local() => {
                upgrade_unreachable(err, Some((self.inner.install_probe)()), &ready.client.base_url())
            }
            _ => err,
        }
    }

    fn resolve_request_id(&self, request: &GenerateRequest) -> String {
        request.request_id.clone().unwrap_or_else(|| {
            let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
            let counter = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
            format!("gen-{millis}-{counter}")
        })
    }

    /// Validates `request` and builds the Ollama request for it.
    fn prepare(
        &self,
        request: &GenerateRequest,
        request_id: &str,
        stream: bool,
    ) -> Result<(&Ready, ChatRequest), AiError> {
        let ready = self.ready()?;
        validate_request_id(request_id)?;
        validate_request(request, ready.config.max_prompt_bytes)?;
        let model = match &request.model {
            Some(model) => {
                model::ensure_supported(model, "model")?;
                model.clone()
            }
            None => self.selected_model(),
        };
        Ok((ready, build_chat_request(request, model, stream)))
    }

    /// Rejects `model` when Ollama lists it as a remote (cloud) model, whatever
    /// its name. Checked before every generation, for an explicit model as well
    /// as the selected / `OLLAMA_MODEL` default, because an alias can change
    /// outside the app. A model that is not listed passes; `/api/chat` then
    /// reports it as `model_not_installed`.
    async fn ensure_local_model(&self, ready: &Ready, model: &str) -> Result<(), AiError> {
        let models = ready.client.tags(self.query_timeout()).await.map_err(|err| self.explain(err))?;
        if listed_as_remote(&models, model) {
            return Err(remote_model_error(model));
        }
        Ok(())
    }

    async fn run_generate(&self, request: &GenerateRequest, request_id: &str) -> Result<GenerateResponse, AiError> {
        let (ready, chat) = self.prepare(request, request_id, false)?;
        let guard = self.register(request_id, RequestKind::Generation)?;
        unless_cancelled(&guard.cancel, self.ensure_local_model(ready, &chat.model)).await?;
        let chunk =
            ready.client.chat(&chat, ready.config.timeout, &guard.cancel).await.map_err(|err| self.explain(err))?;
        let message = chunk.message.clone().unwrap_or_default();
        Ok(build_response(request_id, &chat.model, message.content, message.thinking.unwrap_or_default(), &chunk))
    }

    async fn run_generate_stream(
        &self,
        request: &GenerateRequest,
        request_id: &str,
        on_event: &mut impl FnMut(StreamEvent),
    ) -> Result<GenerateResponse, AiError> {
        let (ready, chat) = self.prepare(request, request_id, true)?;
        let guard = self.register(request_id, RequestKind::Generation)?;
        unless_cancelled(&guard.cancel, self.ensure_local_model(ready, &chat.model)).await?;
        on_event(StreamEvent::Started { request_id: request_id.to_owned(), model: chat.model.clone() });

        let mut content = String::new();
        let mut thinking = String::new();
        let last = ready
            .client
            .chat_stream(&chat, ready.config.timeout, &guard.cancel, |chunk| {
                let Some(message) = &chunk.message else { return };
                let new_thinking = message.thinking.as_deref().filter(|text| !text.is_empty());
                if message.content.is_empty() && new_thinking.is_none() {
                    return;
                }
                content.push_str(&message.content);
                thinking.push_str(new_thinking.unwrap_or_default());
                on_event(StreamEvent::Delta {
                    content: message.content.clone(),
                    thinking: new_thinking.map(str::to_owned),
                });
            })
            .await
            .map_err(|err| self.explain(err))?;
        Ok(build_response(request_id, &chat.model, content, thinking, &last))
    }

    async fn run_pull(
        &self,
        model: &str,
        request_id: &str,
        on_progress: &mut impl FnMut(PullEvent),
    ) -> Result<PullSummary, AiError> {
        let ready = self.ready()?;
        validate_request_id(request_id)?;
        model::ensure_supported(model, "model")?;
        let guard = self.register(request_id, RequestKind::Pull)?;
        on_progress(PullEvent::Started { request_id: request_id.to_owned(), model: model.to_owned() });

        let idle_timeout = ready.config.timeout.max(MIN_PULL_IDLE_TIMEOUT);
        ready
            .client
            .pull(model, idle_timeout, &guard.cancel, |line| {
                let percent = match (line.completed, line.total) {
                    (Some(completed), Some(total)) if total > 0 => {
                        Some(round2(completed as f64 * 100.0 / total as f64))
                    }
                    _ => None,
                };
                on_progress(PullEvent::Progress {
                    status: line.status.clone().unwrap_or_default(),
                    digest: line.digest.clone(),
                    total: line.total,
                    completed: line.completed,
                    percent,
                });
            })
            .await
            .map_err(|err| self.explain(err))?;
        Ok(PullSummary { model: model.to_owned(), status: "success".to_owned() })
    }

    /// Adds `request_id` to the registry, enforcing uniqueness and the
    /// concurrency limits. The entry is removed when the guard is dropped.
    /// Fails with `cancelled` when a cancel for this id arrived just before.
    fn register(&self, request_id: &str, kind: RequestKind) -> Result<ActiveGuard, AiError> {
        let mut registry = self.lock_registry();
        if registry.take_pending_cancel(request_id) {
            return Err(AiError::cancelled());
        }
        let active = &mut registry.active;
        if active.contains_key(request_id) {
            return Err(AiError::invalid_request(
                "requestId",
                format!("'{request_id}' already belongs to a running request"),
            ));
        }
        let running = active.values().filter(|request| request.kind == kind).count();
        match kind {
            RequestKind::Generation if running >= MAX_CONCURRENT_GENERATIONS => {
                return Err(AiError::busy(format!("{MAX_CONCURRENT_GENERATIONS} generations are already running")));
            }
            RequestKind::Pull if running >= MAX_CONCURRENT_PULLS => {
                return Err(AiError::busy("A model download is already running"));
            }
            _ => {}
        }
        let cancel = CancellationToken::new();
        active.insert(request_id.to_owned(), ActiveRequest { kind, cancel: cancel.clone() });
        Ok(ActiveGuard { inner: Arc::clone(&self.inner), request_id: request_id.to_owned(), cancel })
    }

    fn count_active(&self, kind: RequestKind) -> usize {
        self.lock_registry().active.values().filter(|request| request.kind == kind).count()
    }

    /// Number of registered requests of any kind (tests check cleanup with it).
    #[cfg(test)]
    pub(crate) fn registry_len(&self) -> usize {
        self.lock_registry().active.len()
    }
}

/// Removes its request from the registry when dropped, however the request ends.
struct ActiveGuard {
    inner: Arc<Inner>,
    request_id: String,
    cancel: CancellationToken,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.inner.registry.lock().unwrap_or_else(PoisonError::into_inner).active.remove(&self.request_id);
    }
}

/// Whether an Ollama binary is on `PATH` or in a known install location.
pub fn detect_ollama_installed() -> bool {
    let binary = if cfg!(windows) { "ollama.exe" } else { "ollama" };
    let on_path = std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(binary).is_file()));
    on_path || known_install_locations().iter().any(|path| path.exists())
}

/// Where the official installers put Ollama.
fn known_install_locations() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> =
        ["/usr/local/bin/ollama", "/usr/bin/ollama", "/opt/homebrew/bin/ollama", "/Applications/Ollama.app"]
            .into_iter()
            .map(PathBuf::from)
            .collect();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        paths.push(PathBuf::from(local_app_data).join("Programs").join("Ollama").join("ollama.exe"));
    }
    paths
}

/// `ollama_unreachable` becomes `ollama_not_installed` when `installed == Some(false)`.
fn upgrade_unreachable(err: AiError, installed: Option<bool>, base_url: &str) -> AiError {
    if err.kind == AiErrorKind::OllamaUnreachable && installed == Some(false) {
        AiError::not_installed(base_url)
    } else {
        err
    }
}

/// Runs `work` unless `cancel` fires first (-> `cancelled`).
async fn unless_cancelled<T>(
    cancel: &CancellationToken,
    work: impl Future<Output = Result<T, AiError>>,
) -> Result<T, AiError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(AiError::cancelled()),
        result = work => result,
    }
}

/// The installed, local (non-cloud) entry of `models` that is `name`.
fn find_local<'a>(models: &'a [WireModel], name: &str) -> Option<&'a WireModel> {
    models.iter().find(|model| !model.is_remote() && model::same_model(&model.name, name))
}

/// Whether `models` lists `name` as a remote (cloud) model.
fn listed_as_remote(models: &[WireModel], name: &str) -> bool {
    models.iter().any(|model| model.is_remote() && model::same_model(&model.name, name))
}

/// The error for a model that Ollama would run on a remote host.
fn remote_model_error(name: &str) -> AiError {
    AiError::unsupported_model(
        name,
        "Ollama lists it as a cloud model that runs on a remote host (ollama.com), not on this machine",
    )
}

fn model_summary(model: &WireModel) -> ModelSummary {
    ModelSummary {
        name: model.name.clone(),
        size_bytes: model.size,
        parameter_size: model.details.parameter_size.clone(),
        quantization: model.details.quantization_level.clone(),
        family: model.details.family.clone(),
        context_length: model.details.context_length,
        modified_at: model.modified_at.clone(),
        is_qwen35: model::is_qwen35(&model.name),
        is_cloud: model.is_remote(),
    }
}

/// Checks a caller-supplied request id: 1..=64 characters of `[A-Za-z0-9_-]`.
pub fn validate_request_id(request_id: &str) -> Result<(), AiError> {
    let valid_chars = request_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if request_id.is_empty() || request_id.len() > MAX_REQUEST_ID_LEN || !valid_chars {
        return Err(AiError::invalid_request(
            "requestId",
            format!("must be 1 to {MAX_REQUEST_ID_LEN} characters of A-Z, a-z, 0-9, _ or -"),
        ));
    }
    Ok(())
}

/// Checks the prompt, its size, the options and the format. Error messages
/// name the field and never quote the prompt.
pub fn validate_request(request: &GenerateRequest, max_prompt_bytes: usize) -> Result<(), AiError> {
    if request.prompt.trim().is_empty() {
        return Err(AiError::invalid_request("prompt", "must not be empty"));
    }
    let bytes = request.prompt.len() + request.system.as_ref().map_or(0, String::len);
    if bytes > max_prompt_bytes {
        return Err(AiError::invalid_request(
            "prompt",
            format!(
                "system + prompt is {bytes} bytes, more than the limit of {max_prompt_bytes} bytes (OLLAMA_MAX_PROMPT_BYTES)"
            ),
        ));
    }
    if let Some(options) = &request.options {
        validate_options(options)?;
    }
    if let Some(format) = &request.format {
        validate_format(format)?;
    }
    Ok(())
}

fn validate_options(options: &GenerationOptions) -> Result<(), AiError> {
    check_float("options.temperature", options.temperature, 0.0, 2.0)?;
    check_float("options.topP", options.top_p, 0.0, 1.0)?;
    check_float("options.repeatPenalty", options.repeat_penalty, 0.0, 2.0)?;
    check_int("options.topK", options.top_k, 1, 1000)?;
    check_int("options.numCtx", options.num_ctx, 512, 262_144)?;
    if let Some(num_predict) = options.num_predict
        && num_predict != -1
        && !(1..=32_768).contains(&num_predict)
    {
        return Err(AiError::invalid_request(
            "options.numPredict",
            format!("must be -1 or 1 to 32768 (got {num_predict})"),
        ));
    }
    if let Some(stop) = &options.stop {
        if stop.len() > MAX_STOP_SEQUENCES {
            return Err(AiError::invalid_request(
                "options.stop",
                format!("at most {MAX_STOP_SEQUENCES} entries are allowed"),
            ));
        }
        if let Some(index) =
            stop.iter().position(|entry| entry.is_empty() || entry.chars().count() > MAX_STOP_SEQUENCE_CHARS)
        {
            return Err(AiError::invalid_request(
                "options.stop",
                format!("entry {index} must be 1 to {MAX_STOP_SEQUENCE_CHARS} characters"),
            ));
        }
    }
    Ok(())
}

fn check_float(field: &str, value: Option<f64>, min: f64, max: f64) -> Result<(), AiError> {
    match value {
        // `contains` is false for NaN, so NaN is rejected too.
        Some(value) if !(min..=max).contains(&value) => {
            Err(AiError::invalid_request(field, format!("must be between {min} and {max} (got {value})")))
        }
        _ => Ok(()),
    }
}

fn check_int(field: &str, value: Option<i64>, min: i64, max: i64) -> Result<(), AiError> {
    match value {
        Some(value) if !(min..=max).contains(&value) => {
            Err(AiError::invalid_request(field, format!("must be between {min} and {max} (got {value})")))
        }
        _ => Ok(()),
    }
}

/// `format` must be `"json"` or a JSON Schema object.
fn validate_format(format: &Value) -> Result<(), AiError> {
    match format {
        Value::String(text) if text == "json" => Ok(()),
        Value::Object(_) => Ok(()),
        _ => Err(AiError::invalid_request("format", "must be \"json\" or a JSON Schema object")),
    }
}

/// Builds the `/api/chat` body: an optional system message, then the prompt.
fn build_chat_request(request: &GenerateRequest, model: String, stream: bool) -> ChatRequest {
    let mut messages = Vec::with_capacity(2);
    if let Some(system) = request.system.as_ref().filter(|system| !system.trim().is_empty()) {
        messages.push(ChatMessage { role: "system", content: system.clone() });
    }
    messages.push(ChatMessage { role: "user", content: request.prompt.clone() });
    ChatRequest {
        model,
        messages,
        stream,
        options: request.options.as_ref().map(ollama_options).filter(|options| *options != OllamaOptions::default()),
        think: request.think,
        format: request.format.clone(),
    }
}

/// Maps camelCase options to Ollama's snake_case names.
fn ollama_options(options: &GenerationOptions) -> OllamaOptions {
    OllamaOptions {
        temperature: options.temperature,
        top_p: options.top_p,
        top_k: options.top_k,
        num_predict: options.num_predict,
        num_ctx: options.num_ctx,
        seed: options.seed,
        stop: options.stop.clone().filter(|stop| !stop.is_empty()),
        repeat_penalty: options.repeat_penalty,
    }
}

fn build_response(
    request_id: &str,
    model: &str,
    content: String,
    thinking: String,
    last: &ChatChunk,
) -> GenerateResponse {
    GenerateResponse {
        request_id: request_id.to_owned(),
        model: last.model.clone().filter(|name| !name.is_empty()).unwrap_or_else(|| model.to_owned()),
        content,
        thinking: (!thinking.is_empty()).then_some(thinking),
        done_reason: last.done_reason.clone(),
        stats: stats(last),
    }
}

/// Converts Ollama's nanosecond durations to milliseconds and derives tokens/s.
fn stats(last: &ChatChunk) -> GenerationStats {
    let millis = |nanos: Option<u64>| nanos.map(|nanos| nanos / 1_000_000);
    let tokens_per_second = match (last.eval_count, last.eval_duration) {
        (Some(tokens), Some(nanos)) if nanos > 0 => Some(round2(tokens as f64 * 1e9 / nanos as f64)),
        _ => None,
    };
    GenerationStats {
        total_duration_ms: millis(last.total_duration),
        load_duration_ms: millis(last.load_duration),
        prompt_tokens: last.prompt_eval_count,
        prompt_eval_duration_ms: millis(last.prompt_eval_duration),
        eval_tokens: last.eval_count,
        eval_duration_ms: millis(last.eval_duration),
        tokens_per_second,
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// One line of metadata per request. Never includes prompt or output text.
fn log_outcome<T>(operation: &str, request_id: &str, model: &str, result: &Result<T, AiError>, started: Instant) {
    let outcome = match result {
        Ok(_) => "ok",
        Err(err) => err.kind.as_str(),
    };
    // Caller-supplied values are only echoed once they are known to be plain identifiers.
    let request_id = if validate_request_id(request_id).is_ok() { request_id } else { "<invalid>" };
    let model = if model::validate_model_name(model).is_ok() { model } else { "<invalid>" };
    eprintln!("[ai] {operation} id={request_id} model={model} result={outcome} ms={}", started.elapsed().as_millis());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_calls_are_capped_at_five_seconds() {
        let slow = AiService::new(AiConfig { timeout: Duration::from_secs(120), ..AiConfig::default() });
        assert_eq!(slow.query_timeout(), Duration::from_secs(5));
        let fast = AiService::new(AiConfig { timeout: Duration::from_millis(300), ..AiConfig::default() });
        assert_eq!(fast.query_timeout(), Duration::from_millis(300));
    }

    #[test]
    fn early_cancels_expire_and_are_bounded() {
        let mut registry = Registry::default();
        registry.remember_cancel("a");
        assert!(registry.take_pending_cancel("a"));
        assert!(!registry.take_pending_cancel("a"), "a pending cancel is used once");

        registry.pending_cancels.insert("old".into(), Instant::now() - PENDING_CANCEL_TTL);
        assert!(!registry.take_pending_cancel("old"), "expired cancels are ignored");

        for index in 0..MAX_PENDING_CANCELS + 10 {
            registry.remember_cancel(&format!("id-{index}"));
        }
        assert_eq!(registry.pending_cancels.len(), MAX_PENDING_CANCELS);
        assert!(registry.take_pending_cancel(&format!("id-{}", MAX_PENDING_CANCELS + 9)));
    }
}
