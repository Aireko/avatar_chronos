//! Persistence of reports and auto mode settings, as JSON files:
//!
//! ```text
//! <app data>/pr-bug-check/
//!   settings.json                 auto mode config + whether it is enabled
//!   <owner>__<repo>/pr-<n>.json   the latest report of each PR
//! ```
//!
//! Owner and repo are lowercased (GitHub names are case-insensitive) and were
//! validated (`[A-Za-z0-9._-]`, never starting with `.`), so they are safe as
//! directory names. Writes are atomic (temporary file + rename). Loading is
//! tolerant: a missing or corrupt file reads as "nothing stored" (a corrupt
//! file is reported with one line on stderr, without its contents).
//!
//! Reports contain findings (titles, explanations, fixes) about the PR's code
//! and stay on this machine.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::error::BugCheckError;
use super::github::validate_repo;
use super::types::{BugCheckReport, WatchConfig};

/// Name of the folder under the app data directory.
pub const STORE_DIR_NAME: &str = "pr-bug-check";
const SETTINGS_FILE: &str = "settings.json";

/// Auto mode settings as stored on disk.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<WatchConfig>,
    #[serde(default)]
    pub enabled: bool,
}

/// Reads and writes reports and settings under one root directory.
#[derive(Debug, Clone)]
pub struct ReportStore {
    root: PathBuf,
    /// Makes temporary file names unique within this process.
    counter: Arc<AtomicU64>,
}

impl ReportStore {
    /// A store rooted at `root` (usually `<app data>/pr-bug-check`). The
    /// directory is created on the first write.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into(), counter: Arc::new(AtomicU64::new(0)) }
    }

    /// The root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where the report of `repo#number` lives.
    pub fn report_path(&self, repo: &str, number: u64) -> Result<PathBuf, BugCheckError> {
        validate_repo(repo)?;
        let (owner, name) = repo.split_once('/').expect("validated repo has a slash");
        let dir = format!("{}__{}", owner.to_ascii_lowercase(), name.to_ascii_lowercase());
        Ok(self.root.join(dir).join(format!("pr-{number}.json")))
    }

    /// The stored report of `repo#number`, if any (a corrupt file reads as none).
    pub fn load_report(&self, repo: &str, number: u64) -> Option<BugCheckReport> {
        load_json(&self.report_path(repo, number).ok()?)
    }

    /// Stores `report` as the latest report of its PR.
    pub fn save_report(&self, report: &BugCheckReport) -> Result<(), BugCheckError> {
        let path = self.report_path(&report.repo, report.number)?;
        self.write_json(&path, report)
    }

    /// The stored auto mode settings (defaults when missing or corrupt).
    pub fn load_settings(&self) -> WatchSettings {
        load_json(&self.root.join(SETTINGS_FILE)).unwrap_or_default()
    }

    /// Stores the auto mode settings.
    pub fn save_settings(&self, settings: &WatchSettings) -> Result<(), BugCheckError> {
        self.write_json(&self.root.join(SETTINGS_FILE), settings)
    }

    /// Writes `value` to `path` atomically: a temporary file in the same
    /// directory, then a rename over the old file.
    fn write_json(&self, path: &Path, value: &impl Serialize) -> Result<(), BugCheckError> {
        let failed = |action: &str, err: std::io::Error| {
            BugCheckError::internal(format!("Could not {action} {}: {err}", path.display()))
        };
        let dir = path.parent().ok_or_else(|| BugCheckError::internal("store path has no parent"))?;
        std::fs::create_dir_all(dir).map_err(|err| failed("create the folder for", err))?;
        let bytes = serde_json::to_vec_pretty(value).map_err(|err| BugCheckError::internal(err.to_string()))?;
        let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("data");
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        let temp = dir.join(format!(".{file_name}.{}-{unique}.tmp", std::process::id()));
        if let Err(err) = std::fs::write(&temp, &bytes) {
            let _ = std::fs::remove_file(&temp);
            return Err(failed("write", err));
        }
        std::fs::rename(&temp, path).map_err(|err| {
            let _ = std::fs::remove_file(&temp);
            failed("replace", err)
        })
    }
}

/// Reads JSON from `path`; `None` when missing or unreadable.
fn load_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(err) => {
            // The category only: serde's message can quote the file's contents.
            let problem = match err.classify() {
                serde_json::error::Category::Io => "io error",
                serde_json::error::Category::Syntax => "invalid JSON",
                serde_json::error::Category::Data => "unexpected shape",
                serde_json::error::Category::Eof => "truncated JSON",
            };
            eprintln!("[pr-bug-check] ignoring unreadable file {} ({problem})", path.display());
            None
        }
    }
}

/// A fresh, empty directory for one test, under the system temp directory.
#[cfg(test)]
pub fn test_dir(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "avatar-pr-bug-check-test-{}-{name}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::types::{Category, Finding, PostResult, Severity, SkippedFile};

    fn sample_report(repo: &str, number: u64) -> BugCheckReport {
        BugCheckReport {
            run_id: "bc-1".into(),
            repo: repo.into(),
            number,
            title: "Fix".into(),
            head_sha: "abc".into(),
            model: "qwen3.5:9b".into(),
            started_at: "2026-11-13T00:00:00Z".into(),
            duration_ms: 1200,
            files_reviewed: vec!["a.rs".into()],
            files_skipped: vec![SkippedFile { path: "Cargo.lock".into(), reason: "lockfile".into() }],
            findings: vec![Finding {
                id: "f1".into(),
                path: "a.rs".into(),
                line: 3,
                start_line: None,
                severity: Severity::Low,
                category: Category::Other,
                title: "t".into(),
                explanation: "e".into(),
                suggested_fix: None,
                confidence: 0.7,
                postable: true,
                snapped_from: None,
                range_rejected: false,
                verification: None,
            }],
            notes: vec![],
            posted: Some(PostResult {
                review_url: Some("u".into()),
                posted_count: 1,
                finding_ids: vec!["f1".into()],
                posted_at: "x".into(),
            }),
            posted_keys: vec!["k1".into()],
            posted_earlier: vec![],
            filtered: vec![],
        }
    }

    #[test]
    fn unit_report_round_trip() {
        let store = ReportStore::new(test_dir("round-trip"));
        assert_eq!(store.load_report("Owner/Repo", 7), None);
        let report = sample_report("Owner/Repo", 7);
        store.save_report(&report).unwrap();
        assert_eq!(store.load_report("owner/repo", 7), Some(report.clone()), "names are case-insensitive");
        let path = store.report_path("Owner/Repo", 7).unwrap();
        assert!(path.ends_with(Path::new("owner__repo").join("pr-7.json")));

        let mut newer = report;
        newer.head_sha = "def".into();
        store.save_report(&newer).unwrap();
        assert_eq!(store.load_report("Owner/Repo", 7).unwrap().head_sha, "def");
        let leftovers = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary files are left behind");
        let _ = std::fs::remove_dir_all(store.root());
    }

    #[test]
    fn unit_corrupt_and_missing_files_read_as_empty() {
        let store = ReportStore::new(test_dir("corrupt"));
        let path = store.report_path("o/r", 1).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(store.load_report("o/r", 1), None);
        std::fs::write(store.root().join(SETTINGS_FILE), b"[1,2]").unwrap();
        assert_eq!(store.load_settings(), WatchSettings::default());
        assert!(store.report_path("../x", 1).is_err());
        let _ = std::fs::remove_dir_all(store.root());
    }

    #[test]
    fn unit_settings_round_trip() {
        let store = ReportStore::new(test_dir("settings"));
        let settings = WatchSettings {
            config: Some(WatchConfig {
                repo: "o/r".into(),
                interval_minutes: 10,
                auto_post: false,
                include_drafts: true,
                min_confidence: Some(0.6),
                num_ctx: None,
            }),
            enabled: true,
        };
        store.save_settings(&settings).unwrap();
        assert_eq!(store.load_settings(), settings);
        let _ = std::fs::remove_dir_all(store.root());
    }
}
