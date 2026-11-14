//! GitHub access, only through the [GitHub CLI](https://cli.github.com) (`gh`).
//!
//! Using `gh` means the app never stores a GitHub token: it reuses the user's
//! `gh auth login`. Every call goes through a [`GhRunner`], so tests swap the
//! real process ([`RealGh`]) for a fake that records calls and returns canned
//! output.
//!
//! Safety:
//! * `gh` is started directly with an argument vector, never through a shell.
//! * The repository name and PR number are validated before any call (a repo
//!   can never start with `-`, so it cannot be read as an option).
//! * Each call has a timeout (30 s, posting 60 s) and its stdout is capped at
//!   32 MiB; the process is killed when the call is dropped or times out.
//! * Error messages carry the first line of `gh`'s stderr (at most 300
//!   characters), never PR code.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use super::error::{BugCheckError, MAX_GH_ERROR_CHARS, truncate_chars};
use super::types::{GhStatus, PostResult, PrFile, PullRequestSummary};

/// Timeout of a read-only `gh` call.
pub const GH_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout of a `gh` call that posts a review.
pub const GH_POST_TIMEOUT: Duration = Duration::from_secs(60);
/// Most stdout bytes kept from one `gh` call.
pub const MAX_GH_STDOUT_BYTES: usize = 32 * 1024 * 1024;
/// Most stderr bytes kept from one `gh` call.
const MAX_GH_STDERR_BYTES: usize = 64 * 1024;
/// Highest PR number accepted.
pub const MAX_PR_NUMBER: u64 = 10_000_000;
/// Open PRs listed per poll.
pub const PR_LIST_LIMIT: u32 = 50;
/// The `--json` fields of `gh pr list` / `gh pr view`.
const PR_FIELDS: &str = "number,title,author,headRefOid,headRefName,baseRefName,isDraft,updatedAt,url,additions,deletions,changedFiles,state";

/// What a `gh` process produced.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct GhOutput {
    /// The exit code (`None` when killed by a signal).
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl GhOutput {
    /// A successful call printing `stdout`.
    pub fn ok(stdout: impl Into<Vec<u8>>) -> Self {
        Self { exit_code: Some(0), stdout: stdout.into(), stderr: String::new() }
    }

    /// A failed call (exit code 1) printing `stderr`.
    pub fn failed(stderr: &str) -> Self {
        Self { exit_code: Some(1), stdout: Vec::new(), stderr: stderr.to_owned() }
    }

    /// Whether `gh` exited with code 0.
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// stdout can be PR code, so only its size is printed.
impl fmt::Debug for GhOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GhOutput")
            .field("exit_code", &self.exit_code)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

/// The future returned by [`GhRunner::run`].
pub type GhFuture<'a> = Pin<Box<dyn Future<Output = Result<GhOutput, BugCheckError>> + Send + 'a>>;

/// Runs `gh` with `args` (without the `gh` itself), optionally writing `stdin`.
///
/// A non-zero exit is returned as an [`GhOutput`]; `Err` is for failures to
/// run at all (`gh_not_installed`, timeout, output too large).
pub trait GhRunner: Send + Sync {
    fn run(&self, args: Vec<String>, stdin: Option<Vec<u8>>, timeout: Duration) -> GhFuture<'_>;
}

/// Runs the real `gh` executable from `PATH`.
#[derive(Debug, Clone, Default)]
pub struct RealGh;

impl GhRunner for RealGh {
    fn run(&self, args: Vec<String>, stdin: Option<Vec<u8>>, timeout: Duration) -> GhFuture<'_> {
        Box::pin(async move {
            match tokio::time::timeout(timeout, run_gh_process(&args, stdin)).await {
                Ok(result) => result,
                // Dropping the future kills the process (kill_on_drop).
                Err(_) => {
                    Err(BugCheckError::github_failed(format!("gh did not finish within {} s", timeout.as_secs()))
                        .with_hint("Check your network connection and try again"))
                }
            }
        })
    }
}

async fn run_gh_process(args: &[String], stdin: Option<Vec<u8>>) -> Result<GhOutput, BugCheckError> {
    let mut command = tokio::process::Command::new("gh");
    command
        .args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        /// Keeps a console window from flashing up for every call.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            BugCheckError::gh_not_installed()
        } else {
            BugCheckError::github_failed(format!("Could not start gh: {err}"))
        }
    })?;

    let stdout = child.stdout.take().ok_or_else(|| BugCheckError::internal("gh stdout is not piped"))?;
    let stderr = child.stderr.take().ok_or_else(|| BugCheckError::internal("gh stderr is not piped"))?;
    let writer = child.stdin.take();
    let write_stdin = async move {
        if let (Some(mut writer), Some(bytes)) = (writer, stdin) {
            // A write error shows up as gh's own failure below.
            let _ = writer.write_all(&bytes).await;
            let _ = writer.shutdown().await;
        }
    };
    let (_, stdout, stderr) =
        tokio::join!(write_stdin, read_capped(stdout, MAX_GH_STDOUT_BYTES), read_capped(stderr, MAX_GH_STDERR_BYTES));
    let (stdout, stderr) = (stdout?, stderr?);
    let status = child.wait().await.map_err(|err| BugCheckError::github_failed(format!("gh failed: {err}")))?;
    Ok(GhOutput { exit_code: status.code(), stdout, stderr: String::from_utf8_lossy(&stderr).into_owned() })
}

/// Reads `reader` to the end, failing once more than `cap` bytes arrive.
async fn read_capped(mut reader: impl AsyncRead + Unpin, cap: usize) -> Result<Vec<u8>, BugCheckError> {
    let mut buffer = Vec::new();
    let mut scratch = vec![0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut scratch)
            .await
            .map_err(|err| BugCheckError::github_failed(format!("Could not read gh output: {err}")))?;
        if read == 0 {
            return Ok(buffer);
        }
        if buffer.len() + read > cap {
            return Err(BugCheckError::github_failed(format!(
                "gh printed more than {} MiB; the pull request is too large",
                cap / (1024 * 1024)
            )));
        }
        buffer.extend_from_slice(&scratch[..read]);
    }
}

/// Checks `owner/name`: 1..=100 characters each of `[A-Za-z0-9._-]`, each
/// starting with a letter or digit (so never with `-`).
pub fn validate_repo(repo: &str) -> Result<(), BugCheckError> {
    fn valid_part(part: &str) -> bool {
        let mut chars = part.chars();
        let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
        first_ok && part.len() <= 100 && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    }
    match repo.split_once('/') {
        Some((owner, name)) if valid_part(owner) && valid_part(name) => Ok(()),
        _ => Err(BugCheckError::invalid_request(
            "repo",
            "must look like owner/name (letters, digits, '.', '_' or '-', not starting with '-' or '.')",
        )),
    }
}

/// Checks a PR number: `1..=10_000_000`.
pub fn validate_pr_number(number: u64) -> Result<(), BugCheckError> {
    if (1..=MAX_PR_NUMBER).contains(&number) {
        Ok(())
    } else {
        Err(BugCheckError::invalid_request("number", format!("must be between 1 and {MAX_PR_NUMBER}")))
    }
}

/// Maps a failed `gh` call to a [`BugCheckError`]. `what` names the call for
/// 404 messages, e.g. `Pull request owner/name#3`.
pub fn classify_failure(output: &GhOutput, what: &str) -> BugCheckError {
    let lower = output.stderr.to_ascii_lowercase();
    let unauthenticated = ["gh auth login", "not logged in", "authentication required", "http 401", "bad credentials"];
    if unauthenticated.iter().any(|needle| lower.contains(needle)) {
        return BugCheckError::gh_not_authenticated();
    }
    let not_found = ["http 404", "not found", "could not resolve to"];
    if not_found.iter().any(|needle| lower.contains(needle)) {
        return BugCheckError::not_found(format!("{what} was not found on GitHub"));
    }
    let first_line = output.stderr.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    let mut detail = match first_line {
        "" => format!("gh failed (exit code {})", output.exit_code.map_or("none".into(), |code| code.to_string())),
        line if line.starts_with("gh:") => truncate_chars(line, MAX_GH_ERROR_CHARS),
        line => format!("gh: {}", truncate_chars(line, MAX_GH_ERROR_CHARS)),
    };
    // REST errors (e.g. 422 on a review) explain themselves in the JSON body.
    if let Some(api_detail) = api_error_detail(&output.stdout) {
        detail.push_str(&format!(" ({})", truncate_chars(&api_detail, MAX_GH_ERROR_CHARS)));
    }
    BugCheckError::github_failed(detail)
}

/// `message` and `errors` of a GitHub REST error body, if stdout is one.
fn api_error_detail(stdout: &[u8]) -> Option<String> {
    let body: Value = serde_json::from_slice(stdout).ok()?;
    let mut parts = vec![body.get("message")?.as_str()?.to_owned()];
    for error in body.get("errors").and_then(Value::as_array).into_iter().flatten() {
        match error {
            Value::String(text) => parts.push(text.clone()),
            Value::Object(object) => {
                if let Some(text) = object.get("message").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            _ => {}
        }
    }
    Some(parts.join("; "))
}

/// One inline comment of a review.
#[derive(Clone, PartialEq, Eq)]
pub struct ReviewComment {
    pub path: String,
    pub line: u32,
    pub start_line: Option<u32>,
    pub body: String,
}

impl fmt::Debug for ReviewComment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReviewComment")
            .field("path", &self.path)
            .field("line", &self.line)
            .field("start_line", &self.start_line)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

/// The JSON body of `POST /repos/{repo}/pulls/{n}/reviews` (event `COMMENT`,
/// every comment on the RIGHT side).
pub fn review_payload(commit_id: &str, body: &str, comments: &[ReviewComment]) -> Value {
    let comments: Vec<Value> = comments
        .iter()
        .map(|comment| {
            let mut value =
                json!({ "path": comment.path, "line": comment.line, "side": "RIGHT", "body": comment.body });
            if let Some(start) = comment.start_line.filter(|start| *start < comment.line) {
                value["start_line"] = json!(start);
                value["start_side"] = json!("RIGHT");
            }
            value
        })
        .collect();
    json!({ "commit_id": commit_id, "body": body, "event": "COMMENT", "comments": comments })
}

/// GitHub operations on top of a [`GhRunner`].
#[derive(Clone)]
pub struct GitHub {
    runner: Arc<dyn GhRunner>,
}

impl fmt::Debug for GitHub {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GitHub")
    }
}

/// `gh pr list/view --json` output.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePr {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: Option<WireAuthor>,
    #[serde(default)]
    head_ref_oid: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Deserialize)]
struct WireAuthor {
    #[serde(default)]
    login: String,
}

impl WirePr {
    fn into_summary(self) -> (PullRequestSummary, String) {
        let summary = PullRequestSummary {
            number: self.number,
            title: self.title,
            author: self.author.map(|author| author.login).unwrap_or_default(),
            head_ref_oid: self.head_ref_oid,
            head_ref_name: self.head_ref_name,
            base_ref_name: self.base_ref_name,
            is_draft: self.is_draft,
            updated_at: self.updated_at,
            url: self.url,
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            state: self.state,
        };
        (summary, self.body.unwrap_or_default())
    }
}

/// An element of `GET /repos/{repo}/pulls/{n}/files`.
#[derive(Deserialize)]
struct WireFile {
    filename: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    patch: Option<String>,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    previous_filename: Option<String>,
}

impl GitHub {
    /// GitHub through `runner`.
    pub fn new(runner: Arc<dyn GhRunner>) -> Self {
        Self { runner }
    }

    /// GitHub through the real `gh` executable.
    pub fn real() -> Self {
        Self::new(Arc::new(RealGh))
    }

    async fn call(
        &self,
        args: &[&str],
        stdin: Option<Vec<u8>>,
        timeout: Duration,
        what: &str,
    ) -> Result<Vec<u8>, BugCheckError> {
        let args = args.iter().map(|arg| (*arg).to_owned()).collect();
        let output = self.runner.run(args, stdin, timeout).await?;
        if output.success() { Ok(output.stdout) } else { Err(classify_failure(&output, what)) }
    }

    /// Whether `gh` is installed and logged in, and as whom. Never fails.
    pub async fn status(&self) -> GhStatus {
        if let Err(error) = self.call(&["--version"], None, GH_TIMEOUT, "gh").await {
            let installed = error.kind != super::error::BugCheckErrorKind::GhNotInstalled;
            return GhStatus { installed, authenticated: false, user: None, error: Some(error) };
        }
        match self.call(&["api", "user", "--jq", ".login"], None, GH_TIMEOUT, "The GitHub user").await {
            Ok(stdout) => {
                let user = String::from_utf8_lossy(&stdout).trim().to_owned();
                GhStatus { installed: true, authenticated: true, user: (!user.is_empty()).then_some(user), error: None }
            }
            Err(error) => GhStatus { installed: true, authenticated: false, user: None, error: Some(error) },
        }
    }

    /// Up to 50 open PRs of `repo`, newest first.
    pub async fn list_open_prs(&self, repo: &str) -> Result<Vec<PullRequestSummary>, BugCheckError> {
        validate_repo(repo)?;
        let limit = PR_LIST_LIMIT.to_string();
        let args = ["pr", "list", "--repo", repo, "--state", "open", "--limit", &limit, "--json", PR_FIELDS];
        let stdout = self.call(&args, None, GH_TIMEOUT, &format!("Repository {repo}")).await?;
        let prs: Vec<WirePr> = serde_json::from_slice(&stdout)
            .map_err(|err| BugCheckError::github_failed(format!("gh pr list printed unexpected JSON: {err}")))?;
        Ok(prs.into_iter().map(|pr| pr.into_summary().0).collect())
    }

    /// One PR (open, closed or merged).
    pub async fn get_pr(&self, repo: &str, number: u64) -> Result<PullRequestSummary, BugCheckError> {
        Ok(self.get_pr_with_body(repo, number).await?.0)
    }

    /// One PR plus its description (untrusted text, used in prompts only).
    pub async fn get_pr_with_body(
        &self,
        repo: &str,
        number: u64,
    ) -> Result<(PullRequestSummary, String), BugCheckError> {
        validate_repo(repo)?;
        validate_pr_number(number)?;
        let number_arg = number.to_string();
        let fields = format!("{PR_FIELDS},body");
        let args = ["pr", "view", &number_arg, "--repo", repo, "--json", &fields];
        let stdout = self.call(&args, None, GH_TIMEOUT, &format!("Pull request {repo}#{number}")).await?;
        let pr: WirePr = serde_json::from_slice(&stdout)
            .map_err(|err| BugCheckError::github_failed(format!("gh pr view printed unexpected JSON: {err}")))?;
        Ok(pr.into_summary())
    }

    /// Every changed file of a PR (GitHub lists at most 3000).
    pub async fn get_pr_files(&self, repo: &str, number: u64) -> Result<Vec<PrFile>, BugCheckError> {
        validate_repo(repo)?;
        validate_pr_number(number)?;
        let path = format!("repos/{repo}/pulls/{number}/files?per_page=100");
        let args = ["api", "--paginate", &path, "--jq", ".[]"];
        let stdout = self.call(&args, None, GH_TIMEOUT, &format!("Pull request {repo}#{number}")).await?;
        parse_files(&stdout)
    }

    /// Posts one review with event `COMMENT`. Returns the review URL and how
    /// many inline comments it carried.
    pub async fn post_review(
        &self,
        repo: &str,
        number: u64,
        commit_id: &str,
        body: &str,
        comments: &[ReviewComment],
    ) -> Result<PostResult, BugCheckError> {
        validate_repo(repo)?;
        validate_pr_number(number)?;
        let payload = review_payload(commit_id, body, comments);
        let stdin = serde_json::to_vec(&payload).map_err(|err| BugCheckError::internal(err.to_string()))?;
        let path = format!("repos/{repo}/pulls/{number}/reviews");
        let args = ["api", "--method", "POST", &path, "--input", "-"];
        let stdout = self.call(&args, Some(stdin), GH_POST_TIMEOUT, &format!("Pull request {repo}#{number}")).await?;
        let review_url = serde_json::from_slice::<Value>(&stdout)
            .ok()
            .and_then(|value| value.get("html_url").and_then(Value::as_str).map(str::to_owned));
        Ok(PostResult { review_url, posted_count: comments.len(), ..PostResult::default() })
    }
}

/// Parses the files listing: NDJSON from `--jq '.[]'`, or concatenated JSON
/// arrays (one per page) from a plain `--paginate`.
pub fn parse_files(stdout: &[u8]) -> Result<Vec<PrFile>, BugCheckError> {
    let mut files = Vec::new();
    for value in serde_json::Deserializer::from_slice(stdout).into_iter::<Value>() {
        let value =
            value.map_err(|err| BugCheckError::github_failed(format!("gh api printed unexpected JSON: {err}")))?;
        let items = match value {
            Value::Array(items) => items,
            other => vec![other],
        };
        for item in items {
            let file: WireFile = serde_json::from_value(item).map_err(|err| {
                BugCheckError::github_failed(format!("gh api printed an unexpected file entry: {err}"))
            })?;
            files.push(PrFile {
                path: file.filename,
                status: file.status,
                patch: file.patch,
                additions: file.additions,
                deletions: file.deletions,
                previous_path: file.previous_filename,
            });
        }
    }
    Ok(files)
}

/// A fake `gh` for tests: records every call and answers through a handler.
#[cfg(test)]
pub mod fake {
    use std::sync::Mutex;

    use super::*;

    /// One recorded call.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct GhCall {
        pub args: Vec<String>,
        pub stdin: Option<Vec<u8>>,
        pub timeout: Duration,
    }

    impl GhCall {
        /// `stdin` parsed as JSON (`Null` when absent or invalid).
        pub fn stdin_json(&self) -> Value {
            self.stdin.as_deref().and_then(|bytes| serde_json::from_slice(bytes).ok()).unwrap_or(Value::Null)
        }
    }

    type Handler = dyn Fn(&[String]) -> Result<GhOutput, BugCheckError> + Send + Sync;

    /// Answers each call with `handler(args)`.
    pub struct FakeGh {
        handler: Box<Handler>,
        calls: Mutex<Vec<GhCall>>,
    }

    impl FakeGh {
        pub fn new(
            handler: impl Fn(&[String]) -> Result<GhOutput, BugCheckError> + Send + Sync + 'static,
        ) -> Arc<Self> {
            Arc::new(Self { handler: Box::new(handler), calls: Mutex::new(Vec::new()) })
        }

        /// Every call so far.
        pub fn calls(&self) -> Vec<GhCall> {
            self.calls.lock().unwrap().clone()
        }

        /// The calls whose arguments contain `needle`.
        pub fn calls_with(&self, needle: &str) -> Vec<GhCall> {
            self.calls().into_iter().filter(|call| call.args.iter().any(|arg| arg == needle)).collect()
        }
    }

    impl GhRunner for FakeGh {
        fn run(&self, args: Vec<String>, stdin: Option<Vec<u8>>, timeout: Duration) -> GhFuture<'_> {
            let result = (self.handler)(&args);
            self.calls.lock().unwrap().push(GhCall { args, stdin, timeout });
            Box::pin(async move { result })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeGh;
    use super::*;
    use crate::review::error::BugCheckErrorKind;

    fn pr_json(number: u64, sha: &str) -> Value {
        json!({
            "number": number, "title": "Fix it", "author": { "login": "octo", "is_bot": false }, "headRefOid": sha,
            "headRefName": "feature", "baseRefName": "main", "isDraft": false, "updatedAt": "2026-11-13T21:35:25Z",
            "url": format!("https://github.com/o/r/pull/{number}"), "additions": 3, "deletions": 1, "changedFiles": 1,
            "state": "OPEN", "body": "desc",
        })
    }

    #[test]
    fn unit_validates_repo_names() {
        for good in ["Aireko/avatar", "a/b", "my.org/repo_name-2", "0x/1.2"] {
            assert!(validate_repo(good).is_ok(), "{good}");
        }
        let long = format!("a/{}", "b".repeat(101));
        for bad in ["", "a", "a/", "/b", "-a/b", "a/-b", "a/b/c", ".a/b", "a/.b", "a b/c", "a/b;rm", "a/b\n", &long] {
            let error = validate_repo(bad).unwrap_err();
            assert_eq!(error.kind, BugCheckErrorKind::InvalidRequest, "{bad}");
        }
    }

    #[test]
    fn unit_validates_pr_numbers() {
        assert!(validate_pr_number(1).is_ok());
        assert!(validate_pr_number(MAX_PR_NUMBER).is_ok());
        assert!(validate_pr_number(0).is_err());
        assert!(validate_pr_number(MAX_PR_NUMBER + 1).is_err());
    }

    #[test]
    fn unit_classifies_gh_failures() {
        let not_logged_in =
            GhOutput::failed("You are not logged into any GitHub hosts. To log in, run: gh auth login\n");
        assert_eq!(classify_failure(&not_logged_in, "x").kind, BugCheckErrorKind::GhNotAuthenticated);
        let hint = classify_failure(&not_logged_in, "x").hint.unwrap();
        assert!(hint.contains("gh auth login"));

        let api_404 = GhOutput {
            exit_code: Some(1),
            stdout: br#"{"message":"Not Found","status":"404"}"#.to_vec(),
            stderr: "gh: Not Found (HTTP 404)\n".into(),
        };
        let error = classify_failure(&api_404, "Pull request o/r#9");
        assert_eq!(error.kind, BugCheckErrorKind::NotFound);
        assert!(error.message.contains("o/r#9"));
        let graphql_404 = GhOutput::failed("GraphQL: Could not resolve to a PullRequest with the number of 99999.");
        assert_eq!(classify_failure(&graphql_404, "x").kind, BugCheckErrorKind::NotFound);

        let unprocessable = GhOutput {
            exit_code: Some(1),
            stdout: br#"{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}"#.to_vec(),
            stderr: format!("gh: Unprocessable Entity (HTTP 422)\n{}\n", "x".repeat(1000)),
        };
        let error = classify_failure(&unprocessable, "x");
        assert_eq!(error.kind, BugCheckErrorKind::GithubFailed);
        assert!(error.message.starts_with("gh: Unprocessable Entity (HTTP 422)"), "{}", error.message);
        assert!(error.message.contains("Line could not be resolved"));
        assert!(!error.message.contains("xxxx"), "only the first stderr line is used");

        let long = GhOutput::failed(&"y".repeat(1000));
        assert!(classify_failure(&long, "x").message.chars().count() <= MAX_GH_ERROR_CHARS + 10);
    }

    #[tokio::test]
    async fn mocked_missing_gh_binary_is_reported() {
        let gh = FakeGh::new(|_| Err(BugCheckError::gh_not_installed()));
        let status = GitHub::new(gh.clone()).status().await;
        assert!(!status.installed);
        assert!(!status.authenticated);
        assert_eq!(status.error.unwrap().kind, BugCheckErrorKind::GhNotInstalled);
        assert_eq!(gh.calls().len(), 1, "stops after gh --version");
    }

    #[tokio::test]
    async fn mocked_status_reports_login() {
        let gh = FakeGh::new(|args| match args[0].as_str() {
            "--version" => Ok(GhOutput::ok("gh version 2.104.0\n")),
            _ => Ok(GhOutput::ok("octo\n")),
        });
        let status = GitHub::new(gh.clone()).status().await;
        assert_eq!(status, GhStatus { installed: true, authenticated: true, user: Some("octo".into()), error: None });
        assert_eq!(gh.calls()[1].args, ["api", "user", "--jq", ".login"]);

        let gh = FakeGh::new(|args| match args[0].as_str() {
            "--version" => Ok(GhOutput::ok("gh version 2.104.0\n")),
            _ => Ok(GhOutput::failed("To get started with GitHub CLI, please run:  gh auth login")),
        });
        let status = GitHub::new(gh).status().await;
        assert!(status.installed);
        assert!(!status.authenticated);
        assert_eq!(status.error.unwrap().kind, BugCheckErrorKind::GhNotAuthenticated);
    }

    #[tokio::test]
    async fn mocked_lists_and_views_prs_with_safe_arguments() {
        let gh = FakeGh::new(|args| match args[1].as_str() {
            "list" => Ok(GhOutput::ok(serde_json::to_vec(&json!([pr_json(6, "abc"), pr_json(5, "def")])).unwrap())),
            _ => Ok(GhOutput::ok(serde_json::to_vec(&pr_json(6, "abc")).unwrap())),
        });
        let github = GitHub::new(gh.clone());
        let prs = github.list_open_prs("o/r").await.unwrap();
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].author, "octo");
        assert_eq!(prs[0].head_ref_oid, "abc");
        assert_eq!(gh.calls()[0].args[..8], ["pr", "list", "--repo", "o/r", "--state", "open", "--limit", "50"]);
        assert_eq!(gh.calls()[0].timeout, GH_TIMEOUT);

        let (pr, body) = github.get_pr_with_body("o/r", 6).await.unwrap();
        assert_eq!(pr.number, 6);
        assert_eq!(body, "desc");
        assert_eq!(gh.calls()[1].args[..5], ["pr", "view", "6", "--repo", "o/r"]);
    }

    #[tokio::test]
    async fn mocked_rejects_bad_input_before_calling_gh() {
        let gh = FakeGh::new(|_| panic!("gh must not be called"));
        let github = GitHub::new(gh.clone());
        assert_eq!(github.list_open_prs("--help/x").await.unwrap_err().kind, BugCheckErrorKind::InvalidRequest);
        assert_eq!(github.get_pr("o/r", 0).await.unwrap_err().kind, BugCheckErrorKind::InvalidRequest);
        assert_eq!(github.get_pr_files("-o/r", 1).await.unwrap_err().kind, BugCheckErrorKind::InvalidRequest);
        assert!(gh.calls().is_empty());
    }

    #[tokio::test]
    async fn mocked_maps_404_and_auth_errors() {
        let gh = FakeGh::new(|_| {
            Ok(GhOutput {
                exit_code: Some(1),
                stdout: br#"{"message":"Not Found"}"#.to_vec(),
                stderr: "gh: Not Found (HTTP 404)".into(),
            })
        });
        let error = GitHub::new(gh).get_pr_files("o/r", 9).await.unwrap_err();
        assert_eq!(error.kind, BugCheckErrorKind::NotFound);

        let gh = FakeGh::new(|_| Ok(GhOutput::failed("HTTP 401: Bad credentials (https://api.github.com/graphql)")));
        let error = GitHub::new(gh).list_open_prs("o/r").await.unwrap_err();
        assert_eq!(error.kind, BugCheckErrorKind::GhNotAuthenticated);
    }

    #[test]
    fn unit_parses_ndjson_and_concatenated_pages() {
        let ndjson = concat!(
            r#"{"filename":"a.rs","status":"modified","additions":1,"deletions":0,"patch":"@@ -1 +1 @@\n-a\n+b"}"#,
            "\n",
            r#"{"filename":"img.png","status":"added","additions":0,"deletions":0}"#,
            "\n",
            r#"{"filename":"new.rs","status":"renamed","previous_filename":"old.rs","additions":0,"deletions":0}"#,
            "\n"
        );
        let files = parse_files(ndjson.as_bytes()).unwrap();
        assert_eq!(files.len(), 3);
        assert!(files[0].patch.is_some());
        assert!(files[1].patch.is_none());
        assert_eq!(files[2].previous_path.as_deref(), Some("old.rs"));

        let pages = concat!(
            r#"[{"filename":"a","status":"added","additions":1,"deletions":0}]"#,
            r#"[{"filename":"b","status":"added","additions":1,"deletions":0}]"#
        );
        let files = parse_files(pages.as_bytes()).unwrap();
        assert_eq!(files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(parse_files(b"").unwrap().is_empty());
        assert_eq!(parse_files(b"{oops").unwrap_err().kind, BugCheckErrorKind::GithubFailed);
    }

    #[tokio::test]
    async fn mocked_post_review_sends_json_on_stdin() {
        let gh = FakeGh::new(|_| {
            Ok(GhOutput::ok(r#"{"id":1,"html_url":"https://github.com/o/r/pull/6#pullrequestreview-1"}"#))
        });
        let comments = vec![
            ReviewComment { path: "a.rs".into(), line: 10, start_line: Some(8), body: "b1".into() },
            ReviewComment { path: "b.rs".into(), line: 3, start_line: None, body: "b2".into() },
        ];
        let result = GitHub::new(gh.clone()).post_review("o/r", 6, "abc", "summary", &comments).await.unwrap();
        assert_eq!(result.posted_count, 2);
        assert_eq!(result.review_url.as_deref(), Some("https://github.com/o/r/pull/6#pullrequestreview-1"));
        let call = &gh.calls()[0];
        assert_eq!(call.args, ["api", "--method", "POST", "repos/o/r/pulls/6/reviews", "--input", "-"]);
        assert_eq!(call.timeout, GH_POST_TIMEOUT);
        assert_eq!(
            call.stdin_json(),
            json!({
                "commit_id": "abc", "body": "summary", "event": "COMMENT",
                "comments": [
                    { "path": "a.rs", "line": 10, "side": "RIGHT", "start_line": 8, "start_side": "RIGHT", "body": "b1" },
                    { "path": "b.rs", "line": 3, "side": "RIGHT", "body": "b2" },
                ],
            })
        );
    }

    #[test]
    fn unit_debug_output_hides_stdout() {
        let output = GhOutput::ok("secret code");
        assert!(!format!("{output:?}").contains("secret"));
    }
}
