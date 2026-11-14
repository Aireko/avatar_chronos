//! Auto mode: reviews new and updated PRs while the app runs.
//!
//! While enabled, a background task lists the repository's open PRs every
//! `intervalMinutes` (the first poll is immediate). A PR is queued when its
//! head commit differs from the head of its stored report, i.e. it is new or
//! got new commits since its last check ([`select_for_review`]); drafts are
//! skipped unless `includeDrafts`. Queued PRs are reviewed one at a time
//! through the [`BugCheckEngine`]. With `autoPost`, the postable findings of
//! each review are posted right away (only when there are any, and only
//! findings not posted on the PR before, also not for an earlier commit).
//!
//! The first poll queues every open PR without an up-to-date report, so
//! enabling auto mode first works through the existing backlog (up to 50
//! PRs); after that only new PRs and PRs with new commits are queued.
//!
//! A failed review is retried on the next poll (its stored head is not
//! updated). That includes a review cancelled through its run id: only
//! stopping auto mode ends the loop. Stopping (or restarting with new
//! settings) also stops a pending auto-post. A failed poll is reported as an
//! `error` event and retried with a doubling delay (at most 30 minutes, never
//! shorter than the interval); the watcher never stops by itself.
//!
//! Events go through an emitter closure (in the app: the Tauri event
//! `pr-bug-check://event`), so tests need no `AppHandle`. The config and the
//! enabled flag are persisted; [`Watcher::resume`] restarts auto mode when the
//! app starts.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::clock::now_rfc3339;
use super::comment::MAX_COMMENTS_PER_REVIEW;
use super::engine::{BugCheckEngine, validate_options};
use super::error::BugCheckError;
use super::findings::finding_key;
use super::github::validate_repo;
use super::store::WatchSettings;
use super::types::{
    BugCheckEvent, BugCheckOptions, BugCheckReport, PullRequestSummary, WatchConfig, WatchState, WatcherEvent,
};

/// Accepted poll intervals, in minutes.
pub const INTERVAL_MINUTES_RANGE: std::ops::RangeInclusive<u32> = 1..=120;
/// Longest delay between polls after repeated failures.
pub const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);

/// Receives watcher events.
pub type Emitter = Arc<dyn Fn(WatcherEvent) + Send + Sync>;

/// The PRs that need a review, in ascending PR number order: PRs whose head
/// differs from the head of their last report (`last_head`), or that have no
/// report. Drafts only with `include_drafts`.
pub fn select_for_review(
    prs: &[PullRequestSummary],
    include_drafts: bool,
    last_head: impl Fn(u64) -> Option<String>,
) -> Vec<u64> {
    let mut numbers: Vec<u64> = prs
        .iter()
        .filter(|pr| include_drafts || !pr.is_draft)
        .filter(|pr| !pr.head_ref_oid.is_empty())
        .filter(|pr| last_head(pr.number).as_deref() != Some(pr.head_ref_oid.as_str()))
        .map(|pr| pr.number)
        .collect();
    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

/// The delay before the next poll after `failures` consecutive failed polls:
/// the interval, doubled per failure, capped at 30 minutes (but never
/// shorter than the interval itself).
pub fn next_delay(interval: Duration, failures: u32) -> Duration {
    if failures == 0 {
        return interval;
    }
    let factor = 1u32.checked_shl(failures.min(16)).unwrap_or(u32::MAX);
    interval.saturating_mul(factor).min(MAX_BACKOFF).max(interval)
}

/// Checks an auto mode config.
pub fn validate_config(config: &WatchConfig) -> Result<(), BugCheckError> {
    validate_repo(&config.repo)?;
    if !INTERVAL_MINUTES_RANGE.contains(&config.interval_minutes) {
        return Err(BugCheckError::invalid_request(
            "intervalMinutes",
            format!("must be between {} and {}", INTERVAL_MINUTES_RANGE.start(), INTERVAL_MINUTES_RANGE.end()),
        ));
    }
    validate_options(&run_options(config))
}

fn run_options(config: &WatchConfig) -> BugCheckOptions {
    BugCheckOptions { min_confidence: config.min_confidence, num_ctx: config.num_ctx, ..BugCheckOptions::default() }
}

/// Auto mode. Cheap to clone (an `Arc` inside).
#[derive(Clone)]
pub struct Watcher {
    inner: Arc<Inner>,
}

struct Inner {
    engine: BugCheckEngine,
    emit: Emitter,
    state: Mutex<Shared>,
}

#[derive(Default)]
struct Shared {
    config: Option<WatchConfig>,
    enabled: bool,
    last_poll_at: Option<String>,
    last_error: Option<BugCheckError>,
    queue: Vec<u64>,
    current: Option<u64>,
    /// Stops the running loop.
    stop: Option<CancellationToken>,
    /// Incremented per start, so an old loop never clears a newer one's state.
    generation: u64,
}

impl Watcher {
    /// A stopped watcher (call [`Watcher::resume`] to restore persisted settings).
    pub fn new(engine: BugCheckEngine, emit: Emitter) -> Self {
        let config = engine.store().load_settings().config;
        Self { inner: Arc::new(Inner { engine, emit, state: Mutex::new(Shared { config, ..Shared::default() }) }) }
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.inner.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn emit(&self, event: WatcherEvent) {
        (self.inner.emit)(event);
    }

    /// The current state.
    pub fn state(&self) -> WatchState {
        let shared = self.lock();
        WatchState {
            config: shared.config.clone(),
            enabled: shared.enabled,
            last_poll_at: shared.last_poll_at.clone(),
            last_error: shared.last_error.clone(),
            queue: shared.queue.clone(),
            current: shared.current,
        }
    }

    /// Starts (or restarts with a new config) auto mode and persists it.
    pub fn start(&self, config: WatchConfig) -> Result<WatchState, BugCheckError> {
        validate_config(&config)?;
        let token = CancellationToken::new();
        let generation = {
            let mut shared = self.lock();
            if let Some(old) = shared.stop.take() {
                old.cancel();
            }
            shared.generation += 1;
            shared.config = Some(config.clone());
            shared.enabled = true;
            shared.last_error = None;
            shared.queue.clear();
            shared.current = None;
            shared.stop = Some(token.clone());
            shared.generation
        };
        self.persist(Some(config.clone()), true);
        let watcher = self.clone();
        tauri::async_runtime::spawn(async move { watcher.watch_loop(config, token, generation).await });
        Ok(self.state())
    }

    /// Stops auto mode (cancelling a review in progress) and persists that.
    pub fn stop(&self) -> WatchState {
        let (was_enabled, config) = {
            let mut shared = self.lock();
            if let Some(token) = shared.stop.take() {
                token.cancel();
            }
            let was_enabled = shared.enabled;
            shared.enabled = false;
            shared.queue.clear();
            shared.current = None;
            shared.generation += 1;
            (was_enabled, shared.config.clone())
        };
        self.persist(config, false);
        if was_enabled {
            self.emit(WatcherEvent::Stopped);
        }
        self.state()
    }

    /// Restarts auto mode if it was enabled when the app last ran.
    pub fn resume(&self) {
        let settings = self.inner.engine.store().load_settings();
        if let (true, Some(config)) = (settings.enabled, settings.config)
            && let Err(error) = self.start(config)
        {
            eprintln!("[pr-bug-check] could not resume auto mode: {}", error.kind);
        }
    }

    fn persist(&self, config: Option<WatchConfig>, enabled: bool) {
        if let Err(error) = self.inner.engine.store().save_settings(&WatchSettings { config, enabled }) {
            eprintln!("[pr-bug-check] could not save auto mode settings: {}", error.kind);
        }
    }

    /// Updates the shared state if `generation` is still the running one.
    fn update(&self, generation: u64, change: impl FnOnce(&mut Shared)) {
        let mut shared = self.lock();
        if shared.generation == generation {
            change(&mut shared);
        }
    }

    async fn watch_loop(self, config: WatchConfig, token: CancellationToken, generation: u64) {
        let interval = Duration::from_secs(u64::from(config.interval_minutes) * 60);
        let mut failures = 0u32;
        while !token.is_cancelled() {
            match self.run_cycle(&config, &token, generation).await {
                Ok(()) => failures = 0,
                // Only this loop's own token ends it; a cancelled review is not a poll failure.
                Err(_) if token.is_cancelled() => break,
                Err(error) if error.is_cancelled() => {}
                Err(_) => failures = failures.saturating_add(1),
            }
            tokio::select! {
                () = token.cancelled() => break,
                () = tokio::time::sleep(next_delay(interval, failures)) => {}
            }
        }
        self.update(generation, |shared| {
            shared.queue.clear();
            shared.current = None;
        });
    }

    /// One poll and the reviews it queues. Returns the poll error, if the
    /// poll failed (review failures are reported as events, not returned).
    pub(crate) async fn run_cycle(
        &self,
        config: &WatchConfig,
        token: &CancellationToken,
        generation: u64,
    ) -> Result<(), BugCheckError> {
        let engine = &self.inner.engine;
        let polled = tokio::select! {
            () = token.cancelled() => return Err(BugCheckError::cancelled()),
            result = engine.github().list_open_prs(&config.repo) => result,
        };
        let polled_at = now_rfc3339();
        let prs = match polled {
            Ok(prs) => prs,
            Err(error) => {
                self.update(generation, |shared| {
                    shared.last_poll_at = Some(polled_at);
                    shared.last_error = Some(error.clone());
                });
                self.emit(WatcherEvent::Error { error: error.clone() });
                return Err(error);
            }
        };
        let store = engine.store();
        let queued = select_for_review(&prs, config.include_drafts, |number| {
            store.load_report(&config.repo, number).map(|report| report.head_sha)
        });
        self.update(generation, |shared| {
            shared.last_poll_at = Some(polled_at);
            shared.last_error = None;
            shared.queue = queued.clone();
        });
        self.emit(WatcherEvent::Polled { repo: config.repo.clone(), open_prs: prs.len(), queued: queued.clone() });

        for number in queued {
            if token.is_cancelled() {
                return Err(BugCheckError::cancelled());
            }
            self.update(generation, |shared| {
                shared.queue.retain(|queued| *queued != number);
                shared.current = Some(number);
            });
            let outcome = self.review(config, number, token).await;
            self.update(generation, |shared| shared.current = None);
            // Only stopping auto mode ends the cycle. A review cancelled from
            // elsewhere (its run id) was reported as failed; its stored head is
            // unchanged, so it is retried on the next poll.
            if let Err(error) = outcome
                && token.is_cancelled()
            {
                return Err(error);
            }
        }
        Ok(())
    }

    /// Reviews one PR (and posts, with `autoPost`), reporting through events.
    async fn review(&self, config: &WatchConfig, number: u64, token: &CancellationToken) -> Result<(), BugCheckError> {
        let engine = &self.inner.engine;
        if engine.is_running(&config.repo, number) {
            // A manual check of this PR is running; the next poll sees its report.
            return Ok(());
        }
        let emit = Arc::clone(&self.inner.emit);
        let repo = config.repo.clone();
        let on_event = move |event: BugCheckEvent| {
            if let BugCheckEvent::Started { run_id, .. } = &event {
                emit(WatcherEvent::ReviewStarted { repo: repo.clone(), number, run_id: run_id.clone() });
            }
            emit(WatcherEvent::Progress { repo: repo.clone(), number, event: Box::new(event) });
        };
        let result = engine.run(&config.repo, number, run_options(config), on_event, token.child_token()).await;
        match result {
            Ok(report) => {
                // Stopping auto mode (or restarting it with new settings) cancels
                // `token`: nothing is posted after that.
                let posted =
                    config.auto_post && !token.is_cancelled() && self.auto_post(config, &report, token).await;
                if !token.is_cancelled() {
                    self.emit(WatcherEvent::ReviewDone {
                        repo: config.repo.clone(),
                        number,
                        finding_count: report.findings.len(),
                        posted,
                    });
                }
                Ok(())
            }
            Err(error) => {
                if !token.is_cancelled() {
                    self.emit(WatcherEvent::ReviewFailed { repo: config.repo.clone(), number, error: error.clone() });
                }
                Err(error)
            }
        }
    }

    /// Posts the postable findings of `report` that were not posted on this
    /// PR before (also not for an earlier commit). Returns whether a review
    /// was posted. Stops (without an error event) when `token` is cancelled.
    async fn auto_post(&self, config: &WatchConfig, report: &BugCheckReport, token: &CancellationToken) -> bool {
        let posted_ids: &[String] = report.posted.as_ref().map_or(&[][..], |posted| posted.finding_ids.as_slice());
        let ids: Vec<String> = report
            .findings
            .iter()
            .filter(|finding| {
                finding.postable
                    && !posted_ids.contains(&finding.id)
                    && !report.posted_earlier.contains(&finding.id)
                    && !report.posted_keys.contains(&finding_key(&finding.path, &finding.title))
            })
            .take(MAX_COMMENTS_PER_REVIEW)
            .map(|finding| finding.id.clone())
            .collect();
        if ids.is_empty() {
            return false;
        }
        match self.inner.engine.post_with_cancel(&config.repo, report.number, &ids, Some(token)).await {
            Ok(_) => true,
            Err(error) if error.is_cancelled() => false,
            Err(error) => {
                {
                    let mut shared = self.lock();
                    shared.last_error = Some(error.clone());
                }
                self.emit(WatcherEvent::Error { error });
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u64, sha: &str, draft: bool) -> PullRequestSummary {
        PullRequestSummary {
            number,
            title: format!("PR {number}"),
            author: "octo".into(),
            head_ref_oid: sha.into(),
            head_ref_name: "h".into(),
            base_ref_name: "main".into(),
            is_draft: draft,
            updated_at: "2026-11-13T00:00:00Z".into(),
            url: String::new(),
            additions: 1,
            deletions: 0,
            changed_files: 1,
            state: "OPEN".into(),
        }
    }

    #[test]
    fn unit_selects_new_and_updated_prs() {
        let prs = [pr(9, "new-sha", false), pr(3, "same", false), pr(5, "moved", false), pr(7, "draft", true)];
        let last_head = |number: u64| match number {
            3 => Some("same".to_owned()),
            5 => Some("old".to_owned()),
            _ => None,
        };
        assert_eq!(select_for_review(&prs, false, last_head), [5, 9], "new and updated, drafts excluded, sorted");
        assert_eq!(select_for_review(&prs, true, last_head), [5, 7, 9], "drafts included");
        assert!(select_for_review(&[pr(3, "same", false)], false, last_head).is_empty(), "unchanged");
        assert!(select_for_review(&[pr(4, "", false)], false, |_| None).is_empty(), "no head sha");
    }

    #[test]
    fn unit_backoff_doubles_up_to_thirty_minutes() {
        let five = Duration::from_secs(300);
        assert_eq!(next_delay(five, 0), five);
        assert_eq!(next_delay(five, 1), Duration::from_secs(600));
        assert_eq!(next_delay(five, 2), Duration::from_secs(1200));
        assert_eq!(next_delay(five, 3), MAX_BACKOFF);
        assert_eq!(next_delay(five, 400), MAX_BACKOFF);
        let hour = Duration::from_secs(3600);
        assert_eq!(next_delay(hour, 2), hour, "never shorter than the interval");
    }

    #[test]
    fn unit_validates_configs() {
        let config = |repo: &str, interval: u32| WatchConfig {
            repo: repo.into(),
            interval_minutes: interval,
            auto_post: false,
            include_drafts: false,
            min_confidence: None,
            num_ctx: None,
        };
        assert!(validate_config(&config("o/r", 5)).is_ok());
        assert!(validate_config(&config("o/r", 0)).is_err());
        assert!(validate_config(&config("o/r", 121)).is_err());
        assert!(validate_config(&config("-o/r", 5)).is_err());
        let bad_confidence = WatchConfig { min_confidence: Some(1.5), ..config("o/r", 5) };
        assert!(validate_config(&bad_confidence).is_err());
    }
}
