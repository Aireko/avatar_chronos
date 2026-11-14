//! The JSON shapes exchanged with the frontend (mirrored in `src/bugcheck/types.ts`).
//!
//! Everything is camelCase; optional fields are left out when `None`. Reports
//! and settings are also what [`super::store`] writes to disk, so every type
//! here deserializes too (unknown or missing optional fields are tolerated).

use std::fmt;

use serde::{Deserialize, Serialize};

use super::error::BugCheckError;

/// A pull request, as `gh pr list` / `gh pr view` describe it.
///
/// Field names follow `gh --json`, except `author`, which is the login only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    /// The author's login (`""` when GitHub reports none, e.g. a deleted user).
    pub author: String,
    /// The head commit SHA.
    pub head_ref_oid: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    /// RFC 3339 timestamp.
    pub updated_at: String,
    pub url: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
}

/// A changed file of a pull request (from `GET /repos/{repo}/pulls/{n}/files`).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    /// `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`.
    pub status: String,
    /// The unified diff of the file. Absent for binary or very large files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    /// The old path of a renamed or copied file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
}

/// The patch is code from the PR, so it is never printed.
impl fmt::Debug for PrFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PrFile")
            .field("path", &self.path)
            .field("status", &self.status)
            .field("patch_bytes", &self.patch.as_ref().map(String::len))
            .field("additions", &self.additions)
            .field("deletions", &self.deletions)
            .field("previous_path", &self.previous_path)
            .finish()
    }
}

/// How bad a finding is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Critical,
    High,
    #[default]
    Medium,
    Low,
}

impl Severity {
    /// Parses a model-supplied severity; unknown values are `None`.
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "critical" | "blocker" => Some(Self::Critical),
            "high" | "major" | "error" => Some(Self::High),
            "medium" | "moderate" | "warning" => Some(Self::Medium),
            "low" | "minor" | "info" => Some(Self::Low),
            _ => None,
        }
    }

    /// `Critical`, `High`, ...
    pub fn label(self) -> &'static str {
        match self {
            Self::Critical => "Critical",
            Self::High => "High",
            Self::Medium => "Medium",
            Self::Low => "Low",
        }
    }
}

/// What kind of bug a finding describes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    LogicBug,
    StateLeak,
    UnitMismatch,
    Security,
    Concurrency,
    ErrorHandling,
    Performance,
    #[default]
    Other,
}

impl Category {
    /// Every category, in the order the prompt lists them.
    pub const ALL: [Self; 8] = [
        Self::LogicBug,
        Self::StateLeak,
        Self::UnitMismatch,
        Self::Security,
        Self::Concurrency,
        Self::ErrorHandling,
        Self::Performance,
        Self::Other,
    ];

    /// The `snake_case` name used in JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LogicBug => "logic_bug",
            Self::StateLeak => "state_leak",
            Self::UnitMismatch => "unit_mismatch",
            Self::Security => "security",
            Self::Concurrency => "concurrency",
            Self::ErrorHandling => "error_handling",
            Self::Performance => "performance",
            Self::Other => "other",
        }
    }

    /// Parses a model-supplied category; unknown values are `None`.
    pub fn parse(text: &str) -> Option<Self> {
        let normalized = text.trim().to_ascii_lowercase().replace([' ', '-'], "_");
        Self::ALL.into_iter().find(|category| category.as_str() == normalized)
    }

    /// A human label, e.g. `Unit mismatch`.
    pub fn label(self) -> &'static str {
        match self {
            Self::LogicBug => "Logic bug",
            Self::StateLeak => "State leak",
            Self::UnitMismatch => "Unit mismatch",
            Self::Security => "Security",
            Self::Concurrency => "Concurrency",
            Self::ErrorHandling => "Error handling",
            Self::Performance => "Performance",
            Self::Other => "Other",
        }
    }
}

/// One validated finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Stable id: a hash of path, line and normalized title.
    pub id: String,
    pub path: String,
    /// New-side (RIGHT) line number the finding is about.
    pub line: u32,
    /// First line of a multi-line range (`startLine < line`, same hunk).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    pub severity: Severity,
    pub category: Category,
    /// At most 120 characters.
    pub title: String,
    /// At most 4000 characters.
    pub explanation: String,
    /// Replacement for new-side lines `startLine..=line` (or just `line`).
    /// At most 4000 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_fix: Option<String>,
    /// `0..=1`, as reported by the model.
    pub confidence: f64,
    /// Whether the finding can be posted as an inline comment (its line is
    /// part of the diff). Non-postable findings are still shown.
    pub postable: bool,
    /// The line the model cited, when it was moved to the nearest commentable
    /// line. A snapped finding's fix is posted as a plain code block, never
    /// as a one-click GitHub suggestion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapped_from: Option<u32>,
    /// The model gave a multi-line `startLine` that was invalid (after `line`,
    /// in another hunk, or not shown), so it was dropped. Its fix was written
    /// for that range, so it is posted as a plain code block, never as a
    /// one-click GitHub suggestion. Left out when `false`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub range_rejected: bool,
    /// The double-check pass's verdict. Left out when the run had
    /// verification off (or for reports from before it existed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<Verification>,
}

/// What the double-check pass concluded about a finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// The model could name a concrete input or state that triggers the bug.
    Confirmed,
    /// The code shows the finding is wrong (a precondition is false, the
    /// behaviour is intended or documented, or the cited code is misread).
    Refuted,
    /// The diff does not show enough to tell. Filtered out like `refuted`.
    Uncertain,
    /// The double-check itself failed (model error or unusable answer). The
    /// finding is kept, marked as not double-checked.
    Failed,
}

/// The double-check pass's verdict on one finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub verdict: Verdict,
    /// One or two sentences from the model (at most 600 characters), or why
    /// the check failed.
    pub reason: String,
}

/// A changed file that was not reviewed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

/// The result of posting a review.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostResult {
    /// Link to the review on GitHub, when GitHub returned one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_url: Option<String>,
    /// Inline comments posted by this call.
    pub posted_count: usize,
    /// Every finding id posted for this report so far (this call and earlier ones).
    #[serde(default)]
    pub finding_ids: Vec<String>,
    /// When the review was posted (RFC 3339, UTC).
    #[serde(default)]
    pub posted_at: String,
}

/// The outcome of one bug check run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugCheckReport {
    pub run_id: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    /// The PR head commit that was reviewed.
    pub head_sha: String,
    /// The Ollama model that answered.
    pub model: String,
    /// RFC 3339, UTC.
    pub started_at: String,
    pub duration_ms: u64,
    pub files_reviewed: Vec<String>,
    pub files_skipped: Vec<SkippedFile>,
    pub findings: Vec<Finding>,
    /// Non-fatal problems (a chunk that failed or could not be parsed, ...).
    pub notes: Vec<String>,
    /// Set once findings of this report were posted. A re-run on the same
    /// head commit carries it over from the previous report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted: Option<PostResult>,
    /// Line-independent keys (path + normalized title) of every finding
    /// posted on this PR so far, across checks and commits. Carried over to
    /// each new report, so a bug that is still there after a push is not
    /// posted again. Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub posted_keys: Vec<String>,
    /// Ids of findings of this report that were already posted for an
    /// earlier check of the PR (same path and title, maybe another line).
    /// They are not posted again. Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub posted_earlier: Vec<String>,
    /// Findings the double-check refuted or could not confirm, with its
    /// reason. Shown for transparency; never posted. Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filtered: Vec<Finding>,
}

/// Options of one run. Every field is optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugCheckOptions {
    /// Qwen 3.5 reasoning (default `false`: faster, usually good enough).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub think: Option<bool>,
    /// Context window in tokens, `4096..=262144` (default 16384). It must
    /// hold the prompt, a diff part of at least 4096 bytes and the answer, so
    /// in practice at least 8192 (rejected otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_ctx: Option<i64>,
    /// Findings below this confidence are dropped, `0..=1` (default 0.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_confidence: Option<f64>,
    /// Max annotated diff bytes per model call, `4096..=196608` (default 24 KiB).
    /// Lowered to what fits `num_ctx` next to the prompt and the answer
    /// budget (a note in the report says so when a requested size was lowered).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_bytes: Option<usize>,
    /// Double-check every finding with a second, skeptical model call and
    /// drop the ones it refutes or cannot confirm (default `true`). Costs one
    /// extra model call per finding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<bool>,
}

/// Progress of a run, tagged by `type`. Sent through the `onEvent` channel of
/// `bug_check_run` and inside watcher `progress` events.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BugCheckEvent {
    /// The diff was fetched and split; model calls start next.
    Started {
        run_id: String,
        repo: String,
        number: u64,
        head_sha: String,
        total_chunks: usize,
        files_reviewed: Vec<String>,
        files_skipped: Vec<SkippedFile>,
    },
    /// Chunk `index` (0-based) went to the model.
    ChunkStarted { index: usize, files: Vec<String> },
    /// A new validated finding (with double-check on: one that was confirmed,
    /// or whose double-check failed).
    Finding { finding: Finding },
    /// The double-check of finding `current` of `total` (1-based) in chunk
    /// `index` started.
    Verifying { index: usize, current: usize, total: usize, finding_id: String },
    /// The double-check refuted the finding or could not confirm it; it is
    /// kept in the report's `filtered` list, not in `findings`.
    FindingFiltered { finding: Finding },
    /// Chunk `index` finished with `finding_count` new findings.
    ChunkDone { index: usize, finding_count: usize },
    /// Chunk `index` failed (not fatal; recorded in `notes`).
    ChunkFailed { index: usize, error: BugCheckError },
    /// The run finished; the command resolves with the same report.
    Done { report: Box<BugCheckReport> },
    /// The run was cancelled; the command rejects with kind `cancelled`.
    Cancelled,
    /// The run failed; the command rejects with the same error.
    Error { error: BugCheckError },
}

/// Whether `gh` is usable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    /// The logged-in login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Why `gh` is not usable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BugCheckError>,
}

/// The stored report of a PR, summarized for the PR list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastReportInfo {
    pub run_id: String,
    pub head_sha: String,
    pub finding_count: usize,
    pub started_at: String,
    /// Whether the report is for the PR's current head commit.
    pub up_to_date: bool,
    /// Whether findings of the report were posted.
    pub posted: bool,
}

/// A PR plus the state of its last check (`bug_check_list_prs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrWithStatus {
    #[serde(flatten)]
    pub pr: PullRequestSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report: Option<LastReportInfo>,
}

/// Auto mode settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchConfig {
    /// `owner/name`.
    pub repo: String,
    /// Poll interval, `1..=120` minutes (default 5).
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u32,
    /// Post postable findings without review (default `false`).
    #[serde(default)]
    pub auto_post: bool,
    /// Review draft PRs too (default `false`).
    #[serde(default)]
    pub include_drafts: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_ctx: Option<i64>,
}

fn default_interval_minutes() -> u32 {
    5
}

/// The state of auto mode (`bug_check_watch_*`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    /// The last config used (kept after stopping).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<WatchConfig>,
    pub enabled: bool,
    /// RFC 3339, UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_poll_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<BugCheckError>,
    /// PR numbers waiting for review.
    pub queue: Vec<u64>,
    /// The PR being reviewed now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<u64>,
}

/// An auto mode event, emitted app-wide as `pr-bug-check://event`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WatcherEvent {
    /// The open PRs were listed; `queued` are the PRs that will be reviewed.
    Polled {
        repo: String,
        open_prs: usize,
        queued: Vec<u64>,
    },
    /// The review of `repo#number` started (run id from the engine).
    ReviewStarted {
        repo: String,
        number: u64,
        run_id: String,
    },
    /// An engine event of the PR being reviewed (boxed: a `done` event carries the report).
    Progress {
        repo: String,
        number: u64,
        event: Box<BugCheckEvent>,
    },
    /// The review finished and its report is stored.
    ReviewDone {
        repo: String,
        number: u64,
        finding_count: usize,
        posted: bool,
    },
    /// The review failed or was cancelled (not by stopping auto mode); the
    /// PR is retried on the next poll.
    ReviewFailed {
        repo: String,
        number: u64,
        error: BugCheckError,
    },
    /// Auto mode stopped.
    Stopped,
    /// A polling or posting failure (auto mode keeps running).
    Error {
        error: BugCheckError,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unit_events_are_tagged_camel_case() {
        let event = BugCheckEvent::ChunkDone { index: 2, finding_count: 1 };
        assert_eq!(serde_json::to_value(event).unwrap(), json!({ "type": "chunkDone", "index": 2, "findingCount": 1 }));
        assert_eq!(serde_json::to_value(BugCheckEvent::Cancelled).unwrap(), json!({ "type": "cancelled" }));
        let event = WatcherEvent::Progress { repo: "a/b".into(), number: 7, event: Box::new(BugCheckEvent::Cancelled) };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "type": "progress", "repo": "a/b", "number": 7, "event": { "type": "cancelled" } })
        );
        let event = WatcherEvent::Polled { repo: "a/b".into(), open_prs: 3, queued: vec![1] };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "type": "polled", "repo": "a/b", "openPrs": 3, "queued": [1] })
        );
    }

    #[test]
    fn unit_parses_lenient_severity_and_category() {
        assert_eq!(Severity::parse(" HIGH "), Some(Severity::High));
        assert_eq!(Severity::parse("urgent"), None);
        assert_eq!(Category::parse("unit-mismatch"), Some(Category::UnitMismatch));
        assert_eq!(Category::parse("State Leak"), Some(Category::StateLeak));
        assert_eq!(Category::parse("style"), None);
        assert_eq!(serde_json::to_value(Category::ErrorHandling).unwrap(), json!("error_handling"));
    }

    #[test]
    fn unit_watch_config_defaults() {
        let config: WatchConfig = serde_json::from_value(json!({ "repo": "a/b" })).unwrap();
        assert_eq!(config.interval_minutes, 5);
        assert!(!config.auto_post);
        assert!(!config.include_drafts);
    }

    #[test]
    fn unit_pr_with_status_is_flat() {
        let pr = PullRequestSummary {
            number: 1,
            title: "t".into(),
            author: "me".into(),
            head_ref_oid: "abc".into(),
            head_ref_name: "h".into(),
            base_ref_name: "main".into(),
            is_draft: false,
            updated_at: "2026-11-13T00:00:00Z".into(),
            url: "u".into(),
            additions: 1,
            deletions: 2,
            changed_files: 3,
            state: "OPEN".into(),
        };
        let value = serde_json::to_value(PrWithStatus { pr, last_report: None }).unwrap();
        assert_eq!(value["headRefOid"], "abc");
        assert!(value.get("lastReport").is_none());
    }
}
