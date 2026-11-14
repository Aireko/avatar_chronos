//! Opening a pull request from the app, through the GitHub CLI (`gh`).
//!
//! Same rules as [`super::github`]: `gh` is started with an argument vector
//! (never a shell), every name is validated first, and the title and
//! description travel as `--title=...` and on stdin, so text that starts with
//! `-` can never be read as an option.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::error::BugCheckError;
use super::github::{GH_POST_TIMEOUT, GH_TIMEOUT, GhRunner, RealGh, classify_failure, validate_repo};

const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_BYTES: usize = 60_000;
const MAX_BRANCH_CHARS: usize = 255;

/// An open PR that already exists for the branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingPr {
    pub number: u64,
    pub title: String,
    pub url: String,
}

/// What the form needs before it is shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreateInfo {
    pub default_branch: String,
    pub existing: Option<ExistingPr>,
}

/// The PR that was just created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPr {
    pub number: u64,
    pub url: String,
}

/// Everything `gh pr create` needs.
pub struct NewPr<'a> {
    pub repo: &'a str,
    pub head: &'a str,
    pub base: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub draft: bool,
}

#[derive(Deserialize)]
struct WirePr {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
}

/// Checks a branch name: letters, digits, `.`, `_`, `-`, `/`; starts with a
/// letter or digit (never `-`); no `..`; no trailing `/` or `.`.
pub fn validate_branch(field: &str, branch: &str) -> Result<(), BugCheckError> {
    let first_ok = branch.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    let chars_ok = branch.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    if first_ok
        && chars_ok
        && branch.len() <= MAX_BRANCH_CHARS
        && !branch.contains("..")
        && !branch.ends_with('/')
        && !branch.ends_with('.')
    {
        Ok(())
    } else {
        Err(BugCheckError::invalid_request(
            field,
            "must be a plain branch name (letters, digits, '.', '_', '-' or '/', starting with a letter or digit)",
        ))
    }
}

fn clean_title(title: &str) -> Result<String, BugCheckError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
        return Err(BugCheckError::invalid_request(
            "title",
            format!("must be 1 to {MAX_TITLE_CHARS} characters on a single line"),
        ));
    }
    Ok(title.to_owned())
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

async fn run_gh(
    runner: &dyn GhRunner,
    args: Vec<String>,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    what: &str,
) -> Result<Vec<u8>, BugCheckError> {
    let output = runner.run(args, stdin, timeout).await?;
    if output.success() { Ok(output.stdout) } else { Err(classify_failure(&output, what)) }
}

/// The repo's default branch and the open PR of `head`, if there is one.
pub async fn fetch_info(runner: &dyn GhRunner, repo: &str, head: &str) -> Result<PrCreateInfo, BugCheckError> {
    validate_repo(repo)?;
    validate_branch("head", head)?;
    let what = format!("Repository {repo}");

    let args = strings(&["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
    let stdout = run_gh(runner, args, None, GH_TIMEOUT, &what).await?;
    let name = String::from_utf8_lossy(&stdout).trim().to_owned();
    let default_branch = if name != "null" && validate_branch("base", &name).is_ok() { name } else { "main".to_owned() };

    let args = strings(&[
        "pr", "list", "--repo", repo, "--head", head, "--state", "open", "--limit", "1", "--json", "number,title,url",
    ]);
    let stdout = run_gh(runner, args, None, GH_TIMEOUT, &what).await?;
    let prs: Vec<WirePr> = serde_json::from_slice(&stdout)
        .map_err(|err| BugCheckError::github_failed(format!("gh pr list printed unexpected JSON: {err}")))?;
    let existing = prs.into_iter().next().map(|pr| ExistingPr { number: pr.number, title: pr.title, url: pr.url });
    Ok(PrCreateInfo { default_branch, existing })
}

/// Opens a PR from `pr.head` into `pr.base`. The branch must already be on origin.
pub async fn create_pr(runner: &dyn GhRunner, pr: NewPr<'_>) -> Result<CreatedPr, BugCheckError> {
    validate_repo(pr.repo)?;
    validate_branch("head", pr.head)?;
    validate_branch("base", pr.base)?;
    if pr.head == pr.base {
        return Err(BugCheckError::invalid_request("base", "must differ from the head branch"));
    }
    let title = clean_title(pr.title)?;
    if pr.body.len() > MAX_BODY_BYTES {
        return Err(BugCheckError::invalid_request("body", format!("must be at most {MAX_BODY_BYTES} bytes")));
    }

    let mut args = strings(&["pr", "create"]);
    args.push(format!("--repo={}", pr.repo));
    args.push(format!("--head={}", pr.head));
    args.push(format!("--base={}", pr.base));
    args.push(format!("--title={title}"));
    args.push("--body-file=-".to_owned());
    if pr.draft {
        args.push("--draft".to_owned());
    }
    let what = format!("Repository {}", pr.repo);
    let stdout = run_gh(runner, args, Some(pr.body.as_bytes().to_vec()), GH_POST_TIMEOUT, &what).await?;
    parse_created(&stdout)
}

/// `gh pr create` prints the new PR's URL as its last line.
fn parse_created(stdout: &[u8]) -> Result<CreatedPr, BugCheckError> {
    let text = String::from_utf8_lossy(stdout);
    let url = text.lines().map(str::trim).rev().find(|line| !line.is_empty()).unwrap_or("");
    let number = url
        .strip_prefix("https://")
        .and_then(|rest| rest.split_once("/pull/"))
        .and_then(|(_, tail)| tail.split(['/', '?', '#']).next())
        .and_then(|digits| digits.parse::<u64>().ok());
    match number {
        Some(number) => Ok(CreatedPr { number, url: url.to_owned() }),
        None => Err(BugCheckError::github_failed(
            "gh did not print the new pull request's URL; check GitHub to see whether it was created",
        )),
    }
}

/// Default branch and existing PR of `head` in `repo` (`owner/name`).
#[tauri::command]
pub async fn pr_create_info(repo: String, head: String) -> Result<PrCreateInfo, BugCheckError> {
    fetch_info(&RealGh, &repo, &head).await
}

/// Opens a pull request. Only ever invoked by an explicit user action.
#[tauri::command]
pub async fn pr_create_open(
    repo: String,
    head: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<CreatedPr, BugCheckError> {
    create_pr(&RealGh, NewPr { repo: &repo, head: &head, base: &base, title: &title, body: &body, draft }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::error::BugCheckErrorKind;
    use crate::review::github::GhOutput;
    use crate::review::github::fake::FakeGh;

    fn new_pr<'a>(head: &'a str, base: &'a str, title: &'a str) -> NewPr<'a> {
        NewPr { repo: "o/r", head, base, title, body: "Body text", draft: false }
    }

    #[test]
    fn unit_validates_branch_names() {
        for good in ["main", "feature/x", "fix_1.2-a", "0abc"] {
            assert!(validate_branch("head", good).is_ok(), "{good}");
        }
        let long = "a".repeat(256);
        for bad in ["", "-x", "a b", "a..b", "a/", "a.", "a;b", "a\nb", "\u{e9}", long.as_str()] {
            let error = validate_branch("head", bad).unwrap_err();
            assert_eq!(error.kind, BugCheckErrorKind::InvalidRequest, "{bad}");
        }
    }

    #[tokio::test]
    async fn mocked_info_reads_default_branch_and_existing_pr() {
        let gh = FakeGh::new(|args| match args[0].as_str() {
            "repo" => Ok(GhOutput::ok("main\n")),
            _ => Ok(GhOutput::ok(r#"[{"number":7,"title":"Add thing","url":"https://github.com/o/r/pull/7"}]"#)),
        });
        let info = fetch_info(&*gh, "o/r", "feature").await.unwrap();
        assert_eq!(info.default_branch, "main");
        assert_eq!(
            info.existing,
            Some(ExistingPr { number: 7, title: "Add thing".into(), url: "https://github.com/o/r/pull/7".into() })
        );
        let calls = gh.calls();
        assert_eq!(
            calls[0].args,
            ["repo", "view", "o/r", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]
        );
        assert_eq!(calls[1].args[..6], ["pr", "list", "--repo", "o/r", "--head", "feature"]);
    }

    #[tokio::test]
    async fn mocked_info_without_pr_or_default_branch() {
        let gh = FakeGh::new(|args| match args[0].as_str() {
            "repo" => Ok(GhOutput::ok("null\n")),
            _ => Ok(GhOutput::ok("[]")),
        });
        let info = fetch_info(&*gh, "o/r", "feature").await.unwrap();
        assert_eq!(info, PrCreateInfo { default_branch: "main".into(), existing: None });
    }

    #[tokio::test]
    async fn mocked_create_sends_safe_arguments() {
        let gh = FakeGh::new(|_| Ok(GhOutput::ok("https://github.com/o/r/pull/12\n")));
        let pr = NewPr { draft: true, ..new_pr("feature", "main", "  -Fix: parser  ") };
        let created = create_pr(&*gh, pr).await.unwrap();
        assert_eq!(created, CreatedPr { number: 12, url: "https://github.com/o/r/pull/12".into() });
        let calls = gh.calls();
        let call = &calls[0];
        assert_eq!(
            call.args,
            [
                "pr",
                "create",
                "--repo=o/r",
                "--head=feature",
                "--base=main",
                "--title=-Fix: parser",
                "--body-file=-",
                "--draft"
            ]
        );
        assert_eq!(call.stdin.as_deref(), Some(&b"Body text"[..]));
        assert_eq!(call.timeout, GH_POST_TIMEOUT);
    }

    #[tokio::test]
    async fn mocked_create_rejects_bad_input_before_calling_gh() {
        let gh = FakeGh::new(|_| panic!("gh must not be called"));
        let kind = |result: Result<CreatedPr, BugCheckError>| result.unwrap_err().kind;
        assert_eq!(kind(create_pr(&*gh, new_pr("main", "main", "t")).await), BugCheckErrorKind::InvalidRequest);
        assert_eq!(kind(create_pr(&*gh, new_pr("--help", "main", "t")).await), BugCheckErrorKind::InvalidRequest);
        assert_eq!(kind(create_pr(&*gh, new_pr("a", "main", "   ")).await), BugCheckErrorKind::InvalidRequest);
        assert_eq!(kind(create_pr(&*gh, new_pr("a", "main", "two\nlines")).await), BugCheckErrorKind::InvalidRequest);
        let bad_repo = NewPr { repo: "-o/r", ..new_pr("a", "main", "t") };
        assert_eq!(kind(create_pr(&*gh, bad_repo).await), BugCheckErrorKind::InvalidRequest);
        let big = "x".repeat(MAX_BODY_BYTES + 1);
        let big_body = NewPr { body: &big, ..new_pr("a", "main", "t") };
        assert_eq!(kind(create_pr(&*gh, big_body).await), BugCheckErrorKind::InvalidRequest);
        assert!(gh.calls().is_empty());
    }

    #[tokio::test]
    async fn mocked_create_maps_auth_and_missing_url() {
        let gh = FakeGh::new(|_| Ok(GhOutput::failed("To get started with GitHub CLI, please run:  gh auth login")));
        let error = create_pr(&*gh, new_pr("a", "main", "t")).await.unwrap_err();
        assert_eq!(error.kind, BugCheckErrorKind::GhNotAuthenticated);

        let gh = FakeGh::new(|_| Ok(GhOutput::ok("done\n")));
        let error = create_pr(&*gh, new_pr("a", "main", "t")).await.unwrap_err();
        assert_eq!(error.kind, BugCheckErrorKind::GithubFailed);
    }
}