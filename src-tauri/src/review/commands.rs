//! Tauri commands of PR Bug Check. Each one is a thin async wrapper around
//! [`BugCheckEngine`] or [`Watcher`]; all of them reject with a
//! [`BugCheckError`].
//!
//! Tauri renames snake_case arguments to camelCase for JavaScript, so the
//! frontend passes `findingIds` and `onEvent`.

use tauri::State;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use super::BugCheck;
use super::error::BugCheckError;
use super::types::{
    BugCheckEvent, BugCheckOptions, BugCheckReport, GhStatus, LastReportInfo, PostResult, PrWithStatus, WatchConfig,
    WatchState,
};

/// Whether `gh` is installed and logged in. Never rejects.
#[tauri::command]
pub async fn bug_check_gh_status(state: State<'_, BugCheck>) -> Result<GhStatus, BugCheckError> {
    Ok(state.engine.github().status().await)
}

/// Up to 50 open PRs of `repo`, each with a summary of its stored report.
#[tauri::command]
pub async fn bug_check_list_prs(state: State<'_, BugCheck>, repo: String) -> Result<Vec<PrWithStatus>, BugCheckError> {
    let prs = state.engine.github().list_open_prs(&repo).await?;
    let store = state.engine.store();
    Ok(prs
        .into_iter()
        .map(|pr| {
            let last_report = store.load_report(&repo, pr.number).map(|report| LastReportInfo {
                up_to_date: report.head_sha == pr.head_ref_oid,
                posted: report.posted.is_some(),
                finding_count: report.findings.len(),
                run_id: report.run_id,
                head_sha: report.head_sha,
                started_at: report.started_at,
            });
            PrWithStatus { pr, last_report }
        })
        .collect())
}

/// Checks `repo#number`, streaming progress to `on_event`. Rejects with kind
/// `cancelled` after `bug_check_cancel`.
#[tauri::command]
pub async fn bug_check_run(
    state: State<'_, BugCheck>,
    repo: String,
    number: u64,
    options: Option<BugCheckOptions>,
    on_event: Channel<BugCheckEvent>,
) -> Result<BugCheckReport, BugCheckError> {
    let on_event = move |event| {
        // A failed send means the webview went away; the run still finishes and is stored.
        let _ = on_event.send(event);
    };
    state.engine.run(&repo, number, options.unwrap_or_default(), on_event, CancellationToken::new()).await
}

/// Cancels run `run_id`. Resolves `false` if no such run is in progress.
#[tauri::command]
pub async fn bug_check_cancel(state: State<'_, BugCheck>, run_id: String) -> Result<bool, BugCheckError> {
    Ok(state.engine.cancel(&run_id))
}

/// The stored report of `repo#number`, or `null`.
#[tauri::command]
pub async fn bug_check_get_report(
    state: State<'_, BugCheck>,
    repo: String,
    number: u64,
) -> Result<Option<BugCheckReport>, BugCheckError> {
    super::github::validate_repo(&repo)?;
    super::github::validate_pr_number(number)?;
    Ok(state.engine.store().load_report(&repo, number))
}

/// Posts the selected findings of the stored report as one GitHub review.
/// Only ever invoked by an explicit user action.
#[tauri::command]
pub async fn bug_check_post(
    state: State<'_, BugCheck>,
    repo: String,
    number: u64,
    finding_ids: Vec<String>,
) -> Result<PostResult, BugCheckError> {
    state.engine.post(&repo, number, &finding_ids).await
}

/// The state of auto mode.
#[tauri::command]
pub async fn bug_check_watch_get(state: State<'_, BugCheck>) -> Result<WatchState, BugCheckError> {
    Ok(state.watcher.state())
}

/// Starts (or reconfigures) auto mode.
#[tauri::command]
pub async fn bug_check_watch_start(
    state: State<'_, BugCheck>,
    config: WatchConfig,
) -> Result<WatchState, BugCheckError> {
    state.watcher.start(config)
}

/// Stops auto mode.
#[tauri::command]
pub async fn bug_check_watch_stop(state: State<'_, BugCheck>) -> Result<WatchState, BugCheckError> {
    Ok(state.watcher.stop())
}
