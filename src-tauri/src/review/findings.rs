//! Turning the model's answer into validated [`Finding`]s.
//!
//! The model is asked for JSON matching a schema, but its output is still
//! treated as untrusted: [`extract_json`] tolerates code fences and leading
//! text, and [`validate`] checks every finding against the diff:
//!
//! * `path` must be a file of the chunk;
//! * `line` must be a RIGHT-side commentable line of that file as the chunk
//!   showed it (the engine passes only the hunks and lines it rendered into
//!   the chunk), otherwise it
//!   is snapped to the nearest commentable line at most 3 lines away, else the
//!   finding is kept but marked `postable: false`;
//! * `startLine` is kept only when it is before `line` in the same hunk; a
//!   multi-line range that cannot be kept sets `rangeRejected`, so the fix
//!   (written for that range) is never posted as a one-click suggestion;
//! * strings are clamped (title 120, explanation 4000 characters); a fix
//!   longer than 4000 characters is dropped rather than cut (a cut fix would
//!   be wrong code);
//! * unknown severities become `medium`, unknown categories `other`;
//! * findings below the minimum confidence are dropped.
//!
//! Ids are a stable hash of path, line and normalized title, so the same bug
//! found twice (in two chunks or two runs) has the same id; the engine uses
//! them to deduplicate.

use serde_json::{Map, Value};

use super::diff::FileDiff;
use super::types::{Category, Finding, Severity};

/// Longest title, in characters.
pub const MAX_TITLE_CHARS: usize = 120;
/// Longest explanation, in characters.
pub const MAX_EXPLANATION_CHARS: usize = 4000;
/// Longest suggested fix, in characters (longer fixes are dropped).
pub const MAX_FIX_CHARS: usize = 4000;
/// How far a cited line may be moved to reach a commentable line.
pub const SNAP_DISTANCE: u32 = 3;
/// Default minimum confidence.
pub const DEFAULT_MIN_CONFIDENCE: f64 = 0.5;
/// Confidence assumed when the model gives none.
const DEFAULT_CONFIDENCE: f64 = 0.5;

/// Extracts the JSON answer from model output: the whole text when it is an
/// answer, else the first answer-shaped JSON value found in it (in text
/// order), e.g. inside a ```json fence or after a sentence.
///
/// Only answer shapes are accepted ([`is_answer_shape`]), so an inner
/// finding object of a cut-off answer, or prose such as `see [1]`, is never
/// taken for the answer.
pub fn extract_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && is_answer_shape(&value)
    {
        return Some(value);
    }
    for (index, _) in trimmed.char_indices().filter(|(_, c)| matches!(c, '{' | '[')) {
        let mut values = serde_json::Deserializer::from_str(&trimmed[index..]).into_iter::<Value>();
        if let Some(Ok(value)) = values.next()
            && is_answer_shape(&value)
        {
            return Some(value);
        }
    }
    None
}

/// Whether `value` looks like an answer: an object whose `findings` is an
/// array or `null`, or an array of objects (possibly empty).
pub fn is_answer_shape(value: &Value) -> bool {
    match value {
        Value::Object(object) => matches!(object.get("findings"), Some(Value::Array(_) | Value::Null)),
        Value::Array(items) => items.iter().all(Value::is_object),
        _ => false,
    }
}

/// The complete finding objects at the start of a `"findings"` array that
/// was cut off (an answer that hit the output limit). `None` when the text
/// has no such array.
pub fn salvage_findings(text: &str) -> Option<Vec<Value>> {
    const KEY: &str = "\"findings\"";
    let at = text.find(KEY)?;
    let mut rest = text[at + KEY.len()..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('[')?;
    let mut items = Vec::new();
    loop {
        rest = rest.trim_start();
        if rest.is_empty() || rest.starts_with(']') {
            break;
        }
        let mut values = serde_json::Deserializer::from_str(rest).into_iter::<Value>();
        let Some(Ok(value)) = values.next() else { break };
        let used = values.byte_offset();
        items.push(value);
        match rest[used..].trim_start().strip_prefix(',') {
            Some(next) => rest = next,
            None => break,
        }
    }
    Some(items.into_iter().filter(Value::is_object).collect())
}

/// The raw finding objects of an answer: `{"findings": [...]}` or a bare array.
/// `None` when the answer has neither shape.
pub fn raw_findings(answer: &Value) -> Option<Vec<Value>> {
    match answer {
        Value::Array(items) => Some(items.clone()),
        Value::Object(object) => match object.get("findings") {
            Some(Value::Array(items)) => Some(items.clone()),
            Some(Value::Null) => Some(Vec::new()),
            _ => None,
        },
        _ => None,
    }
}

/// The result of validating one chunk's raw findings.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Validation {
    pub findings: Vec<Finding>,
    /// Findings dropped: unknown path, no usable line or title, or low confidence.
    pub dropped: usize,
}

/// Validates the raw findings of a chunk against the chunk's `files`.
pub fn validate(raw: &[Value], files: &[&FileDiff], min_confidence: f64) -> Validation {
    let mut validation = Validation::default();
    for item in raw {
        match validate_one(item, files, min_confidence) {
            Some(finding) => validation.findings.push(finding),
            None => validation.dropped += 1,
        }
    }
    validation
}

fn validate_one(item: &Value, files: &[&FileDiff], min_confidence: f64) -> Option<Finding> {
    let object = item.as_object()?;
    let file = find_file(text_field(object, &["path", "file", "filename"])?.trim(), files)?;
    let cited = int_field(object, &["line", "lineNumber", "line_number", "endLine", "end_line"])?;
    let start = int_field(object, &["startLine", "start_line"]);
    let title = clamp_chars(&collapse_whitespace(&text_field(object, &["title", "summary"])?), MAX_TITLE_CHARS);
    if title.is_empty() {
        return None;
    }
    let confidence = confidence_field(object);
    if confidence < min_confidence {
        return None;
    }
    let explanation = text_field(object, &["explanation", "description", "details", "reason"])
        .map(|text| clamp_chars(text.trim(), MAX_EXPLANATION_CHARS))
        .unwrap_or_default();
    let suggested_fix = text_field(object, &["suggestedFix", "suggested_fix", "fix"])
        .map(|fix| strip_fence(&fix))
        .filter(|fix| !fix.trim().is_empty() && fix.chars().count() <= MAX_FIX_CHARS);
    let severity = text_field(object, &["severity"]).and_then(|text| Severity::parse(&text)).unwrap_or_default();
    let category =
        text_field(object, &["category", "type"]).and_then(|text| Category::parse(&text)).unwrap_or_default();

    let placement = place(file, cited, start);
    Some(Finding {
        id: finding_id(&file.path, placement.line, &title),
        path: file.path.clone(),
        line: placement.line,
        start_line: placement.start_line,
        severity,
        category,
        title,
        explanation,
        suggested_fix,
        confidence,
        postable: placement.postable,
        snapped_from: placement.snapped_from,
        range_rejected: placement.range_rejected,
        verification: None,
    })
}

/// Where a finding ends up in the diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub line: u32,
    pub start_line: Option<u32>,
    pub postable: bool,
    pub snapped_from: Option<u32>,
    /// The model gave a multi-line range (`start != line`) that could not be
    /// kept, so its fix was written for other lines than the ones a GitHub
    /// suggestion would replace.
    pub range_rejected: bool,
}

/// Places a cited `line` (and optional `start`) on the RIGHT side of `file`
/// (pass only the part of the file the model was shown).
pub fn place(file: &FileDiff, line: u32, start: Option<u32>) -> Placement {
    let multi_line = start.is_some_and(|start| start != line);
    if let Some(hunk) = file.hunk_of(line) {
        let start_line = start.filter(|start| *start < line && file.hunk_of(*start) == Some(hunk));
        let range_rejected = multi_line && start_line.is_none();
        return Placement { line, start_line, postable: true, snapped_from: None, range_rejected };
    }
    let nearest = file
        .hunks
        .iter()
        .filter_map(|hunk| hunk.commentable())
        .map(|range| {
            let target = line.clamp(*range.start(), *range.end());
            (target.abs_diff(line), target)
        })
        .min();
    match nearest {
        Some((distance, target)) if distance <= SNAP_DISTANCE => Placement {
            line: target,
            start_line: None,
            postable: true,
            snapped_from: Some(line),
            range_rejected: multi_line,
        },
        _ => Placement { line, start_line: None, postable: false, snapped_from: None, range_rejected: multi_line },
    }
}

/// A stable id for (path, line, normalized title): `f` + 16 hex digits of
/// FNV-1a 64 (stable across Rust versions, unlike `DefaultHasher`).
pub fn finding_id(path: &str, line: u32, title: &str) -> String {
    format!("f{:016x}", fnv1a(&format!("{path}\u{0}{line}\u{0}{}", normalize_title(title))))
}

/// A line-independent fingerprint of a finding: (path, normalized title).
/// Used to remember what was posted on a PR across commits, where the same
/// bug may move to another line.
pub fn finding_key(path: &str, title: &str) -> String {
    format!("k{:016x}", fnv1a(&format!("{path}\u{0}{}", normalize_title(title))))
}

/// FNV-1a 64 (stable across Rust versions, unlike `DefaultHasher`).
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Lowercase alphanumeric words joined by single spaces.
pub fn normalize_title(title: &str) -> String {
    title
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// At most `max` characters, ending in `...` when cut.
pub fn clamp_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(3)).collect();
    format!("{}...", kept.trim_end())
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Removes a code fence around a whole fix and blank lines around it,
/// keeping indentation.
fn strip_fence(fix: &str) -> String {
    let normalized = fix.replace("\r\n", "\n");
    let mut lines: Vec<&str> = normalized.split('\n').collect();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    if lines.len() >= 2 && lines[0].trim_start().starts_with("```") && lines[lines.len() - 1].trim() == "```" {
        lines.remove(0);
        lines.pop();
    }
    lines.join("\n")
}

/// The chunk file named `path`, tolerating `./`, `a/` and `b/` prefixes.
fn find_file<'a>(path: &str, files: &[&'a FileDiff]) -> Option<&'a FileDiff> {
    let path = path.replace('\\', "/");
    let candidates = [
        Some(path.as_str()),
        path.strip_prefix("./"),
        path.strip_prefix("b/"),
        path.strip_prefix("a/"),
        path.strip_prefix('/'),
    ];
    candidates.into_iter().flatten().find_map(|candidate| files.iter().copied().find(|file| file.path == candidate))
}

fn text_field(object: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| object.get(*name).and_then(Value::as_str).map(str::to_owned))
}

/// A positive line number, as a JSON number or a numeric string.
fn int_field(object: &Map<String, Value>, names: &[&str]) -> Option<u32> {
    names.iter().find_map(|name| match object.get(*name)? {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_f64().filter(|value| value.fract() == 0.0 && *value >= 0.0).map(|value| value as u64))
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0),
        Value::String(text) => text.trim().parse::<u32>().ok().filter(|value| *value > 0),
        _ => None,
    })
}

/// `confidence` in `0..=1` (a percentage above 1 is scaled down).
fn confidence_field(object: &Map<String, Value>) -> f64 {
    let value = match object.get("confidence") {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().trim_end_matches('%').trim().parse::<f64>().ok(),
        _ => None,
    };
    match value {
        Some(value) if value.is_finite() && value > 1.0 && value <= 100.0 => value / 100.0,
        Some(value) if value.is_finite() => value.clamp(0.0, 1.0),
        _ => DEFAULT_CONFIDENCE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::types::PrFile;
    use serde_json::json;

    /// Hunks: new lines 10..=14 and 30..=31.
    fn diff() -> FileDiff {
        FileDiff::from_pr_file(&PrFile {
            path: "src/timer.rs".into(),
            status: "modified".into(),
            patch: Some("@@ -10,4 +10,5 @@\n a\n-b\n+c\n+d\n e\n f\n@@ -40,1 +30,2 @@\n g\n+h".into()),
            additions: 3,
            deletions: 1,
            previous_path: None,
        })
    }

    fn raw(line: Value, extra: Value) -> Value {
        let mut value = json!({
            "path": "src/timer.rs", "line": line, "severity": "high", "category": "unit_mismatch",
            "title": "Timeout is in ms but treated as seconds", "explanation": "`sleep(t)` takes seconds", "confidence": 0.9,
        });
        if let (Value::Object(value), Value::Object(extra)) = (&mut value, extra) {
            value.extend(extra);
        }
        value
    }

    fn one(item: Value) -> Option<Finding> {
        let file = diff();
        validate(&[item], &[&file], DEFAULT_MIN_CONFIDENCE).findings.into_iter().next()
    }

    #[test]
    fn unit_extracts_json_from_noisy_output() {
        let plain = r#"{"findings":[]}"#;
        assert_eq!(extract_json(plain), Some(json!({ "findings": [] })));
        let fenced = "Here you go:\n```json\n{\"findings\": [{\"path\": \"a\"}]}\n```\nDone.";
        assert_eq!(extract_json(fenced), Some(json!({ "findings": [{ "path": "a" }] })));
        let braces = "I looked at {the code}. {\"findings\": []} trailing {";
        assert_eq!(extract_json(braces), Some(json!({ "findings": [] })));
        assert_eq!(extract_json("[{\"path\":\"x\"}]"), Some(json!([{ "path": "x" }])));
        assert_eq!(extract_json("no json here"), None);
        assert_eq!(extract_json("{\"findings\": [ {\"path\": "), None, "truncated output");
    }

    #[test]
    fn unit_extract_json_only_accepts_answer_shapes() {
        let bare = r#"Here are the bugs: [{"path":"a.rs","line":1}]"#;
        assert_eq!(extract_json(bare), Some(json!([{ "path": "a.rs", "line": 1 }])), "array after leading text");
        assert_eq!(extract_json(r#"Note [1]: {"findings":[]}"#), Some(json!({ "findings": [] })), "prose brackets");
        assert_eq!(
            extract_json(r#"{"findings":[{"path":"a"},{"path":"#),
            None,
            "a cut-off answer, not its inner finding object"
        );
        assert_eq!(extract_json(r#"{"path":"a.rs","line":1}"#), None, "a lone finding object is not an answer");
        assert_eq!(extract_json("see [1] and [2]"), None);
        assert_eq!(extract_json("[]"), Some(json!([])));
    }

    #[test]
    fn unit_salvages_complete_findings_of_a_cut_off_answer() {
        let cut = r#"{"findings": [{"path": "a.rs", "line": 3}, {"path": "b.rs", "line": 4} , {"path": "c.rs", "li"#;
        assert_eq!(
            salvage_findings(cut),
            Some(vec![json!({ "path": "a.rs", "line": 3 }), json!({ "path": "b.rs", "line": 4 })])
        );
        assert_eq!(salvage_findings(r#"{"findings": [{"path": "#), Some(vec![]));
        assert_eq!(salvage_findings(r#"{"findings": []}"#), Some(vec![]));
        assert_eq!(salvage_findings("no answer"), None);
        assert_eq!(salvage_findings(r#"{"bugs": [{"path": "a"}]}"#), None);
    }

    #[test]
    fn unit_raw_findings_shapes() {
        assert_eq!(raw_findings(&json!({ "findings": [1] })), Some(vec![json!(1)]));
        assert_eq!(raw_findings(&json!([1, 2])).unwrap().len(), 2);
        assert_eq!(raw_findings(&json!({ "findings": null })), Some(vec![]));
        assert_eq!(raw_findings(&json!({ "bugs": [] })), None);
    }

    #[test]
    fn unit_valid_finding_is_kept_as_is() {
        let finding = one(raw(json!(11), json!({ "suggestedFix": "    let secs = ms / 1000;" }))).unwrap();
        assert_eq!(finding.line, 11);
        assert!(finding.postable);
        assert_eq!(finding.snapped_from, None);
        assert_eq!(finding.severity, Severity::High);
        assert_eq!(finding.category, Category::UnitMismatch);
        assert_eq!(finding.suggested_fix.as_deref(), Some("    let secs = ms / 1000;"));
        assert_eq!(finding.id, finding_id("src/timer.rs", 11, "Timeout is in ms but treated as seconds"));
    }

    #[test]
    fn unit_snaps_to_the_nearest_commentable_line() {
        let finding = one(raw(json!(16), json!({}))).unwrap();
        assert_eq!((finding.line, finding.postable, finding.snapped_from), (14, true, Some(16)));
        let finding = one(raw(json!("28"), json!({}))).unwrap();
        assert_eq!((finding.line, finding.snapped_from), (30, Some(28)));
    }

    #[test]
    fn unit_far_lines_are_kept_but_not_postable() {
        let finding = one(raw(json!(20), json!({ "startLine": 18 }))).unwrap();
        assert_eq!((finding.line, finding.postable, finding.start_line), (20, false, None));
    }

    #[test]
    fn unit_start_line_must_precede_line_in_the_same_hunk() {
        assert_eq!(one(raw(json!(13), json!({ "startLine": 11 }))).unwrap().start_line, Some(11));
        assert_eq!(one(raw(json!(13), json!({ "startLine": 13 }))).unwrap().start_line, None);
        assert_eq!(one(raw(json!(11), json!({ "startLine": 13 }))).unwrap().start_line, None);
        assert_eq!(one(raw(json!(31), json!({ "startLine": 12 }))).unwrap().start_line, None, "other hunk");
        assert_eq!(one(raw(json!(16), json!({ "startLine": 12 }))).unwrap().start_line, None, "snapped");
    }

    #[test]
    fn unit_a_rejected_range_is_flagged() {
        let rejected = |line: u32, start: Option<u32>| {
            let extra = start.map_or(json!({}), |start| json!({ "startLine": start }));
            one(raw(json!(line), extra)).unwrap().range_rejected
        };
        assert!(rejected(31, Some(12)), "start in another hunk");
        assert!(rejected(11, Some(13)), "start after line");
        assert!(rejected(16, Some(12)), "snapped");
        assert!(rejected(20, Some(18)), "not postable");
        assert!(!rejected(13, None), "no range");
        assert!(!rejected(13, Some(11)), "a valid range");
        assert!(!rejected(13, Some(13)), "a one-line range is just the line");
        let finding = one(raw(json!(31), json!({ "startLine": 12 }))).unwrap();
        assert!(finding.postable && finding.snapped_from.is_none() && finding.start_line.is_none());
    }

    #[test]
    fn unit_finding_keys_ignore_the_line() {
        assert_eq!(finding_key("a.rs", "Off-by-one in loop!"), finding_key("a.rs", "off by one in LOOP"));
        assert_ne!(finding_key("a.rs", "x"), finding_key("b.rs", "x"));
        assert!(finding_key("a.rs", "x").starts_with('k'));
    }

    #[test]
    fn unit_drops_unusable_and_low_confidence_findings() {
        let file = diff();
        let items = [
            raw(json!(11), json!({ "path": "other.rs" })),
            raw(json!(0), json!({})),
            raw(json!("eleven"), json!({})),
            raw(json!(11), json!({ "title": "   " })),
            raw(json!(11), json!({ "confidence": 0.2 })),
            json!("not an object"),
            raw(json!(11), json!({ "path": "./src/timer.rs", "confidence": "85%" })),
        ];
        let validation = validate(&items, &[&file], DEFAULT_MIN_CONFIDENCE);
        assert_eq!(validation.dropped, 6);
        assert_eq!(validation.findings.len(), 1);
        assert!((validation.findings[0].confidence - 0.85).abs() < 1e-9);
        let lenient = validate(&items[4..5], &[&file], 0.1);
        assert_eq!(lenient.findings.len(), 1);
    }

    #[test]
    fn unit_clamps_strings_and_defaults_unknown_labels() {
        let long_title = format!("Bad\n{}", "x".repeat(500));
        let item = raw(
            json!(11),
            json!({
                "title": long_title, "explanation": "e".repeat(5000), "severity": "urgent", "category": "style",
                "suggestedFix": "f".repeat(MAX_FIX_CHARS + 1),
            }),
        );
        let finding = one(item).unwrap();
        assert_eq!(finding.title.chars().count(), MAX_TITLE_CHARS);
        assert!(finding.title.starts_with("Bad x"));
        assert!(finding.title.ends_with("..."));
        assert_eq!(finding.explanation.chars().count(), MAX_EXPLANATION_CHARS);
        assert_eq!(finding.severity, Severity::Medium);
        assert_eq!(finding.category, Category::Other);
        assert_eq!(finding.suggested_fix, None, "an over-long fix is dropped, not cut");
    }

    #[test]
    fn unit_strips_fences_around_fixes() {
        let finding = one(raw(json!(11), json!({ "suggestedFix": "```rust\n    a();\n    b();\n```\n" }))).unwrap();
        assert_eq!(finding.suggested_fix.as_deref(), Some("    a();\n    b();"));
        let finding = one(raw(json!(11), json!({ "suggestedFix": "  \n" }))).unwrap();
        assert_eq!(finding.suggested_fix, None);
    }

    #[test]
    fn unit_ids_are_stable_and_ignore_title_noise() {
        assert_eq!(finding_id("a.rs", 3, "Off-by-one in loop!"), finding_id("a.rs", 3, "off by one  in LOOP"));
        assert_ne!(finding_id("a.rs", 3, "x"), finding_id("a.rs", 4, "x"));
        assert_eq!(
            finding_id("a.rs", 3, "x"),
            "f".to_owned()
                + &format!("{:016x}", {
                    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
                    for byte in "a.rs\u{0}3\u{0}x".bytes() {
                        hash ^= u64::from(byte);
                        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
                    }
                    hash
                })
        );
    }
}
