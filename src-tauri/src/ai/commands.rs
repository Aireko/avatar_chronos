//! Tauri commands for local inference. Each one is a thin async wrapper around
//! [`AiService`]; all of them reject with an [`AiError`].
//!
//! Tauri renames snake_case arguments to camelCase for JavaScript, so the
//! frontend passes `requestId`, `onProgress` and `onEvent`. Streams use
//! [`Channel`]s, which deliver events in order to the calling webview.

use tauri::State;
use tauri::ipc::Channel;

use super::error::AiError;
use super::service::AiService;
use super::types::{
    AiStatus, ConnectionStatus, GenerateRequest, GenerateResponse, ModelInfo, ModelSummary, PullEvent, PullSummary,
    StreamEvent,
};

/// Connection, models, selection and config problems in one call. Never rejects
/// for an invalid config; it reports it in `configError` instead.
#[tauri::command]
pub async fn ai_status(ai: State<'_, AiService>) -> Result<AiStatus, AiError> {
    Ok(ai.status().await)
}

/// Checks whether Ollama answers (an unreachable server is reported, not rejected).
#[tauri::command]
pub async fn ai_check_connection(ai: State<'_, AiService>) -> Result<ConnectionStatus, AiError> {
    ai.check_connection().await
}

/// Every model in Ollama's local store.
#[tauri::command]
pub async fn ai_list_models(ai: State<'_, AiService>) -> Result<Vec<ModelSummary>, AiError> {
    ai.list_models().await
}

/// Details of `model` (default: the selected model).
#[tauri::command]
pub async fn ai_get_model_info(ai: State<'_, AiService>, model: Option<String>) -> Result<ModelInfo, AiError> {
    ai.get_model_info(model).await
}

/// Selects an installed, local Qwen 3.5 model for requests that name none.
#[tauri::command]
pub async fn ai_select_model(ai: State<'_, AiService>, model: String) -> Result<String, AiError> {
    ai.select_model(model).await
}

/// Downloads a Qwen 3.5 model, streaming progress to `on_progress`. Only ever
/// invoked by an explicit user action.
#[tauri::command]
pub async fn ai_pull_model(
    ai: State<'_, AiService>,
    model: Option<String>,
    request_id: String,
    on_progress: Channel<PullEvent>,
) -> Result<PullSummary, AiError> {
    // A failed send means the webview went away; the download result still matters.
    ai.pull_model(model, request_id, move |event| {
        let _ = on_progress.send(event);
    })
    .await
}

/// Generates a complete answer.
#[tauri::command]
pub async fn ai_generate(ai: State<'_, AiService>, request: GenerateRequest) -> Result<GenerateResponse, AiError> {
    ai.generate(request).await
}

/// Generates an answer, streaming `started`, `delta`s and `done`/`cancelled`/`error` to `on_event`.
#[tauri::command]
pub async fn ai_generate_stream(
    ai: State<'_, AiService>,
    request: GenerateRequest,
    on_event: Channel<StreamEvent>,
) -> Result<GenerateResponse, AiError> {
    ai.generate_stream(request, move |event| {
        let _ = on_event.send(event);
    })
    .await
}

/// Cancels a running generation or download. Resolves `false` if none had that id.
#[tauri::command]
pub async fn ai_cancel(ai: State<'_, AiService>, request_id: String) -> Result<bool, AiError> {
    Ok(ai.cancel(&request_id))
}
