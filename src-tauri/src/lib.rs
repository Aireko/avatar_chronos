pub mod ai;
mod ffi;

use ffi::BackendError;
use serde::Serialize;
use tauri::Manager;

// Git work can take seconds, so every command runs the C call on a blocking
// thread and the UI stays responsive.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphPayload {
    graph_path: String,
    graph_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandPayload {
    result_json: String,
    graph_path: String,
    graph_json: Option<String>,
}

/// Defaults to <app data>/chronos_graph.json, so the file never shows up as
/// an untracked file inside the user's repository.
fn resolve_output_path(app: &tauri::AppHandle, output_path: Option<String>) -> Result<String, BackendError> {
    if let Some(path) = output_path.filter(|p| !p.trim().is_empty()) {
        return Ok(path);
    }
    let dir = app.path().app_data_dir().map_err(|e| BackendError::new(-3, e.to_string()))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| BackendError::new(-3, format!("cannot create {}: {e}", dir.display())))?;
    Ok(dir.join("chronos_graph.json").to_string_lossy().into_owned())
}

fn read_graph(path: &str) -> Result<String, BackendError> {
    std::fs::read_to_string(path).map_err(|e| BackendError::new(-3, format!("cannot read {path}: {e}")))
}

fn join_error(e: tauri::Error) -> BackendError {
    BackendError::new(-100, format!("background task failed: {e}"))
}

#[tauri::command]
fn backend_version() -> String {
    ffi::version()
}

#[tauri::command]
async fn export_graph(
    app: tauri::AppHandle,
    repo_path: String,
    output_path: Option<String>,
    max_commits: Option<i32>,
) -> Result<GraphPayload, BackendError> {
    let out = resolve_output_path(&app, output_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        ffi::export_graph(&repo_path, &out, max_commits.unwrap_or(0))?;
        let graph_json = read_graph(&out)?;
        Ok(GraphPayload { graph_path: out, graph_json })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn run_git_command(
    app: tauri::AppHandle,
    repo_path: String,
    git_args: String,
    output_path: Option<String>,
) -> Result<CommandPayload, BackendError> {
    let out = resolve_output_path(&app, output_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result_json = ffi::run_git_cmd(&repo_path, &git_args, &out)?;
        let graph_json = std::fs::read_to_string(&out).ok();
        Ok(CommandPayload { result_json, graph_path: out, graph_json })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn analyze_merge(
    app: tauri::AppHandle,
    repo_path: String,
    source_branch: String,
    target_branch: String,
    output_path: Option<String>,
) -> Result<GraphPayload, BackendError> {
    let out = resolve_output_path(&app, output_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        ffi::analyze_merge(&repo_path, &source_branch, &target_branch, &out)?;
        let graph_json = read_graph(&out)?;
        Ok(GraphPayload { graph_path: out, graph_json })
    })
    .await
    .map_err(join_error)?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Local Qwen 3.5 inference through Ollama (see ai/). Reads the OLLAMA_*
        // variables and never panics: an invalid config is reported by ai_status
        // and makes the other ai_* commands reject.
        .manage(ai::AiService::from_env())
        .invoke_handler(tauri::generate_handler![
            backend_version,
            export_graph,
            run_git_command,
            analyze_merge,
            ai::commands::ai_status,
            ai::commands::ai_check_connection,
            ai::commands::ai_list_models,
            ai::commands::ai_get_model_info,
            ai::commands::ai_select_model,
            ai::commands::ai_pull_model,
            ai::commands::ai_generate,
            ai::commands::ai_generate_stream,
            ai::commands::ai_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}