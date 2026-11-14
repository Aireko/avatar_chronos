//! [`BugCheckEngine`]: fetches a PR's diff, has the local model review it
//! chunk by chunk, validates the findings, stores the report and posts
//! selected findings as one GitHub review.
//!
//! A run:
//! 1. fetches the PR and its files through `gh`;
//! 2. parses and chunks the diff ([`super::diff`]); the chunk size is capped
//!    so that the prompt, the chunk and the answer budget fit the context
//!    window ([`max_chunk_bytes`]);
//! 3. sends each chunk to [`AiService::generate_with_timeout`] with the
//!    reviewer system prompt, the JSON Schema of the answer, `temperature
//!    0.1` and request id `<runId>-c<index>` (so cancelling the run cancels
//!    the active call). Each call may take `max(OLLAMA_TIMEOUT, 10 min)`;
//! 4. extracts and validates the findings ([`super::findings`]) against the
//!    lines the chunk actually showed, dropping duplicates by id;
//! 5. stores the report ([`ReportStore`]) and returns it. What was posted on
//!    the PR before is carried over (see [`BugCheckReport::posted_keys`]).
//!
//! Events go to `on_event` in this order: `started`, then per chunk
//! `chunkStarted`, `finding`s and `chunkDone` (or `chunkFailed`), then exactly
//! one of `done`, `cancelled` or `error`. Validation errors before the run
//! starts produce only `error`.
//!
//! Failure policy: an AI error that will hit every chunk (Ollama not
//! installed or unreachable, model missing or unsupported, invalid config,
//! busy, not enough memory) ends the run with that error. So does a timeout
//! before any chunk got an answer, or two timeouts in a row. Other per-chunk
//! failures (a single timeout, inference failure) and unparseable or cut-off
//! answers are recorded in `notes` and the run continues. If no chunk got a
//! usable answer at all, the run fails (with the last AI error, or
//! `ai_failed`) and nothing is stored, so auto mode retries it.
//!
//! A run and a post of the same repo+PR exclude each other (`busy`), so a
//! post never overwrites a newer report and a run never drops a fresh
//! `posted` record.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use serde_json::Value;

use crate::ai::{AiErrorKind, AiService, GenerateRequest, GenerateResponse, GenerationOptions};

use super::clock::now_rfc3339;
use super::comment::{MAX_COMMENTS_PER_REVIEW, comment_body, review_summary};
use super::diff::{CHUNK_BYTES_RANGE, Chunk, DEFAULT_CHUNK_BYTES, FileDiff, MAX_CHUNKS, plan_chunks, render_file};
use super::error::{BugCheckError, BugCheckErrorKind};
use super::findings::{
    DEFAULT_MIN_CONFIDENCE, clamp_chars, extract_json, finding_key, raw_findings, salvage_findings, validate,
};
use super::github::{GhRunner, GitHub, ReviewComment, validate_pr_number, validate_repo};
use super::prompt::{
    MAX_BODY_BYTES, SYSTEM_PROMPT, VERIFY_MAX_REASON_CHARS, VERIFY_SYSTEM_PROMPT, build_prompt, build_verify_prompt,
    findings_schema, verify_schema,
};
use super::store::ReportStore;
use super::types::{
    BugCheckEvent, BugCheckOptions, BugCheckReport, Finding, PostResult, PullRequestSummary, Verdict, Verification,
};

/// Default context window for review calls, in tokens.
pub const DEFAULT_NUM_CTX: i64 = 16_384;
/// Accepted context windows (a window must also fit a review, see [`validate_options`]).
pub const NUM_CTX_RANGE: std::ops::RangeInclusive<i64> = 4096..=262_144;
/// Sampling temperature of review calls.
const TEMPERATURE: f64 = 0.1;
/// Max generated tokens per chunk without / with reasoning (reasoning tokens
/// count too), at most half the context window ([`num_predict`]).
const NUM_PREDICT: i64 = 4096;
const NUM_PREDICT_THINKING: i64 = 8192;
/// Conservative bytes per token for code and annotated diffs.
const BYTES_PER_TOKEN: i64 = 3;
/// Tokens for everything in a prompt except the diff chunk: the system
/// prompt, the PR title and description excerpt, and the framing text.
const PROMPT_OVERHEAD_TOKENS: i64 = (SYSTEM_PROMPT.len() + MAX_BODY_BYTES + 1024) as i64 / BYTES_PER_TOKEN + 256;
/// Shortest time budget of one review call. A cold model load plus a long
/// chunk on a small or partly offloaded GPU takes minutes, far longer than
/// the 2-minute `OLLAMA_TIMEOUT` default that suits chat.
pub const MIN_REVIEW_TIMEOUT: Duration = Duration::from_secs(600);
/// Consecutive timed-out chunks that end a run.
const MAX_CONSECUTIVE_TIMEOUTS: usize = 2;
const TIMEOUT_HINT: &str = "The model is too slow for this diff on this machine. Raise OLLAMA_TIMEOUT (milliseconds, \
     e.g. 1800000), use a smaller chunk size or context window, or a smaller model such as qwen3.5:4b";

/// AI error kinds that would fail every chunk, so they end the run at once.
const FATAL_AI_KINDS: [AiErrorKind; 7] = [
    AiErrorKind::OllamaNotInstalled,
    AiErrorKind::OllamaUnreachable,
    AiErrorKind::ModelNotInstalled,
    AiErrorKind::UnsupportedModel,
    AiErrorKind::InvalidConfig,
    AiErrorKind::Busy,
    AiErrorKind::InsufficientResources,
];

/// Max generated tokens of one review call: 4096 (8192 with reasoning), at
/// most half the context window so a small window still has room for the diff.
pub fn num_predict(num_ctx: i64, think: bool) -> i64 {
    let wanted = if think { NUM_PREDICT_THINKING } else { NUM_PREDICT };
    wanted.min(num_ctx / 2)
}

/// The largest chunk of annotated diff, in bytes, that fits `num_ctx` next to
/// the rest of the prompt and the answer budget. Larger prompts would make
/// Ollama silently drop their start: the system prompt and its
/// untrusted-data rules.
pub fn max_chunk_bytes(num_ctx: i64, think: bool) -> i64 {
    (num_ctx - num_predict(num_ctx, think) - PROMPT_OVERHEAD_TOKENS).max(0) * BYTES_PER_TOKEN
}

/// The chunk size a run uses: the requested (or default) size, capped by
/// [`max_chunk_bytes`].
pub fn chunk_bytes_for(options: &BugCheckOptions) -> usize {
    let budget = max_chunk_bytes(options.num_ctx.unwrap_or(DEFAULT_NUM_CTX), options.think.unwrap_or(false));
    options.chunk_bytes.unwrap_or(DEFAULT_CHUNK_BYTES).min(usize::try_from(budget).unwrap_or(0))
}

/// The smallest context window (in 1024-token steps) that fits a review.
fn smallest_num_ctx(think: bool) -> i64 {
    let minimum = *CHUNK_BYTES_RANGE.start() as i64;
    let mut num_ctx = *NUM_CTX_RANGE.start();
    while num_ctx < *NUM_CTX_RANGE.end() && max_chunk_bytes(num_ctx, think) < minimum {
        num_ctx += 1024;
    }
    num_ctx
}

/// Checks run options; see [`BugCheckOptions`] for the ranges.
pub fn validate_options(options: &BugCheckOptions) -> Result<(), BugCheckError> {
    if let Some(num_ctx) = options.num_ctx
        && !NUM_CTX_RANGE.contains(&num_ctx)
    {
        return Err(BugCheckError::invalid_request(
            "numCtx",
            format!("must be between {} and {}", NUM_CTX_RANGE.start(), NUM_CTX_RANGE.end()),
        ));
    }
    if let Some(min) = options.min_confidence
        && !(0.0..=1.0).contains(&min)
    {
        return Err(BugCheckError::invalid_request("minConfidence", "must be between 0 and 1"));
    }
    if let Some(bytes) = options.chunk_bytes
        && !CHUNK_BYTES_RANGE.contains(&bytes)
    {
        return Err(BugCheckError::invalid_request(
            "chunkBytes",
            format!("must be between {} and {}", CHUNK_BYTES_RANGE.start(), CHUNK_BYTES_RANGE.end()),
        ));
    }
    let num_ctx = options.num_ctx.unwrap_or(DEFAULT_NUM_CTX);
    let think = options.think.unwrap_or(false);
    if max_chunk_bytes(num_ctx, think) < *CHUNK_BYTES_RANGE.start() as i64 {
        let with_think = if think { " with Think first on" } else { "" };
        return Err(BugCheckError::invalid_request(
            "numCtx",
            format!("{num_ctx} tokens is too small for a review{with_think}; use at least {}", smallest_num_ctx(think)),
        ));
    }
    Ok(())
}

/// The PR Bug Check engine. Cheap to clone (an `Arc` inside).
#[derive(Clone)]
pub struct BugCheckEngine {
    inner: Arc<Inner>,
}

struct Inner {
    ai: AiService,
    github: GitHub,
    store: ReportStore,
    /// Lock order: `runs` before `posting`.
    runs: Mutex<HashMap<String, ActiveRun>>,
    /// Repo+PR keys with a post in progress.
    posting: Mutex<HashSet<String>>,
    next_run: AtomicU64,
    /// Lower bound of the time budget of one review call.
    min_review_timeout: Duration,
}

struct ActiveRun {
    /// Lowercased `owner/name#number`.
    key: String,
    cancel: CancellationToken,
    /// The AI request id of the chunk being reviewed.
    request_id: Option<String>,
}

/// Removes a run from the registry when the run ends.
struct RunGuard {
    inner: Arc<Inner>,
    run_id: String,
    cancel: CancellationToken,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        lock(&self.inner.runs).remove(&self.run_id);
    }
}

/// Removes a repo+PR from the posting set when the post ends.
struct PostGuard {
    inner: Arc<Inner>,
    key: String,
}

impl Drop for PostGuard {
    fn drop(&mut self) {
        lock(&self.inner.posting).remove(&self.key);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn run_key(repo: &str, number: u64) -> String {
    format!("{}#{number}", repo.to_ascii_lowercase())
}

fn posting_busy(repo: &str, number: u64) -> BugCheckError {
    BugCheckError::new(BugCheckErrorKind::Busy, format!("Findings of {repo}#{number} are being posted"))
        .with_hint("Try again when the post has finished")
}

/// Runs `work` unless `cancel` fires first (-> `cancelled`).
async fn cancellable<T>(
    cancel: &CancellationToken,
    work: impl Future<Output = Result<T, BugCheckError>>,
) -> Result<T, BugCheckError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(BugCheckError::cancelled()),
        result = work => result,
    }
}

/// What one chunk produced.
enum ChunkOutcome {
    /// The model answered; these are its new, validated findings.
    /// `truncated`: the answer hit the output limit and only its complete
    /// findings were kept.
    Answered { findings: Vec<Finding>, model: String, truncated: bool },
    /// The model answered, but not with usable JSON (`truncated`: because it
    /// hit the output limit).
    Unparseable { model: String, truncated: bool },
}

/// What was posted on a PR before a new report: the `posted` record (only
/// for the same head commit) and the line-independent keys of every posted
/// finding.
fn posted_history(previous: Option<&BugCheckReport>, head_sha: &str) -> (Option<PostResult>, Vec<String>) {
    let Some(previous) = previous else { return (None, Vec::new()) };
    let mut keys = previous.posted_keys.clone();
    if let Some(posted) = &previous.posted {
        // Reports from before `postedKeys` existed: derive the keys.
        for finding in previous.findings.iter().filter(|finding| posted.finding_ids.contains(&finding.id)) {
            let key = finding_key(&finding.path, &finding.title);
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    let posted = previous.posted.clone().filter(|_| previous.head_sha == head_sha);
    (posted, keys)
}

impl BugCheckEngine {
    /// An engine using `ai` for inference, `gh` for GitHub and `store` for reports.
    pub fn new(ai: AiService, gh: Arc<dyn GhRunner>, store: ReportStore) -> Self {
        Self::with_min_review_timeout(ai, gh, store, MIN_REVIEW_TIMEOUT)
    }

    /// Like [`BugCheckEngine::new`], with another lower bound for the time
    /// budget of one review call (the budget is `max(OLLAMA_TIMEOUT, min)`).
    pub fn with_min_review_timeout(
        ai: AiService,
        gh: Arc<dyn GhRunner>,
        store: ReportStore,
        min_review_timeout: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                ai,
                github: GitHub::new(gh),
                store,
                runs: Mutex::new(HashMap::new()),
                posting: Mutex::new(HashSet::new()),
                next_run: AtomicU64::new(1),
                min_review_timeout,
            }),
        }
    }

    pub fn ai(&self) -> &AiService {
        &self.inner.ai
    }

    pub fn github(&self) -> &GitHub {
        &self.inner.github
    }

    pub fn store(&self) -> &ReportStore {
        &self.inner.store
    }

    /// Whether a run of `repo#number` is in progress.
    pub fn is_running(&self, repo: &str, number: u64) -> bool {
        let key = run_key(repo, number);
        lock(&self.inner.runs).values().any(|run| run.key == key)
    }

    /// Cancels run `run_id` (and its active model call). Returns whether such
    /// a run was in progress.
    pub fn cancel(&self, run_id: &str) -> bool {
        let request_id = {
            let runs = lock(&self.inner.runs);
            let Some(run) = runs.get(run_id) else { return false };
            run.cancel.cancel();
            run.request_id.clone()
        };
        if let Some(request_id) = request_id {
            self.inner.ai.cancel(&request_id);
        }
        true
    }

    /// The time budget of one review call.
    fn review_timeout(&self) -> Duration {
        let min = self.inner.min_review_timeout;
        self.inner.ai.config().map_or(min, |config| config.timeout.max(min))
    }

    /// Checks `repo#number` for bugs. `cancel` (or [`BugCheckEngine::cancel`]
    /// with the run id from the `started` event) stops it.
    pub async fn run(
        &self,
        repo: &str,
        number: u64,
        options: BugCheckOptions,
        mut on_event: impl FnMut(BugCheckEvent) + Send,
        cancel: CancellationToken,
    ) -> Result<BugCheckReport, BugCheckError> {
        let started = Instant::now();
        let result = match self.begin(repo, number, &options, cancel) {
            Ok(guard) => self.execute(&guard, repo, number, &options, &mut on_event, started).await,
            Err(error) => Err(error),
        };
        match &result {
            Ok(report) => on_event(BugCheckEvent::Done { report: Box::new(report.clone()) }),
            Err(error) if error.is_cancelled() => on_event(BugCheckEvent::Cancelled),
            Err(error) => on_event(BugCheckEvent::Error { error: error.clone() }),
        }
        let outcome = match &result {
            Ok(report) => format!("ok, {} findings", report.findings.len()),
            Err(error) => error.kind.to_string(),
        };
        eprintln!("[pr-bug-check] run {repo}#{number}: {outcome} in {} ms", started.elapsed().as_millis());
        result
    }

    /// Validates the input and registers the run.
    fn begin(
        &self,
        repo: &str,
        number: u64,
        options: &BugCheckOptions,
        cancel: CancellationToken,
    ) -> Result<RunGuard, BugCheckError> {
        validate_repo(repo)?;
        validate_pr_number(number)?;
        validate_options(options)?;
        let key = run_key(repo, number);
        let mut runs = lock(&self.inner.runs);
        if runs.values().any(|run| run.key == key) {
            return Err(BugCheckError::busy(repo, number));
        }
        if lock(&self.inner.posting).contains(&key) {
            return Err(posting_busy(repo, number));
        }
        let run_id = format!("bc-{}", self.inner.next_run.fetch_add(1, Ordering::Relaxed));
        runs.insert(run_id.clone(), ActiveRun { key, cancel: cancel.clone(), request_id: None });
        Ok(RunGuard { inner: Arc::clone(&self.inner), run_id, cancel })
    }

    async fn execute(
        &self,
        guard: &RunGuard,
        repo: &str,
        number: u64,
        options: &BugCheckOptions,
        on_event: &mut (impl FnMut(BugCheckEvent) + Send),
        started: Instant,
    ) -> Result<BugCheckReport, BugCheckError> {
        let started_at = now_rfc3339();
        let cancel = &guard.cancel;
        let (pr, body) = cancellable(cancel, self.inner.github.get_pr_with_body(repo, number)).await?;
        let files = cancellable(cancel, self.inner.github.get_pr_files(repo, number)).await?;
        let diffs: Vec<FileDiff> = files.iter().map(FileDiff::from_pr_file).collect();
        let chunk_bytes = chunk_bytes_for(options);
        let plan = plan_chunks(&diffs, chunk_bytes, MAX_CHUNKS);
        let mut notes = plan.notes.clone();
        if options.chunk_bytes.is_some_and(|requested| requested > chunk_bytes) {
            let num_ctx = options.num_ctx.unwrap_or(DEFAULT_NUM_CTX);
            notes.push(format!("Parts were limited to {chunk_bytes} bytes to fit the {num_ctx}-token context window"));
        }
        on_event(BugCheckEvent::Started {
            run_id: guard.run_id.clone(),
            repo: repo.to_owned(),
            number,
            head_sha: pr.head_ref_oid.clone(),
            total_chunks: plan.chunks.len(),
            files_reviewed: plan.files_reviewed.clone(),
            files_skipped: plan.files_skipped.clone(),
        });

        let mut findings: Vec<Finding> = Vec::new();
        let mut model = None;
        // Chunks the model answered at all, and chunks whose answer was usable.
        let mut answered = 0usize;
        let mut usable = 0usize;
        let mut consecutive_timeouts = 0usize;
        let mut last_ai_error = None;
        // Findings the double-check refuted or could not confirm.
        let mut filtered: Vec<Finding> = Vec::new();
        let verify = options.verify.unwrap_or(true);
        for chunk in &plan.chunks {
            if cancel.is_cancelled() {
                return Err(BugCheckError::cancelled());
            }
            on_event(BugCheckEvent::ChunkStarted { index: chunk.index, files: chunk.files.clone() });
            let part = chunk.index + 1;
            // Only what the chunk showed the model (hunks and lines rendered into it).
            let chunk_files: Vec<&FileDiff> = chunk.shown.iter().collect();
            let outcome = {
                let seen: HashSet<&str> =
                    findings.iter().chain(&filtered).map(|finding| finding.id.as_str()).collect();
                self.review_chunk(guard, &pr, &body, chunk, plan.chunks.len(), &chunk_files, &seen, options).await
            };
            match outcome {
                Ok(ChunkOutcome::Answered { findings: new, model: answered_by, truncated }) => {
                    answered += 1;
                    usable += 1;
                    consecutive_timeouts = 0;
                    model.get_or_insert(answered_by);
                    if truncated {
                        notes.push(format!(
                            "The model's answer for part {part} hit the output limit; some of its findings were lost"
                        ));
                    }
                    let mut kept = 0usize;
                    let total = new.len();
                    for (position, mut finding) in new.into_iter().enumerate() {
                        if verify {
                            on_event(BugCheckEvent::Verifying {
                                index: chunk.index,
                                current: position + 1,
                                total,
                                finding_id: finding.id.clone(),
                            });
                            let verification =
                                self.verify_finding(guard, &pr, chunk, &finding, position + 1, options).await?;
                            let keep = matches!(verification.verdict, Verdict::Confirmed | Verdict::Failed);
                            finding.verification = Some(verification);
                            if !keep {
                                on_event(BugCheckEvent::FindingFiltered { finding: finding.clone() });
                                filtered.push(finding);
                                continue;
                            }
                        }
                        on_event(BugCheckEvent::Finding { finding: finding.clone() });
                        findings.push(finding);
                        kept += 1;
                    }
                    on_event(BugCheckEvent::ChunkDone { index: chunk.index, finding_count: kept });
                }
                Ok(ChunkOutcome::Unparseable { model: answered_by, truncated }) => {
                    answered += 1;
                    consecutive_timeouts = 0;
                    model.get_or_insert(answered_by);
                    let message = if truncated {
                        format!("The model's answer for part {part} hit the output limit; its findings were lost")
                    } else {
                        format!("The model's answer for part {part} was not valid JSON; it was skipped")
                    };
                    notes.push(message.clone());
                    let error = BugCheckError::new(BugCheckErrorKind::AiFailed, message);
                    on_event(BugCheckEvent::ChunkFailed { index: chunk.index, error });
                }
                Err(error) if error.is_cancelled() || is_fatal(&error) => return Err(error),
                Err(error) => {
                    let timed_out = error.ai_kind.as_deref() == Some(AiErrorKind::Timeout.as_str());
                    consecutive_timeouts = if timed_out { consecutive_timeouts + 1 } else { 0 };
                    if timed_out && (answered == 0 || consecutive_timeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
                        // The next parts would most likely time out too.
                        return Err(error.with_hint(TIMEOUT_HINT));
                    }
                    notes.push(format!("Part {part} failed: {}", error.message));
                    on_event(BugCheckEvent::ChunkFailed { index: chunk.index, error: error.clone() });
                    last_ai_error = Some(error);
                }
            }
        }
        if !plan.chunks.is_empty() && usable == 0 {
            // Nothing was reviewed: do not store an empty report that reads as "no bugs".
            return Err(last_ai_error.unwrap_or_else(|| {
                BugCheckError::new(
                    BugCheckErrorKind::AiFailed,
                    "No part of the PR got a usable answer from the model (unparseable or cut off)",
                )
                .with_hint("Try again, use a smaller chunk size, or turn Think first off")
            }));
        }

        findings
            .sort_by(|a, b| a.severity.cmp(&b.severity).then_with(|| a.path.cmp(&b.path)).then(a.line.cmp(&b.line)));
        let previous = self.inner.store.load_report(repo, number);
        let (posted, posted_keys) = posted_history(previous.as_ref(), &pr.head_ref_oid);
        let posted_ids: &[String] = posted.as_ref().map_or(&[][..], |posted| posted.finding_ids.as_slice());
        let posted_earlier: Vec<String> = findings
            .iter()
            .filter(|finding| {
                !posted_ids.contains(&finding.id) && posted_keys.contains(&finding_key(&finding.path, &finding.title))
            })
            .map(|finding| finding.id.clone())
            .collect();
        let mut report = BugCheckReport {
            run_id: guard.run_id.clone(),
            repo: repo.to_owned(),
            number,
            title: pr.title.clone(),
            head_sha: pr.head_ref_oid.clone(),
            model: model.unwrap_or_else(|| self.inner.ai.selected_model()),
            started_at,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            files_reviewed: plan.files_reviewed,
            files_skipped: plan.files_skipped,
            findings,
            notes,
            posted,
            posted_keys,
            posted_earlier,
            filtered,
        };
        if let Err(error) = self.inner.store.save_report(&report) {
            report.notes.push(format!("The report could not be saved: {}", error.message));
        }
        Ok(report)
    }

    /// Sends one chunk to the model and validates its answer.
    #[allow(clippy::too_many_arguments)]
    async fn review_chunk(
        &self,
        guard: &RunGuard,
        pr: &PullRequestSummary,
        body: &str,
        chunk: &Chunk,
        total_chunks: usize,
        chunk_files: &[&FileDiff],
        seen: &HashSet<&str>,
        options: &BugCheckOptions,
    ) -> Result<ChunkOutcome, BugCheckError> {
        let request_id = format!("{}-c{}", guard.run_id, chunk.index);
        let think = options.think.unwrap_or(false);
        let num_ctx = options.num_ctx.unwrap_or(DEFAULT_NUM_CTX);
        let request = GenerateRequest {
            request_id: Some(request_id.clone()),
            system: Some(SYSTEM_PROMPT.to_owned()),
            prompt: build_prompt(&pr.title, body, &chunk.text, chunk.index + 1, total_chunks),
            options: Some(GenerationOptions {
                temperature: Some(TEMPERATURE),
                num_ctx: Some(num_ctx),
                num_predict: Some(num_predict(num_ctx, think)),
                ..GenerationOptions::default()
            }),
            think: Some(think),
            format: Some(findings_schema()),
            model: None,
        };
        let response = self.generate(guard, request_id, request).await?;

        let hit_limit = response.done_reason.as_deref() == Some("length");
        let (raw, truncated) = match extract_json(&response.content).as_ref().and_then(raw_findings) {
            Some(raw) => (raw, false),
            // A cut-off answer: keep its complete findings, if any.
            None if hit_limit => match salvage_findings(&response.content) {
                Some(raw) if !raw.is_empty() => (raw, true),
                _ => return Ok(ChunkOutcome::Unparseable { model: response.model, truncated: true }),
            },
            None => return Ok(ChunkOutcome::Unparseable { model: response.model, truncated: false }),
        };
        let min_confidence = options.min_confidence.unwrap_or(DEFAULT_MIN_CONFIDENCE);
        let mut findings = validate(&raw, chunk_files, min_confidence).findings;
        // Drop findings already reported by earlier chunks, and repeats within this one.
        let mut ids_here = HashSet::new();
        findings.retain(|finding| !seen.contains(finding.id.as_str()) && ids_here.insert(finding.id.clone()));
        Ok(ChunkOutcome::Answered { findings, model: response.model, truncated })
    }

    /// One model call of a run: cancellable through the run (and
    /// [`BugCheckEngine::cancel`]), with the review time budget, retried once
    /// when Ollama's model runner crashes.
    async fn generate(
        &self,
        guard: &RunGuard,
        request_id: String,
        request: GenerateRequest,
    ) -> Result<GenerateResponse, BugCheckError> {
        self.set_request_id(&guard.run_id, Some(request_id.clone()));
        let timeout = self.review_timeout();
        let mut attempt = 1;
        let result = loop {
            let generation = async {
                self.inner.ai.generate_with_timeout(request.clone(), timeout).await.map_err(BugCheckError::from)
            };
            match cancellable(&guard.cancel, generation).await {
                // Ollama's model runner sometimes crashes while loading the model
                // on small GPUs (seen on a 4 GB laptop GPU); a second load usually works.
                Err(error) if attempt < RUNNER_CRASH_ATTEMPTS && is_runner_crash(&error) => {
                    eprintln!("[pr-bug-check] {request_id}: model runner crashed, retrying");
                    attempt += 1;
                    let pause = async {
                        tokio::time::sleep(RUNNER_CRASH_RETRY_DELAY).await;
                        Ok(())
                    };
                    if let Err(error) = cancellable(&guard.cancel, pause).await {
                        break Err(error);
                    }
                }
                other => break other,
            }
        };
        self.set_request_id(&guard.run_id, None);
        result
    }

    /// Double-checks one finding with a skeptical second model call. Errors
    /// that end the run (cancelled, Ollama gone, ...) are returned; any other
    /// failure becomes a `failed` verdict so the finding is kept.
    async fn verify_finding(
        &self,
        guard: &RunGuard,
        pr: &PullRequestSummary,
        chunk: &Chunk,
        finding: &Finding,
        number_in_chunk: usize,
        options: &BugCheckOptions,
    ) -> Result<Verification, BugCheckError> {
        let failed = |reason: String| Verification { verdict: Verdict::Failed, reason };
        let Some(file) = chunk.shown.iter().find(|file| file.path == finding.path) else {
            return Ok(failed("The double-check could not find the file in this part of the diff".into()));
        };
        let think = options.think.unwrap_or(false);
        let num_ctx = options.num_ctx.unwrap_or(DEFAULT_NUM_CTX);
        let request_id = format!("{}-c{}-v{number_in_chunk}", guard.run_id, chunk.index);
        let request = GenerateRequest {
            request_id: Some(request_id.clone()),
            system: Some(VERIFY_SYSTEM_PROMPT.to_owned()),
            prompt: build_verify_prompt(&pr.title, &render_file(file), finding),
            options: Some(GenerationOptions {
                temperature: Some(VERIFY_TEMPERATURE),
                num_ctx: Some(num_ctx),
                num_predict: Some(verify_num_predict(num_ctx, think)),
                ..GenerationOptions::default()
            }),
            think: Some(think),
            format: Some(verify_schema()),
            model: None,
        };
        match self.generate(guard, request_id, request).await {
            Ok(response) => Ok(parse_verification(&response.content).unwrap_or_else(|| {
                failed("The double-check answer was not valid JSON, so the finding was kept unchecked".into())
            })),
            Err(error) if error.is_cancelled() || is_fatal(&error) => Err(error),
            Err(error) => Ok(failed(format!("The double-check failed: {}", error.message))),
        }
    }

    fn set_request_id(&self, run_id: &str, request_id: Option<String>) {
        if let Some(run) = lock(&self.inner.runs).get_mut(run_id) {
            run.request_id = request_id;
        }
    }

    /// Posts the selected findings of the stored report of `repo#number` as
    /// one review (event `COMMENT`) on the reviewed commit.
    ///
    /// Only postable findings that were not posted before (by id, or by path
    /// and title for an earlier check of the PR) are sent, at most 50 (most
    /// severe first). Fails with `stale_report` when the PR's head moved since
    /// the report, with `not_found` when there is no report, and with `busy`
    /// while a run or another post of the PR is in progress.
    pub async fn post(&self, repo: &str, number: u64, finding_ids: &[String]) -> Result<PostResult, BugCheckError> {
        self.post_with_cancel(repo, number, finding_ids, None).await
    }

    /// Like [`BugCheckEngine::post`]; `cancel` (auto mode's stop token) stops
    /// the post before the review is sent (-> `cancelled`). Once sent, the
    /// review is always recorded in the report.
    pub async fn post_with_cancel(
        &self,
        repo: &str,
        number: u64,
        finding_ids: &[String],
        cancel: Option<&CancellationToken>,
    ) -> Result<PostResult, BugCheckError> {
        validate_repo(repo)?;
        validate_pr_number(number)?;
        if finding_ids.is_empty() {
            return Err(BugCheckError::invalid_request("findingIds", "select at least one finding"));
        }
        let key = run_key(repo, number);
        {
            // Lock order: runs, then posting (as in `begin`).
            let runs = lock(&self.inner.runs);
            if runs.values().any(|run| run.key == key) {
                return Err(BugCheckError::busy(repo, number));
            }
            if !lock(&self.inner.posting).insert(key.clone()) {
                return Err(posting_busy(repo, number));
            }
        }
        let _posting = PostGuard { inner: Arc::clone(&self.inner), key };

        let mut report = self.inner.store.load_report(repo, number).ok_or_else(|| {
            BugCheckError::new(BugCheckErrorKind::NotFound, format!("There is no bug check report for {repo}#{number}"))
                .with_hint("Run a bug check first")
        })?;
        let known: HashSet<&str> = report.findings.iter().map(|finding| finding.id.as_str()).collect();
        let unknown = finding_ids.iter().filter(|id| !known.contains(id.as_str())).count();
        if unknown > 0 {
            return Err(BugCheckError::invalid_request(
                "findingIds",
                format!("{unknown} id(s) are not in the latest report of {repo}#{number}"),
            )
            .with_hint("Reload the report and select the findings again"));
        }
        let posted_before: Vec<String> =
            report.posted.as_ref().map(|posted| posted.finding_ids.clone()).unwrap_or_default();
        let already_posted = |finding: &Finding| {
            posted_before.contains(&finding.id)
                || report.posted_earlier.contains(&finding.id)
                || report.posted_keys.contains(&finding_key(&finding.path, &finding.title))
        };
        let wanted: HashSet<&str> = finding_ids.iter().map(String::as_str).collect();
        let mut selected: Vec<&Finding> = report
            .findings
            .iter()
            .filter(|finding| wanted.contains(finding.id.as_str()) && finding.postable && !already_posted(finding))
            .collect();
        if selected.is_empty() {
            return Err(BugCheckError::invalid_request(
                "findingIds",
                "none of the selected findings can be posted (they are not inline-postable or were already posted)",
            ));
        }
        selected.sort_by_key(|finding| finding.severity);
        let left_out = selected.len().saturating_sub(MAX_COMMENTS_PER_REVIEW);
        selected.truncate(MAX_COMMENTS_PER_REVIEW);

        let pr = match cancel {
            Some(cancel) => cancellable(cancel, self.inner.github.get_pr(repo, number)).await?,
            None => self.inner.github.get_pr(repo, number).await?,
        };
        if pr.head_ref_oid != report.head_sha {
            return Err(BugCheckError::stale_report(repo, number));
        }
        let comments: Vec<ReviewComment> = selected
            .iter()
            .map(|finding| ReviewComment {
                path: finding.path.clone(),
                line: finding.line,
                start_line: finding.start_line,
                body: comment_body(finding),
            })
            .collect();
        let summary = review_summary(&report, &selected, left_out);
        // Last chance to stop. The POST itself is never raced: once sent, it is recorded.
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(BugCheckError::cancelled());
        }
        let mut result = self.inner.github.post_review(repo, number, &report.head_sha, &summary, &comments).await?;

        let new_keys: Vec<String> =
            selected.iter().map(|finding| finding_key(&finding.path, &finding.title)).collect();
        let mut all_ids = posted_before;
        all_ids.extend(selected.iter().map(|finding| finding.id.clone()));
        result.finding_ids = all_ids;
        result.posted_at = now_rfc3339();
        report.posted = Some(result.clone());
        for key in new_keys {
            if !report.posted_keys.contains(&key) {
                report.posted_keys.push(key);
            }
        }
        if let Err(error) = self.inner.store.save_report(&report) {
            // The review is on GitHub already; only the local record failed.
            eprintln!("[pr-bug-check] posted {repo}#{number} but could not update the report: {}", error.kind);
        }
        eprintln!("[pr-bug-check] posted {} comment(s) to {repo}#{number}", result.posted_count);
        Ok(result)
    }
}

/// Sampling temperature of double-check calls.
const VERIFY_TEMPERATURE: f64 = 0.0;
/// Max generated tokens of one double-check call without / with reasoning.
const VERIFY_NUM_PREDICT: i64 = 1536;

/// Max generated tokens of one double-check call: its analysis and verdict
/// are short, but reasoning (Think first) needs the full review budget.
fn verify_num_predict(num_ctx: i64, think: bool) -> i64 {
    if think { num_predict(num_ctx, true) } else { VERIFY_NUM_PREDICT.min(num_ctx / 2) }
}

/// Reads a double-check answer: `{analysis, verdict, reason}`, possibly
/// wrapped in a code fence or surrounded by text.
fn parse_verification(content: &str) -> Option<Verification> {
    let text = content.trim();
    let value: Value = serde_json::from_str(text).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        serde_json::from_str(text.get(start..=end)?).ok()
    })?;
    let verdict = match value.get("verdict")?.as_str()?.trim().to_ascii_lowercase().as_str() {
        "confirmed" => Verdict::Confirmed,
        "refuted" => Verdict::Refuted,
        "uncertain" => Verdict::Uncertain,
        _ => return None,
    };
    let reason = value.get("reason").and_then(Value::as_str).unwrap_or_default().trim();
    let reason = if reason.is_empty() { "No reason given".to_owned() } else { clamp_chars(reason, VERIFY_MAX_REASON_CHARS) };
    Some(Verification { verdict, reason })
}

/// Tries per chunk when Ollama's model runner process crashes (first try included).
const RUNNER_CRASH_ATTEMPTS: u32 = 2;
/// Pause before retrying after a runner crash, so Ollama can clean up the process.
const RUNNER_CRASH_RETRY_DELAY: Duration = Duration::from_secs(3);

/// Whether Ollama reported that its model runner process died (for example a
/// CUDA initialisation crash while loading), which is often transient.
fn is_runner_crash(error: &BugCheckError) -> bool {
    let message = error.message.to_ascii_lowercase();
    error.kind == BugCheckErrorKind::AiFailed
        && ["process has terminated", "process no longer running", "runner process"]
            .iter()
            .any(|needle| message.contains(needle))
}

/// Whether an error ends the whole run instead of one chunk.
fn is_fatal(error: &BugCheckError) -> bool {
    error.kind != BugCheckErrorKind::AiFailed
        || error.ai_kind.as_deref().is_some_and(|kind| FATAL_AI_KINDS.iter().any(|fatal| fatal.as_str() == kind))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::diff::{FileDiff, plan_chunks};
    use crate::review::types::PrFile;

    fn options(num_ctx: Option<i64>, think: bool, chunk_bytes: Option<usize>) -> BugCheckOptions {
        BugCheckOptions { num_ctx, think: Some(think), chunk_bytes, min_confidence: None, verify: None }
    }

    #[test]
    fn unit_default_options_keep_the_default_chunk_size() {
        assert_eq!(chunk_bytes_for(&BugCheckOptions::default()), DEFAULT_CHUNK_BYTES);
        assert_eq!(num_predict(DEFAULT_NUM_CTX, false), 4096);
        assert_eq!(num_predict(DEFAULT_NUM_CTX, true), 8192);
        assert!(validate_options(&BugCheckOptions::default()).is_ok());
    }

    #[test]
    fn unit_chunks_fit_the_context_window() {
        for (num_ctx, think) in [(8192, false), (8192, true), (16_384, true), (16_384, false), (32_768, true)] {
            let options = options(Some(num_ctx), think, Some(*CHUNK_BYTES_RANGE.end()));
            assert!(validate_options(&options).is_ok(), "{num_ctx} {think}");
            let bytes = chunk_bytes_for(&options) as i64;
            assert!(bytes >= *CHUNK_BYTES_RANGE.start() as i64);
            let prompt_tokens = bytes / BYTES_PER_TOKEN + PROMPT_OVERHEAD_TOKENS;
            assert!(prompt_tokens + num_predict(num_ctx, think) <= num_ctx, "{num_ctx} {think}: {bytes} bytes");
        }
        // 16K with Think first: the 24 KiB default is lowered.
        assert!(chunk_bytes_for(&options(None, true, None)) < DEFAULT_CHUNK_BYTES);
    }

    #[test]
    fn unit_too_small_context_windows_are_rejected() {
        for think in [false, true] {
            let error = validate_options(&options(Some(4096), think, None)).unwrap_err();
            assert_eq!(error.kind, BugCheckErrorKind::InvalidRequest);
            assert!(error.message.contains("numCtx") && error.message.contains("use at least 8192"), "{error}");
        }
        assert!(validate_options(&options(Some(8192), true, None)).is_ok(), "8K with Think first is clamped");
    }

    #[test]
    fn unit_8k_windows_yield_chunks_within_the_budget() {
        // 50 hunks of 40 added lines (about 100 KB annotated).
        let patch: String = (0..50)
            .map(|hunk| {
                let start = hunk * 100 + 1;
                let lines: String = (0..40).map(|i| format!("+let value_{i} = compute({i});\n")).collect();
                format!("@@ -{start},0 +{start},40 @@\n{lines}")
            })
            .collect();
        let file = FileDiff::from_pr_file(&PrFile {
            path: "a.rs".into(),
            status: "modified".into(),
            patch: Some(patch),
            additions: 2000,
            deletions: 0,
            previous_path: None,
        });
        let options = options(Some(8192), false, None);
        let budget = max_chunk_bytes(8192, false) as usize;
        assert_eq!(chunk_bytes_for(&options), budget);
        let plan = plan_chunks(&[file], chunk_bytes_for(&options), MAX_CHUNKS);
        assert!(plan.chunks.len() > 1);
        for chunk in &plan.chunks {
            assert!(chunk.text.len() <= budget, "{} > {budget}", chunk.text.len());
        }
    }
}
