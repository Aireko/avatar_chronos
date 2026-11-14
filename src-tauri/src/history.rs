//! File and function level history: the tracked file list, a function's source at
//! two commits, and rebasing one file or one function onto an older commit.
//!
//! A scoped rebase never rewrites history. It makes one file (or one function inside
//! it) look the way it did at the chosen commit and records that as a new commit that
//! contains only that file. Every other file, and the rest of the same file, stays
//! byte for byte as it was. It refuses to run when the file has uncommitted changes.

use std::path::PathBuf;
use std::process::{Command, Output};

use serde::Serialize;
use serde_json::Value;

use crate::ffi::{self, BackendError};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionVersions {
    before: Option<String>,
    after: Option<String>,
    before_start: usize,
    after_start: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedResult {
    ok: bool,
    stdout: String,
    stderr: String,
    error: Option<String>,
}

impl ScopedResult {
    fn from(outcome: Result<String, String>) -> Self {
        match outcome {
            Ok(stdout) => Self { ok: true, stdout, stderr: String::new(), error: None },
            Err(error) => Self { ok: false, stdout: String::new(), stderr: String::new(), error: Some(error) },
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, BackendError> + Send + 'static,
) -> Result<T, BackendError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| BackendError::new(-100, format!("background task failed: {e}")))?
}

#[tauri::command]
pub async fn list_files(repo_path: String) -> Result<Vec<String>, BackendError> {
    blocking(move || {
        let top = repo_top(&repo_path).map_err(to_backend)?;
        let out = git_ok(&top, &["ls-files", "-z"]).map_err(to_backend)?;
        let mut files: Vec<String> = out
            .split(|b| *b == 0)
            .filter(|name| !name.is_empty())
            .map(|name| String::from_utf8_lossy(name).into_owned())
            .collect();
        files.sort();
        files.dedup();
        Ok(files)
    })
    .await
}

#[tauri::command]
pub async fn function_versions(
    repo_path: String,
    revision: String,
    path_at_revision: String,
    path_now: String,
    function_name: String,
) -> Result<FunctionVersions, BackendError> {
    blocking(move || {
        function_versions_inner(&repo_path, &revision, &path_at_revision, &path_now, &function_name)
            .map_err(to_backend)
    })
    .await
}

#[tauri::command]
pub async fn rebase_file(
    repo_path: String,
    revision: String,
    path_at_revision: String,
    path_now: String,
) -> Result<ScopedResult, BackendError> {
    blocking(move || {
        Ok(ScopedResult::from(rebase_file_inner(&repo_path, &revision, &path_at_revision, &path_now)))
    })
    .await
}

#[tauri::command]
pub async fn rebase_function(
    repo_path: String,
    revision: String,
    path_at_revision: String,
    path_now: String,
    function_name: String,
) -> Result<ScopedResult, BackendError> {
    blocking(move || {
        Ok(ScopedResult::from(rebase_function_inner(
            &repo_path,
            &revision,
            &path_at_revision,
            &path_now,
            &function_name,
        )))
    })
    .await
}

fn to_backend(message: String) -> BackendError {
    BackendError::new(-2, message)
}

fn function_versions_inner(
    repo: &str,
    revision: &str,
    path_at_revision: &str,
    path_now: &str,
    name: &str,
) -> Result<FunctionVersions, String> {
    check_revision(revision)?;
    let path_then = check_path(path_at_revision)?;
    let path_now = check_path(path_now)?;
    let top = repo_top(repo)?;

    let before = function_source(&top, revision, &path_then, name)?;
    let after = function_source(&top, "HEAD", &path_now, name)?;
    Ok(FunctionVersions {
        before_start: before.as_ref().map_or(1, |f| f.start),
        after_start: after.as_ref().map_or(1, |f| f.start),
        before: before.map(|f| f.text),
        after: after.map(|f| f.text),
    })
}

fn rebase_file_inner(repo: &str, revision: &str, path_at_revision: &str, path_now: &str) -> Result<String, String> {
    check_revision(revision)?;
    let path_then = check_path(path_at_revision)?;
    let path_now = check_path(path_now)?;
    let top = repo_top(repo)?;
    ensure_clean(&top, &path_now)?;

    let wanted = blob_bytes(&top, revision, &path_then)?
        .ok_or_else(|| format!("{path_then} does not exist at that commit, so there is nothing to go back to."))?;
    write_working_file(&top, &path_now, &wanted)?;

    let message = format!("Rebase {path_now} onto {}", short(revision));
    commit_only(&top, &path_now, &message)
}

fn rebase_function_inner(
    repo: &str,
    revision: &str,
    path_at_revision: &str,
    path_now: &str,
    name: &str,
) -> Result<String, String> {
    check_revision(revision)?;
    let path_then = check_path(path_at_revision)?;
    let path_now = check_path(path_now)?;
    let top = repo_top(repo)?;
    ensure_clean(&top, &path_now)?;

    let old = function_source(&top, revision, &path_then, name)?
        .ok_or_else(|| format!("{name} did not exist in {path_then} at that commit, so there is nothing to go back to."))?;
    let current = function_source(&top, "HEAD", &path_now, name)?.ok_or_else(|| {
        format!("{name} no longer exists in {path_now}, so there is no place to put the old version back.")
    })?;

    let target = PathBuf::from(&top).join(&path_now);
    let work = std::fs::read_to_string(&target).map_err(|e| format!("cannot read {path_now}: {e}"))?;
    let replacement = if work.contains("\r\n") && !old.text.contains('\r') {
        old.text.replace('\n', "\r\n")
    } else {
        old.text
    };
    let merged = splice(&work, current.start, current.end, &replacement);
    write_working_file(&top, &path_now, merged.as_bytes())?;

    let message = format!("Rebase {name} in {path_now} onto {}", short(revision));
    commit_only(&top, &path_now, &message)
}

struct Symbol {
    name: String,
    start: usize,
    end: usize,
}

struct FunctionSource {
    text: String,
    start: usize,
    end: usize,
}

fn symbols_at(top: &str, path: &str, revision: &str) -> Result<Vec<Symbol>, String> {
    let json = ffi::blame(top, path, revision).map_err(|e| e.message)?;
    let report: Value = serde_json::from_str(&json).map_err(|e| format!("unreadable blame report: {e}"))?;
    let list = report
        .get("symbols")
        .and_then(Value::as_array)
        .ok_or_else(|| "the blame report has no symbols".to_string())?;
    Ok(list
        .iter()
        .filter_map(|s| {
            Some(Symbol {
                name: s.get("name")?.as_str()?.to_owned(),
                start: s.get("startLine")?.as_u64()? as usize,
                end: s.get("endLine")?.as_u64()? as usize,
            })
        })
        .collect())
}

fn function_source(top: &str, revision: &str, path: &str, name: &str) -> Result<Option<FunctionSource>, String> {
    let Some(bytes) = blob_bytes(top, revision, path)? else { return Ok(None) };
    let text = String::from_utf8(bytes).map_err(|_| format!("{path} is not a UTF-8 text file"))?;
    let symbols = symbols_at(top, path, revision)?;
    let Some(symbol) = symbols.iter().find(|s| s.name == name) else { return Ok(None) };
    Ok(Some(FunctionSource {
        text: lines_of(&text, symbol.start, symbol.end),
        start: symbol.start,
        end: symbol.end,
    }))
}

fn lines_of(text: &str, start: usize, end: usize) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let from = start.saturating_sub(1).min(lines.len());
    let to = end.min(lines.len()).max(from);
    lines[from..to].concat()
}

fn splice(text: &str, start: usize, end: usize, replacement: &str) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let from = start.saturating_sub(1).min(lines.len());
    let to = end.min(lines.len()).max(from);
    let mut out = String::with_capacity(text.len() + replacement.len());
    out.extend(lines[..from].iter().copied());
    out.push_str(replacement);
    if to < lines.len() && !replacement.is_empty() && !replacement.ends_with('\n') {
        out.push('\n');
    }
    out.extend(lines[to..].iter().copied());
    out
}

fn git(top: &str, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(top).args(args).env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git is not installed or not on PATH".to_string()
        } else {
            format!("could not start git: {e}")
        }
    })
}

fn git_ok(top: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git(top, args)?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(failure_text(&out, args.first().copied().unwrap_or("git")))
    }
}

fn failure_text(out: &Output, what: &str) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let text = [stderr.trim(), stdout.trim()].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
    if text.is_empty() { format!("git {what} failed") } else { text }
}

fn repo_top(repo: &str) -> Result<String, String> {
    let out = git_ok(repo, &["rev-parse", "--show-toplevel"])?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

fn blob_bytes(top: &str, revision: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    if git_ok(top, &["ls-tree", "-z", revision, "--", path])?.is_empty() {
        return Ok(None);
    }
    let spec = format!("{revision}:{path}");
    git_ok(top, &["cat-file", "blob", &spec]).map(Some)
}

fn ensure_clean(top: &str, path: &str) -> Result<(), String> {
    if git_ok(top, &["status", "--porcelain", "-z", "--", path])?.is_empty() {
        Ok(())
    } else {
        Err(format!("{path} has uncommitted changes. Commit or stash them first, so nothing is lost."))
    }
}

fn write_working_file(top: &str, path: &str, bytes: &[u8]) -> Result<(), String> {
    let target = PathBuf::from(top).join(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&target, bytes).map_err(|e| format!("cannot write {path}: {e}"))
}

fn commit_only(top: &str, path: &str, message: &str) -> Result<String, String> {
    git_ok(top, &["add", "--", path])?;
    if git(top, &["diff", "--cached", "--quiet", "--", path])?.status.success() {
        return Err("Nothing to commit: it already matches that commit.".to_string());
    }
    let out = git(top, &["commit", "--only", "-m", message, "--", path])?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let _ = git(top, &["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);
    Err(failure_text(&out, "commit"))
}

fn short(revision: &str) -> &str {
    &revision[..revision.len().min(7)]
}

fn check_revision(revision: &str) -> Result<(), String> {
    let ok = (7..=64).contains(&revision.len()) && revision.bytes().all(|b| b.is_ascii_hexdigit());
    if ok { Ok(()) } else { Err("the revision must be a commit hash".to_string()) }
}

fn check_path(path: &str) -> Result<String, String> {
    let path = path.replace('\\', "/");
    let bytes = path.as_bytes();
    let bad = path.is_empty()
        || path.starts_with('/')
        || path.starts_with('-')
        || path.contains('\0')
        || (bytes.len() > 1 && bytes[1] == b':')
        || path.split('/').any(|part| part == "..");
    if bad { Err(format!("not a path inside the repository: {path}")) } else { Ok(path) }
}