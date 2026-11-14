pub mod ai;
pub mod review;
mod ffi;
mod history;

use ffi::BackendError;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use tauri::{Emitter, Manager};

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

fn io_err(e: impl ToString) -> BackendError {
    BackendError::new(-3, e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellResult {
    ok: bool,
    exit_code: i32,
    command: String,
    cwd: String,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePayload {
    path: String,
    content: String,
}

/// Resolve `relative` under `repo_path` and reject escapes outside the repo.
fn resolve_repo_file(repo_path: &str, relative: &str) -> Result<PathBuf, BackendError> {
    let repo = PathBuf::from(repo_path)
        .canonicalize()
        .map_err(|e| io_err(format!("cannot open repository {repo_path}: {e}")))?;
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(BackendError::new(-5, "absolute paths are not allowed"));
    }
    for part in rel.components() {
        if matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_)) {
            return Err(BackendError::new(-5, "path escapes the repository"));
        }
    }
    let full = repo.join(rel);
    if let Ok(canon) = full.canonicalize() {
        if !canon.starts_with(&repo) {
            return Err(BackendError::new(-5, "path escapes the repository"));
        }
        return Ok(canon);
    }
    if let Some(parent) = full.parent() {
        let parent = if parent.exists() {
            parent
                .canonicalize()
                .map_err(|e| io_err(format!("cannot resolve {}: {e}", parent.display())))?
        } else {
            parent.to_path_buf()
        };
        if !parent.starts_with(&repo) && parent != repo {
            return Err(BackendError::new(-5, "path escapes the repository"));
        }
    }
    Ok(full)
}

fn list_files_under(repo: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), BackendError> {
    let entries = std::fs::read_dir(dir).map_err(|e| io_err(format!("cannot list {}: {e}", dir.display())))?;
    for entry in entries {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ".git" || name == "node_modules" || name == "target" || name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            list_files_under(repo, &path, out)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(repo)
                .map_err(|_| BackendError::new(-5, "path escapes the repository"))?
                .to_string_lossy()
                .replace('\\', "/");
            out.push(rel);
        }
    }
    Ok(())
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlamePayload {
    blame_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewsPayload {
    views_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompileTarget {
    path: String,
    qualified_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourcePayload {
    source_json: String,
}

/// Who wrote each line of `file_path` (relative to the repository root) at
/// `revision` (default HEAD), plus the functions found in the file.
#[tauri::command]
async fn blame_file(
    repo_path: String,
    file_path: String,
    revision: Option<String>,
) -> Result<BlamePayload, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let blame_json = ffi::blame(&repo_path, &file_path, revision.as_deref().unwrap_or(""))?;
        Ok(BlamePayload { blame_json })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn list_repo_files(repo_path: String) -> Result<Vec<String>, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(&repo_path)
            .canonicalize()
            .map_err(|e| io_err(format!("cannot open repository {repo_path}: {e}")))?;
        let mut files = Vec::new();
        list_files_under(&repo, &repo, &mut files)?;
        files.sort();
        Ok(files)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn read_repo_file(repo_path: String, relative_path: String) -> Result<FilePayload, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_repo_file(&repo_path, &relative_path)?;
        let content = std::fs::read_to_string(&path)
            .map_err(|e| io_err(format!("cannot read {}: {e}", path.display())))?;
        Ok(FilePayload {
            path: relative_path.replace('\\', "/"),
            content,
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn write_repo_file(repo_path: String, relative_path: String, content: String) -> Result<(), BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_repo_file(&repo_path, &relative_path)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| io_err(format!("cannot create {}: {e}", parent.display())))?;
        }
        std::fs::write(&path, content.as_bytes())
            .map_err(|e| io_err(format!("cannot write {}: {e}", path.display())))?;
        Ok(())
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn run_shell_command(cwd: String, command: String) -> Result<ShellResult, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return Err(BackendError::new(-1, "empty command"));
        }
        let dir = PathBuf::from(&cwd)
            .canonicalize()
            .map_err(|e| io_err(format!("cannot open working directory {cwd}: {e}")))?;
        if !dir.is_dir() {
            return Err(BackendError::new(-1, format!("{} is not a directory", dir.display())));
        }

        #[cfg(windows)]
        let output = Command::new("cmd")
            .args(["/C", trimmed])
            .current_dir(&dir)
            .output();
        #[cfg(not(windows))]
        let output = Command::new("sh")
            .args(["-lc", trimmed])
            .current_dir(&dir)
            .output();

        let output = output.map_err(|e| BackendError::new(-6, format!("failed to spawn shell: {e}")))?;
        let exit_code = output.status.code().unwrap_or(-1);
        Ok(ShellResult {
            ok: output.status.success(),
            exit_code,
            command: trimmed.to_string(),
            cwd: dir.to_string_lossy().into_owned(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    })
    .await
    .map_err(join_error)?
}

/// Builds the PR Bug Check state: reports under <app data>/pr-bug-check,
/// watcher events emitted app-wide, and auto mode resumed if it was on.
fn create_bug_check(app: &tauri::AppHandle) -> review::BugCheck {
    let ai = app.state::<ai::AiService>().inner().clone();
    let root = match app.path().app_data_dir() {
        Ok(dir) => dir.join(review::store::STORE_DIR_NAME),
        Err(err) => {
            eprintln!("[pr-bug-check] no app data directory ({err}); using the temp directory");
            std::env::temp_dir().join("avatar").join(review::store::STORE_DIR_NAME)
        }
    };
    let handle = app.clone();
    let emit: review::Emitter = Arc::new(move |event: review::WatcherEvent| {
        let _ = handle.emit(review::WATCHER_EVENT, event);
    });
    let bug_check = review::BugCheck::new(ai, root, emit);
    bug_check.watcher.resume();
    bug_check
}

/// Compiles the budgeted agent brief and module-oriented UI graph.
#[tauri::command]
async fn compile_views(
    repo_path: String,
    revision: Option<String>,
    mode: String,
    path: Option<String>,
    qualified_name: Option<String>,
    max_items: Option<u32>,
    max_source_bytes: Option<u32>,
) -> Result<ViewsPayload, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let views_json = ffi::compile_views(
            &repo_path,
            revision.as_deref().unwrap_or("HEAD"),
            &mode,
            path.as_deref().unwrap_or(""),
            qualified_name.as_deref().unwrap_or(""),
            max_items.unwrap_or(0) as usize,
            max_source_bytes.unwrap_or(0) as usize,
        )?;
        Ok(ViewsPayload { views_json })
    })
    .await
    .map_err(join_error)?
}

/// Compiles multiple task targets into one combined brief and graph.
#[tauri::command]
async fn compile_multi_views(
    repo_path: String,
    revision: Option<String>,
    mode: String,
    targets: Vec<CompileTarget>,
    max_items: Option<u32>,
    max_source_bytes: Option<u32>,
) -> Result<ViewsPayload, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let pairs: Vec<(String, String)> = targets
            .into_iter()
            .map(|target| (target.path, target.qualified_name))
            .collect();
        let views_json = ffi::compile_multi_views(
            &repo_path,
            revision.as_deref().unwrap_or("HEAD"),
            &mode,
            &pairs,
            max_items.unwrap_or(0) as usize,
            max_source_bytes.unwrap_or(0) as usize,
        )?;
        Ok(ViewsPayload { views_json })
    })
    .await
    .map_err(join_error)?
}

/// Reads the pinned source range behind an evidence ID/location.
#[tauri::command]
async fn read_source(
    repo_path: String,
    revision: Option<String>,
    file_path: String,
    start_byte: u64,
    end_byte: u64,
) -> Result<SourcePayload, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let start = usize::try_from(start_byte)
            .map_err(|_| BackendError::new(-1, "start byte is too large for this platform"))?;
        let end = usize::try_from(end_byte)
            .map_err(|_| BackendError::new(-1, "end byte is too large for this platform"))?;
        let source_json = ffi::read_source(
            &repo_path,
            revision.as_deref().unwrap_or("HEAD"),
            &file_path,
            start,
            end,
        )?;
        Ok(SourcePayload { source_json })
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
        // PR Bug Check (see review/): needs the app data directory for reports
        // and an AppHandle to emit auto mode events, so it is created here.
        .setup(|app| {
            app.manage(create_bug_check(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_version,
            export_graph,
            run_git_command,
            analyze_merge,
            blame_file,
            list_repo_files,
            read_repo_file,
            write_repo_file,
            run_shell_command,
            history::list_files,
            history::function_versions,
            history::rebase_file,
            history::rebase_function,
            compile_views,
            compile_multi_views,
            read_source,
            ai::commands::ai_status,
            ai::commands::ai_check_connection,
            ai::commands::ai_list_models,
            ai::commands::ai_get_model_info,
            ai::commands::ai_select_model,
            ai::commands::ai_pull_model,
            ai::commands::ai_generate,
            ai::commands::ai_generate_stream,
            ai::commands::ai_cancel,
            review::commands::bug_check_gh_status,
            review::commands::bug_check_list_prs,
            review::commands::bug_check_run,
            review::commands::bug_check_cancel,
            review::commands::bug_check_get_report,
            review::commands::bug_check_post,
            review::commands::bug_check_watch_get,
            review::commands::bug_check_watch_start,
            review::commands::bug_check_watch_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}