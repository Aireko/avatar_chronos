//! Bindings to the Chronos C backend (`backend/include/avatar.h`), compiled by
//! `build.rs`. The rest of the app only calls the safe wrappers below.

use std::ffi::{CStr, CString, c_char, c_int};
use std::fmt;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

/// Serializes calls into C: it spawns git processes and keeps the last error
/// in thread-local storage, so one call at a time keeps behaviour predictable.
static BACKEND_LOCK: Mutex<()> = Mutex::new(());

unsafe extern "C" {
    fn chronos_export_graph(repo_path: *const c_char, output_json_path: *const c_char, max_commits: c_int) -> c_int;
    fn chronos_run_git_cmd(repo_path: *const c_char, git_args: *const c_char, output_json_path: *const c_char) -> *mut c_char;
    fn chronos_analyze_merge(
        repo_path: *const c_char,
        source_branch: *const c_char,
        target_branch: *const c_char,
        output_json_path: *const c_char,
    ) -> c_int;
    fn chronos_blame(
        repo_path: *const c_char,
        file_path: *const c_char,
        revision: *const c_char,
        out_json: *mut *mut c_char,
    ) -> c_int;
    fn chronos_compile_views(
        repo_path: *const c_char,
        revision: *const c_char,
        mode: *const c_char,
        path: *const c_char,
        qualified_name: *const c_char,
        max_items: usize,
        max_source_bytes: usize,
        out_json: *mut *mut c_char,
    ) -> c_int;
    fn chronos_compile_multi_views(
        repo_path: *const c_char,
        revision: *const c_char,
        mode: *const c_char,
        paths: *const *const c_char,
        qualified_names: *const *const c_char,
        target_count: usize,
        max_items: usize,
        max_source_bytes: usize,
        out_json: *mut *mut c_char,
    ) -> c_int;
    fn chronos_read_source(
        repo_path: *const c_char,
        revision: *const c_char,
        file_path: *const c_char,
        start_byte: usize,
        end_byte: usize,
        out_json: *mut *mut c_char,
    ) -> c_int;
    fn chronos_last_error() -> *const c_char;
    fn chronos_free_string(s: *mut c_char);
    fn chronos_version() -> *const c_char;
}

/// An error from the C backend (or the bridge). Commands reject with it, so
/// the frontend receives `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendError {
    pub code: i32,
    pub message: String,
}

impl BackendError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// Must be called on the same thread, under the lock, right after the C call.
    fn from_status(code: c_int) -> Self {
        let message = last_error();
        if message.is_empty() {
            Self::new(code, format!("C backend error {code}"))
        } else {
            Self::new(code, message)
        }
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (C backend status {})", self.message, self.code)
    }
}

impl std::error::Error for BackendError {}

fn lock() -> MutexGuard<'static, ()> {
    BACKEND_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn c_string(value: &str, what: &str) -> Result<CString, BackendError> {
    CString::new(value).map_err(|_| BackendError::new(-1, format!("{what} contains a NUL byte")))
}

/// # Safety
/// `ptr` must be NULL or point to a NUL-terminated string valid for the call.
unsafe fn string_from_c(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: guaranteed by the caller.
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

fn last_error() -> String {
    // SAFETY: chronos_last_error returns a thread-local NUL-terminated buffer.
    unsafe { string_from_c(chronos_last_error()) }
}

fn check(status: c_int) -> Result<(), BackendError> {
    if status >= 0 { Ok(()) } else { Err(BackendError::from_status(status)) }
}

/// Version of the C backend.
pub fn version() -> String {
    // SAFETY: chronos_version returns a static NUL-terminated string.
    unsafe { string_from_c(chronos_version()) }
}

/// Writes chronos_graph.json for `repo_path` to `output_path`.
pub fn export_graph(repo_path: &str, output_path: &str, max_commits: i32) -> Result<(), BackendError> {
    let repo = c_string(repo_path, "repo path")?;
    let out = c_string(output_path, "output path")?;
    let _guard = lock();
    // SAFETY: both pointers are valid NUL-terminated strings for the call.
    check(unsafe { chronos_export_graph(repo.as_ptr(), out.as_ptr(), max_commits) })
}

/// Runs a whitelisted git command and returns the backend's JSON result string.
pub fn run_git_cmd(repo_path: &str, git_args: &str, output_path: &str) -> Result<String, BackendError> {
    let repo = c_string(repo_path, "repo path")?;
    let args = c_string(git_args, "git arguments")?;
    let out = c_string(output_path, "output path")?;
    let _guard = lock();
    // SAFETY: all pointers are valid NUL-terminated strings for the call.
    let ptr = unsafe { chronos_run_git_cmd(repo.as_ptr(), args.as_ptr(), out.as_ptr()) };
    if ptr.is_null() {
        return Err(BackendError::from_status(-4));
    }
    // SAFETY: ptr is a NUL-terminated string allocated by the backend; we copy
    // it and then release it with the matching free function exactly once.
    let result = unsafe { string_from_c(ptr) };
    unsafe { chronos_free_string(ptr) };
    Ok(result)
}

/// Analyzes merging `source_branch` into `target_branch` and writes the graph.
pub fn analyze_merge(
    repo_path: &str,
    source_branch: &str,
    target_branch: &str,
    output_path: &str,
) -> Result<(), BackendError> {
    let repo = c_string(repo_path, "repo path")?;
    let src = c_string(source_branch, "source branch")?;
    let tgt = c_string(target_branch, "target branch")?;
    let out = c_string(output_path, "output path")?;
    let _guard = lock();
    // SAFETY: all pointers are valid NUL-terminated strings for the call.
    check(unsafe { chronos_analyze_merge(repo.as_ptr(), src.as_ptr(), tgt.as_ptr(), out.as_ptr()) })
}

/// Line-by-line authorship of `file_path` (relative to the repository root)
/// at `revision` ("" means HEAD), as the backend's JSON string.
pub fn blame(repo_path: &str, file_path: &str, revision: &str) -> Result<String, BackendError> {
    let repo = c_string(repo_path, "repo path")?;
    let file = c_string(file_path, "file path")?;
    let rev = c_string(revision, "revision")?;
    let _guard = lock();
    let mut out: *mut c_char = std::ptr::null_mut();
    // SAFETY: the input pointers are valid NUL-terminated strings for the call,
    // and `out` is a valid place for the backend to store its result pointer.
    let status = unsafe { chronos_blame(repo.as_ptr(), file.as_ptr(), rev.as_ptr(), &mut out) };
    if status < 0 {
        return Err(BackendError::from_status(status));
    }
    if out.is_null() {
        return Err(BackendError::new(-4, "the C backend returned no blame data"));
    }
    // SAFETY: `out` is a NUL-terminated string allocated by the backend; we copy
    // it and release it with the matching free function exactly once.
    let json = unsafe { string_from_c(out) };
    unsafe { chronos_free_string(out) };
    Ok(json)
}

/// Compiles the agent brief and UI graph for one revision. Returns the C
/// backend's JSON envelope containing both documents.
pub fn compile_views(
    repo_path: &str,
    revision: &str,
    mode: &str,
    path: &str,
    qualified_name: &str,
    max_items: usize,
    max_source_bytes: usize,
) -> Result<String, BackendError> {
    let repo = c_string(repo_path, "repo path")?;
    let rev = c_string(revision, "revision")?;
    let mode = c_string(mode, "mode")?;
    let path = c_string(path, "path")?;
    let qualified = c_string(qualified_name, "qualified name")?;
    let _guard = lock();
    let mut out: *mut c_char = std::ptr::null_mut();
    // SAFETY: input strings are valid for the call; `out` is writable.
    let status = unsafe {
        chronos_compile_views(
            repo.as_ptr(),
            rev.as_ptr(),
            mode.as_ptr(),
            path.as_ptr(),
            qualified.as_ptr(),
            max_items,
            max_source_bytes,
            &mut out,
        )
    };
    if status < 0 {
        return Err(BackendError::from_status(status));
    }
    if out.is_null() {
        return Err(BackendError::new(-4, "the C backend returned no context views"));
    }
    // SAFETY: `out` is a backend-allocated NUL-terminated string.
    let json = unsafe { string_from_c(out) };
    unsafe { chronos_free_string(out) };
    Ok(json)
}

/// Compiles multiple task targets into one combined brief and graph.
pub fn compile_multi_views(
    repo_path: &str,
    revision: &str,
    mode: &str,
    targets: &[(String, String)],
    max_items: usize,
    max_source_bytes: usize,
) -> Result<String, BackendError> {
    let repo = c_string(repo_path, "repo path")?;
    let rev = c_string(revision, "revision")?;
    let mode = c_string(mode, "mode")?;
    let mut paths = Vec::with_capacity(targets.len());
    let mut qualified = Vec::with_capacity(targets.len());
    for (path, name) in targets {
        paths.push(c_string(path, "path")?);
        qualified.push(c_string(name, "qualified name")?);
    }
    let path_ptrs: Vec<*const c_char> = paths.iter().map(|value| value.as_ptr()).collect();
    let qualified_ptrs: Vec<*const c_char> =
        qualified.iter().map(|value| value.as_ptr()).collect();
    let _guard = lock();
    let mut out: *mut c_char = std::ptr::null_mut();
    // SAFETY: the string arrays and their pointers are valid for the call.
    let status = unsafe {
        chronos_compile_multi_views(
            repo.as_ptr(),
            rev.as_ptr(),
            mode.as_ptr(),
            path_ptrs.as_ptr(),
            qualified_ptrs.as_ptr(),
            targets.len(),
            max_items,
            max_source_bytes,
            &mut out,
        )
    };
    if status < 0 {
        return Err(BackendError::from_status(status));
    }
    if out.is_null() {
        return Err(BackendError::new(-4, "the C backend returned no context views"));
    }
    // SAFETY: `out` is a backend-allocated NUL-terminated string.
    let json = unsafe { string_from_c(out) };
    unsafe { chronos_free_string(out) };
    Ok(json)
}

/// Reads pinned source bytes for one evidence location.
pub fn read_source(
    repo_path: &str,
    revision: &str,
    file_path: &str,
    start_byte: usize,
    end_byte: usize,
) -> Result<String, BackendError> {
    let repo = c_string(repo_path, "repo path")?;
    let rev = c_string(revision, "revision")?;
    let file = c_string(file_path, "file path")?;
    let _guard = lock();
    let mut out: *mut c_char = std::ptr::null_mut();
    // SAFETY: input strings are valid for the call; `out` is writable.
    let status = unsafe {
        chronos_read_source(
            repo.as_ptr(),
            rev.as_ptr(),
            file.as_ptr(),
            start_byte,
            end_byte,
            &mut out,
        )
    };
    if status < 0 {
        return Err(BackendError::from_status(status));
    }
    if out.is_null() {
        return Err(BackendError::new(-4, "the C backend returned no source"));
    }
    // SAFETY: `out` is a backend-allocated NUL-terminated string.
    let json = unsafe { string_from_c(out) };
    unsafe { chronos_free_string(out) };
    Ok(json)
}

#[cfg(test)]
mod tests {
    //! Integration tests: build a throwaway repo with known answers, then run
    //! every backend feature against it. Requires `git` (>= 2.38) on PATH.

    use super::*;
    use serde_json::{Value, json};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn git_output(dir: &Path, args: &[&str]) -> String {
        // Ignore identity/date overrides from the environment so results are reproducible.
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env_remove("GIT_AUTHOR_NAME")
            .env_remove("GIT_AUTHOR_EMAIL")
            .env_remove("GIT_AUTHOR_DATE")
            .env_remove("GIT_COMMITTER_NAME")
            .env_remove("GIT_COMMITTER_EMAIL")
            .env_remove("GIT_COMMITTER_DATE")
            .output()
            .expect("git must be on PATH");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn git(dir: &Path, args: &[&str]) {
        git_output(dir, args);
    }

    fn write_math(dir: &Path, alpha: &str, beta: &str, gamma: &str, delta_a: &str, delta_ret: &str) {
        let text = format!(
            "int alpha(int x)\n{{\n    int r = {alpha};\n    return r;\n}}\n\n\
             int beta(int x)\n{{\n    int r = {beta};\n    return r;\n}}\n\n\
             int gamma(int x)\n{{\n    int r = {gamma};\n    return r;\n}}\n\n\
             int delta(int x)\n{{\n    int a = {delta_a};\n    int b = a + 1;\n    int c = b + 1;\n    return {delta_ret};\n}}\n"
        );
        std::fs::write(dir.join("math.c"), text).unwrap();
    }

    /// Fixture repo:
    ///   base     -> math.c with alpha/beta/gamma/delta
    ///   feature  -> edits alpha (l.3), beta (l.9), delta return (l.24), adds feature.c
    ///   main     -> edits beta (l.9), gamma (l.15), delta first line (l.21)
    ///   rename-test -> renames math.c to calc.c
    struct Fixture {
        dir: PathBuf,
        out: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let base = std::env::temp_dir().join(format!("chronos-{name}-{}", std::process::id()));
            let dir = base.join("repo");
            let out = base.join("graph.json");
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&dir).unwrap();

            git(&dir, &["init", "-q", "-b", "main"]);
            git(&dir, &["config", "user.name", "Chronos Test"]);
            git(&dir, &["config", "user.email", "chronos@example.com"]);
            git(&dir, &["config", "core.autocrlf", "false"]);
            git(&dir, &["config", "commit.gpgsign", "false"]);

            write_math(&dir, "x + 1", "x * 2", "x - 3", "x", "a + b + c");
            git(&dir, &["add", "-A"]);
            git(&dir, &["commit", "-q", "-m", "base: four functions"]);

            git(&dir, &["switch", "-q", "-c", "feature"]);
            write_math(&dir, "x + 10", "x * 4", "x - 3", "x", "a + b + c + 1");
            std::fs::write(dir.join("feature.c"), "int feature_fn(void)\n{\n    return 42;\n}\n").unwrap();
            git(&dir, &["add", "-A"]);
            git(&dir, &["commit", "-q", "-m", "feature: alpha, beta, delta return, new feature.c"]);
            git(&dir, &["tag", "v0.1-feature"]);

            git(&dir, &["switch", "-q", "main"]);
            write_math(&dir, "x + 1", "x * 3", "x - 4", "x + 100", "a + b + c");
            git(&dir, &["add", "-A"]);
            git(&dir, &["commit", "-q", "-m", "main: beta, gamma, delta first line"]);

            git(&dir, &["switch", "-q", "-c", "rename-test"]);
            git(&dir, &["mv", "math.c", "calc.c"]);
            git(&dir, &["commit", "-q", "-m", "rename math.c -> calc.c"]);
            git(&dir, &["switch", "-q", "main"]);

            Self { dir, out }
        }

        fn repo(&self) -> String {
            self.dir.to_string_lossy().into_owned()
        }

        fn out(&self) -> String {
            self.out.to_string_lossy().into_owned()
        }

        fn graph(&self) -> Value {
            serde_json::from_str(&std::fs::read_to_string(&self.out).unwrap()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(base) = self.dir.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }

    fn commit<'a>(graph: &'a Value, message: &str) -> &'a Value {
        graph["commits"].as_array().unwrap().iter().find(|c| c["message"] == message)
            .unwrap_or_else(|| panic!("no commit with message {message:?}"))
    }

    fn file<'a>(commit: &'a Value, path: &str) -> &'a Value {
        commit["filesChanged"].as_array().unwrap().iter().find(|f| f["path"] == path)
            .unwrap_or_else(|| panic!("no file {path:?} in commit {}", commit["message"]))
    }

    fn symbol<'a>(file: &'a Value, name: &str) -> &'a Value {
        file["symbolsTouched"].as_array().unwrap().iter().find(|s| s["name"] == name)
            .unwrap_or_else(|| panic!("no symbol {name:?} in {}", file["path"]))
    }

    fn conflict<'a>(graph: &'a Value, symbol: &str) -> &'a Value {
        graph["mergeAnalysis"]["conflicts"].as_array().unwrap().iter().find(|c| c["symbolName"] == symbol)
            .unwrap_or_else(|| panic!("no conflict entry for {symbol:?}"))
    }

    fn assert_symbol(file: &Value, name: &str, change: &str, start: u64, end: u64) {
        let s = symbol(file, name);
        assert_eq!(s["changeType"], change, "{name} changeType");
        assert_eq!(s["startLine"], start, "{name} startLine");
        assert_eq!(s["endLine"], end, "{name} endLine");
    }

    #[test]
    fn version_is_reported() {
        assert!(version().starts_with("chronos-backend"));
    }

    #[test]
    fn export_graph_extracts_dag_files_and_symbols() {
        let fx = Fixture::new("graph");
        export_graph(&fx.repo(), &fx.out(), 0).unwrap();
        let g = fx.graph();

        assert_eq!(g["commits"].as_array().unwrap().len(), 4);
        assert_eq!(g["head"], git_output(&fx.dir, &["rev-parse", "HEAD"]).trim());
        assert_eq!(g["mergeAnalysis"]["active"], false);

        let branches = g["branches"].as_array().unwrap();
        assert_eq!(branches.len(), 3);
        let main = branches.iter().find(|b| b["name"] == "main").unwrap();
        assert_eq!(main["isHead"], true);

        let base = commit(&g, "base: four functions");
        assert_eq!(base["parents"].as_array().unwrap().len(), 0);

        let feat = commit(&g, "feature: alpha, beta, delta return, new feature.c");
        assert!(feat["refs"].as_array().unwrap().iter().any(|r| r == "tag: v0.1-feature"));
        let new_file = file(feat, "feature.c");
        assert_eq!(new_file["status"], "A");
        assert_eq!(new_file["additions"], 4);
        assert_symbol(new_file, "feature_fn", "ADDED", 1, 4);
        let math = file(feat, "math.c");
        assert_eq!(math["status"], "M");
        assert_symbol(math, "alpha", "MODIFIED", 3, 3);
        assert_symbol(math, "beta", "MODIFIED", 9, 9);
        assert_symbol(math, "delta", "MODIFIED", 24, 24);

        let main_commit = commit(&g, "main: beta, gamma, delta first line");
        assert!(main_commit["refs"].as_array().unwrap().iter().any(|r| r == "HEAD -> main"));
        let math = file(main_commit, "math.c");
        assert_symbol(math, "beta", "MODIFIED", 9, 9);
        assert_symbol(math, "gamma", "MODIFIED", 15, 15);
        assert_symbol(math, "delta", "MODIFIED", 21, 21);

        let rename = commit(&g, "rename math.c -> calc.c");
        let calc = file(rename, "calc.c");
        assert_eq!(calc["status"], "R");
        assert_eq!(calc["oldPath"], "math.c");
        assert_eq!(calc["additions"], 0);
        assert_eq!(calc["deletions"], 0);
    }

    #[test]
    fn analyze_merge_classifies_every_symbol() {
        let fx = Fixture::new("merge");
        let head_before = git_output(&fx.dir, &["rev-parse", "HEAD"]);
        analyze_merge(&fx.repo(), "feature", "main", &fx.out()).unwrap();
        let g = fx.graph();
        let m = &g["mergeAnalysis"];

        assert_eq!(m["active"], true);
        assert_eq!(m["sourceBranch"], "feature");
        assert_eq!(m["targetBranch"], "main");
        assert_eq!(m["canAutoMerge"], false);
        assert_eq!(m["mergeBase"], git_output(&fx.dir, &["merge-base", "main", "feature"]).trim());

        let beta = conflict(&g, "beta");
        assert_eq!(beta["resolutionStatus"], "TRUE_COLLISION");
        assert_eq!(beta["oursRange"], json!([9, 9]));
        assert_eq!(beta["theirsRange"], json!([9, 9]));
        assert!(beta["baseSnippet"].as_str().unwrap().contains("x * 2"));
        assert!(beta["oursSnippet"].as_str().unwrap().contains("x * 3"));
        assert!(beta["theirsSnippet"].as_str().unwrap().contains("x * 4"));

        let delta = conflict(&g, "delta");
        assert_eq!(delta["resolutionStatus"], "AUTO_RESOLVABLE");
        assert_eq!(delta["oursRange"], json!([21, 21]));
        assert_eq!(delta["theirsRange"], json!([24, 24]));

        let gamma = conflict(&g, "gamma");
        assert_eq!(gamma["resolutionStatus"], "CLEAN");
        assert_eq!(gamma["oursRange"], json!([15, 15]));
        assert_eq!(gamma["theirsRange"], Value::Null);

        let alpha = conflict(&g, "alpha");
        assert_eq!(alpha["resolutionStatus"], "CLEAN");
        assert_eq!(alpha["oursRange"], Value::Null);
        assert_eq!(alpha["theirsRange"], json!([3, 3]));

        let feature_fn = conflict(&g, "feature_fn");
        assert_eq!(feature_fn["resolutionStatus"], "CLEAN");
        assert_eq!(feature_fn["filePath"], "feature.c");

        // Non-destructive: working tree, index and HEAD untouched.
        assert_eq!(git_output(&fx.dir, &["status", "--porcelain"]), "");
        assert_eq!(git_output(&fx.dir, &["rev-parse", "HEAD"]), head_before);
    }

    #[test]
    fn run_git_cmd_executes_whitelisted_commands_and_refreshes_graph() {
        let fx = Fixture::new("run");
        let run = |args: &str| -> Value {
            serde_json::from_str(&run_git_cmd(&fx.repo(), args, &fx.out()).unwrap()).unwrap()
        };

        let blocked = run("config user.name hacker");
        assert_eq!(blocked["ok"], false);
        assert!(blocked["error"].as_str().unwrap().contains("not allowed"));

        let status = run("status --short --branch");
        assert_eq!(status["ok"], true);
        assert_eq!(status["graphStatus"], 0);
        assert!(status["stdout"].as_str().unwrap().contains("## main"));

        let commit_result = run("commit --allow-empty -m \"live test commit\"");
        assert_eq!(commit_result["ok"], true, "{commit_result}");
        commit(&fx.graph(), "live test commit");

        let merge = run("merge feature");
        assert_eq!(merge["ok"], false);
        assert_eq!(merge["exitCode"], 1);
        assert_eq!(merge["graphStatus"], 0);

        let abort = run("merge --abort");
        assert_eq!(abort["ok"], true, "{abort}");
        assert_eq!(git_output(&fx.dir, &["status", "--porcelain"]), "");
    }

    #[test]
    fn errors_come_back_as_backend_errors() {
        let fx = Fixture::new("errors");
        let missing = fx.dir.join("does-not-exist").to_string_lossy().into_owned();

        let err = export_graph(&missing, &fx.out(), 0).unwrap_err();
        assert_eq!(err.code, -2, "{err}"); // AVATAR_ERR_GIT

        let err = analyze_merge(&fx.repo(), "-evil", "main", &fx.out()).unwrap_err();
        assert_eq!(err.code, -1, "{err}"); // AVATAR_ERR_ARGS

        let err = analyze_merge(&fx.repo(), "no-such-branch", "main", &fx.out()).unwrap_err();
        assert_eq!(err.code, -2, "{err}");
    }

    #[test]
    fn blame_groups_lines_by_author_and_finds_functions() {
        let fx = Fixture::new("blame");
        // Two more commits on main by a second author, with differently cased emails.
        write_math(&fx.dir, "x + 2", "x * 3", "x - 4", "x + 100", "a + b + c");
        git(&fx.dir, &["-c", "user.name=Ada Lovelace", "-c", "user.email=Ada@Example.com", "commit", "-q", "--date", "2020-01-01T00:00:00+00:00", "-am", "ada: alpha"]);
        write_math(&fx.dir, "x + 2", "x * 5", "x - 4", "x + 100", "a + b + c");
        git(&fx.dir, &["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com", "commit", "-q", "--date", "2021-01-01T00:00:00+00:00", "-am", "ada: beta"]);

        let b: Value = serde_json::from_str(&blame(&fx.repo(), "math.c", "").unwrap()).unwrap();
        assert_eq!(b["path"], "math.c");
        assert_eq!(b["revision"], git_output(&fx.dir, &["rev-parse", "HEAD"]).trim());
        assert_eq!(b["totalLines"], 25);

        let authors = b["authors"].as_array().unwrap();
        assert_eq!(authors.len(), 2, "{authors:?}");
        assert_eq!(authors[0]["name"], "Chronos Test");
        assert_eq!(authors[0]["lines"], 23);
        assert_eq!(authors[0]["commits"], 2);
        assert_eq!(authors[1]["name"], "Ada Lovelace");
        assert_eq!(authors[1]["email"], "ada@example.com"); // from the newest commit
        assert_eq!(authors[1]["lines"], 2);
        assert_eq!(authors[1]["commits"], 2);
        assert_eq!(authors[1]["lastSummary"], "ada: beta");

        let commits = b["commits"].as_array().unwrap();
        assert_eq!(commits.len(), 4);
        let ranges = b["ranges"].as_array().unwrap();
        let owner = |line: u64| -> String {
            let r = ranges.iter().find(|r| r["start"].as_u64().unwrap() <= line && line <= r["end"].as_u64().unwrap()).unwrap();
            let c = commits.iter().find(|c| c["hash"] == r["commit"]).unwrap();
            c["summary"].as_str().unwrap().to_owned()
        };
        assert_eq!(owner(3), "ada: alpha");
        assert_eq!(owner(9), "ada: beta");
        assert_eq!(owner(15), "main: beta, gamma, delta first line");
        assert_eq!(owner(1), "base: four functions");
        let covered: u64 = ranges.iter().map(|r| r["end"].as_u64().unwrap() - r["start"].as_u64().unwrap() + 1).sum();
        assert_eq!(covered, 25);

        let symbols = b["symbols"].as_array().unwrap();
        let extent = |name: &str| -> (u64, u64) {
            let s = symbols.iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no symbol {name}"));
            (s["startLine"].as_u64().unwrap(), s["endLine"].as_u64().unwrap())
        };
        assert_eq!(extent("alpha"), (1, 5));
        assert_eq!(extent("beta"), (7, 11));
        assert_eq!(extent("delta"), (19, 25));

        // An older revision and a file in a subdirectory-free repo path both work.
        let old: Value = serde_json::from_str(&blame(&fx.repo(), "./math.c", "feature").unwrap()).unwrap();
        assert_eq!(old["authors"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn blame_finds_functions_with_tree_sitter_and_by_indentation() {
        let fx = Fixture::new("blame-langs");
        // TypeScript goes through tree-sitter: braces inside strings don't matter.
        std::fs::write(
            fx.dir.join("fmt.ts"),
            "function fmt(s: string) {\n  const open = 'x{';\n  return open + s;\n}\n\nfunction after() {\n  return 1;\n}\n",
        )
        .unwrap();
        // Python falls back to indentation, including a multi-line signature.
        std::fs::write(
            fx.dir.join("build.py"),
            "def build(\n    a,\n    b,\n):\n    total = a + b\n    return total\n\n\ndef other():\n    return 2\n",
        )
        .unwrap();
        git(&fx.dir, &["add", "-A"]);
        git(&fx.dir, &["commit", "-q", "-m", "add ts and py"]);

        let extents = |file: &str| -> Vec<(String, u64, u64)> {
            let b: Value = serde_json::from_str(&blame(&fx.repo(), file, "").unwrap()).unwrap();
            b["symbols"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| (s["name"].as_str().unwrap().to_owned(), s["startLine"].as_u64().unwrap(), s["endLine"].as_u64().unwrap()))
                .collect()
        };
        assert_eq!(extents("fmt.ts"), vec![("fmt".to_owned(), 1, 4), ("after".to_owned(), 6, 8)]);
        assert_eq!(extents("build.py"), vec![("build".to_owned(), 1, 6), ("other".to_owned(), 9, 10)]);
    }

    #[test]
    fn blame_rejects_bad_paths_and_revisions() {
        let fx = Fixture::new("blame-errors");
        assert_eq!(blame(&fx.repo(), "no-such-file.c", "").unwrap_err().code, -2);
        assert_eq!(blame(&fx.repo(), "../outside.c", "").unwrap_err().code, -1);
        assert_eq!(blame(&fx.repo(), "/etc/passwd", "").unwrap_err().code, -1);
        assert_eq!(blame(&fx.repo(), "math.c", "-evil").unwrap_err().code, -1);
        assert_eq!(blame(&fx.repo(), "math.c", "no-such-branch").unwrap_err().code, -2);
        assert_eq!(blame(&fx.repo(), "math.c", "main..feature").unwrap_err().code, -1);
        assert_eq!(blame(&fx.repo(), "sub/../math.c", "").unwrap_err().code, -1);
        // Revision expressions and non-canonical paths are accepted.
        let parent: Value = serde_json::from_str(&blame(&fx.repo(), ".//math.c", "main~1").unwrap()).unwrap();
        assert_eq!(parent["path"], "math.c");
        assert_eq!(parent["revision"], git_output(&fx.dir, &["rev-parse", "main~1"]).trim());
    }
}
