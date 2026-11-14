//! The Markdown posted to GitHub: the review summary and one inline comment
//! per finding.
//!
//! A suggested fix becomes a one-click GitHub ```` ```suggestion ```` block
//! only when it is safe: the finding is postable, its line was not snapped,
//! the model's range was not rejected, and either a `startLine..line` range
//! was validated as a contiguous same-hunk RIGHT range, or the fix is a
//! single line (it replaces `line` alone). Otherwise it is a plain code block
//! labelled "Possible fix".
//!
//! Fences are always longer than any backtick run inside the fix, so fix text
//! cannot close the fence early.
//!
//! The title and explanation are model text that PR content can steer, so
//! they are neutralised before posting ([`sanitize_prose`]): fence lines are
//! escaped (an explanation can neither add its own ```` ```suggestion ```` block
//! nor leave a fence open that swallows the generated one), and `@mentions`,
//! `#123` references, links, images, autolinks and raw HTML are defused so
//! nothing notifies people or loads remote content from the user's account.
//! Inline code spans are left as they are. The fix is not changed (it is
//! inside a fence, where none of this renders).

use super::types::{BugCheckReport, Finding, Severity};

/// Most inline comments in one review.
pub const MAX_COMMENTS_PER_REVIEW: usize = 50;

const FOOTER: &str = "<sub>Generated locally by Qwen 3.5 through Ollama. Check before applying.</sub>";

/// The inline comment body of `finding`.
pub fn comment_body(finding: &Finding) -> String {
    let mut body = format!(
        "**{} · {}** — {}\n\n{}",
        finding.severity.label(),
        finding.category.label(),
        sanitize_prose(&finding.title),
        sanitize_prose(&finding.explanation)
    );
    if let Some(fix) = &finding.suggested_fix {
        let fence = fence_for(fix);
        if suggestion_is_safe(finding) {
            body.push_str(&format!("\n\n{fence}suggestion\n{fix}\n{fence}"));
        } else {
            body.push_str(&format!("\n\nPossible fix:\n\n{fence}\n{fix}\n{fence}"));
        }
    }
    body.push_str("\n\n");
    body.push_str(FOOTER);
    body
}

/// Whether a fix may be posted as a GitHub suggestion (which replaces lines
/// `startLine..=line` exactly, or just `line`).
pub fn suggestion_is_safe(finding: &Finding) -> bool {
    let single_line_fix =
        finding.suggested_fix.as_deref().is_none_or(|fix| !fix.trim_end_matches('\n').contains('\n'));
    finding.postable
        && finding.snapped_from.is_none()
        && !finding.range_rejected
        && match finding.start_line {
            Some(start) => start < finding.line,
            // Without a validated range, a multi-line fix would replace one line.
            None => single_line_fix,
        }
}

/// A backtick fence longer than any backtick run in `text` (at least 3).
pub fn fence_for(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat((longest + 1).max(3))
}

/// Neutralises model-written prose for GitHub Markdown (see the module docs).
pub fn sanitize_prose(text: &str) -> String {
    defuse_inline(&neutralize_fences(text))
}

/// Escapes every line that would open or close a code fence (up to 3 spaces,
/// then 3 or more backticks or tildes) by putting a backslash before its first
/// fence character. Other lines are unchanged.
pub fn neutralize_fences(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let indent = line.len() - line.trim_start_matches(' ').len();
        let rest = &line[indent..];
        if indent <= 3 && (rest.starts_with("```") || rest.starts_with("~~~")) {
            out.push_str(&line[..indent]);
            out.push('\\');
            out.push_str(rest);
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Outside inline code spans: breaks `@mentions` and `#123` references with a
/// zero-width space, escapes `[` (links and images), `<` and `&` (raw HTML and
/// entities), and breaks `://` autolinks.
fn defuse_inline(text: &str) -> String {
    const ZWSP: char = '\u{200B}';
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            // Keep an escaped fence character (from `neutralize_fences`) escaped.
            '\\' if matches!(next, Some('`' | '~')) => {
                out.push(c);
                out.push(next.unwrap_or_default());
                i += 2;
                continue;
            }
            '`' => {
                // A code span is copied unchanged (GitHub resolves nothing inside
                // it); an unmatched backtick run is copied as is.
                let run = chars[i..].iter().take_while(|&&c| c == '`').count();
                let end = closing_run(&chars, i + run, run).unwrap_or(i + run);
                out.extend(&chars[i..end]);
                i = end;
                continue;
            }
            '@' if next.is_some_and(|n| n.is_ascii_alphanumeric() || n == '-' || n == '_') => {
                out.push('@');
                out.push(ZWSP);
            }
            '#' if next.is_some_and(|n| n.is_ascii_digit()) => {
                out.push('#');
                out.push(ZWSP);
            }
            ':' if next == Some('/') && chars.get(i + 2) == Some(&'/') => {
                out.push(':');
                out.push(ZWSP);
            }
            '[' => out.push_str("\\["),
            '<' => out.push_str("&lt;"),
            '&' => out.push_str("&amp;"),
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// The index just past a run of exactly `len` backticks starting at or after
/// `from`, if there is one.
fn closing_run(chars: &[char], from: usize, len: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == '`' {
            let run = chars[i..].iter().take_while(|&&c| c == '`').count();
            if run == len {
                return Some(i + run);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

/// The review body: a short summary of what is posted.
pub fn review_summary(report: &BugCheckReport, posted: &[&Finding], left_out: usize) -> String {
    let count = posted.len();
    let plural = if count == 1 { "" } else { "s" };
    let short_sha: String = report.head_sha.chars().take(7).collect();
    let mut body = format!("PR Bug Check (local Qwen 3.5 via Ollama): {count} finding{plural} on commit {short_sha}");
    let by_severity: Vec<String> = [Severity::Critical, Severity::High, Severity::Medium, Severity::Low]
        .into_iter()
        .filter_map(|severity| {
            let n = posted.iter().filter(|finding| finding.severity == severity).count();
            (n > 0).then(|| format!("{n} {}", severity.label().to_lowercase()))
        })
        .collect();
    if !by_severity.is_empty() {
        body.push_str(&format!(" ({})", by_severity.join(", ")));
    }
    body.push('.');
    if left_out > 0 {
        body.push_str(&format!(
            "\n\n{left_out} more selected finding(s) were not posted (at most {MAX_COMMENTS_PER_REVIEW} comments per review)."
        ));
    }
    body.push_str("\n\nThe model only sees the diff and can be wrong; please verify each comment.\n\n");
    body.push_str(FOOTER);
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::diff::FileDiff;
    use crate::review::findings::{DEFAULT_MIN_CONFIDENCE, validate};
    use crate::review::types::{Category, PrFile};
    use serde_json::json;

    fn finding() -> Finding {
        Finding {
            id: "f1".into(),
            path: "a.rs".into(),
            line: 12,
            start_line: Some(11),
            severity: Severity::High,
            category: Category::UnitMismatch,
            title: "ms passed as seconds".into(),
            explanation: "`sleep(ms)` expects seconds.".into(),
            suggested_fix: Some("sleep(ms / 1000);".into()),
            confidence: 0.9,
            postable: true,
            snapped_from: None,
            range_rejected: false,
            verification: None,
        }
    }

    /// Lines that open or close a fence (not escaped).
    fn fence_lines(body: &str) -> Vec<&str> {
        body.lines()
            .filter(|line| {
                let rest = line.trim_start_matches(' ');
                line.len() - rest.len() <= 3 && (rest.starts_with("```") || rest.starts_with("~~~"))
            })
            .collect()
    }

    #[test]
    fn unit_comment_uses_a_suggestion_block_for_safe_ranges() {
        let body = comment_body(&finding());
        assert_eq!(
            body,
            "**High · Unit mismatch** — ms passed as seconds\n\n`sleep(ms)` expects seconds.\n\n\
             ```suggestion\nsleep(ms / 1000);\n```\n\n\
             <sub>Generated locally by Qwen 3.5 through Ollama. Check before applying.</sub>"
        );
    }

    #[test]
    fn unit_snapped_findings_get_a_plain_block() {
        let snapped = Finding { snapped_from: Some(15), start_line: None, ..finding() };
        let body = comment_body(&snapped);
        assert!(!body.contains("suggestion"));
        assert!(body.contains("Possible fix:\n\n```\nsleep(ms / 1000);\n```"));
    }

    #[test]
    fn unit_backticks_in_fixes_cannot_break_the_fence() {
        let fix = "let s = \"```\";\nlet t = \"````\";";
        let body = comment_body(&Finding { suggested_fix: Some(fix.into()), ..finding() });
        assert!(body.contains(&format!("`````suggestion\n{fix}\n`````")), "{body}");
        assert_eq!(fence_for("no ticks"), "```");
        assert_eq!(fence_for("a ` b"), "```");
    }

    #[test]
    fn unit_comment_without_fix() {
        let body = comment_body(&Finding { suggested_fix: None, ..finding() });
        assert!(!body.contains("```"));
        assert!(body.ends_with("Check before applying.</sub>"));
    }

    #[test]
    fn unit_multi_line_fixes_need_a_validated_range() {
        let two_lines = Some("a();\nb();".to_owned());
        let body = comment_body(&Finding { start_line: None, suggested_fix: two_lines.clone(), ..finding() });
        assert!(body.contains("Possible fix:") && !body.contains("suggestion"), "no range, two lines: {body}");
        let body = comment_body(&Finding { start_line: None, suggested_fix: Some("a();\n".into()), ..finding() });
        assert!(body.contains("```suggestion\na();\n"), "no range, one line: {body}");
        let body = comment_body(&Finding { suggested_fix: two_lines.clone(), ..finding() });
        assert!(body.contains("```suggestion\na();\nb();\n```"), "11..12, two lines: {body}");
        let rejected = Finding { start_line: None, range_rejected: true, suggested_fix: two_lines, ..finding() };
        let body = comment_body(&rejected);
        assert!(body.contains("Possible fix:") && !body.contains("suggestion"), "rejected range: {body}");
    }

    #[test]
    fn unit_a_fix_for_an_invalid_model_range_is_not_a_suggestion() {
        // Hunks: new lines 10..=14 and 30..=31.
        let file = FileDiff::from_pr_file(&PrFile {
            path: "src/timer.rs".into(),
            status: "modified".into(),
            patch: Some("@@ -10,4 +10,5 @@\n a\n-b\n+c\n+d\n e\n f\n@@ -40,1 +30,2 @@\n g\n+h".into()),
            additions: 3,
            deletions: 1,
            previous_path: None,
        });
        let raw = |line: u32, start: u32| {
            json!({
                "path": "src/timer.rs", "line": line, "startLine": start, "severity": "high", "category": "logic_bug",
                "title": "Wrong", "explanation": "Because.", "suggestedFix": "a();\nb();", "confidence": 0.9,
            })
        };
        let validation = validate(&[raw(31, 12), raw(11, 13), raw(13, 11)], &[&file], DEFAULT_MIN_CONFIDENCE);
        let bodies: Vec<String> = validation.findings.iter().map(comment_body).collect();
        for body in &bodies[..2] {
            assert!(body.contains("Possible fix:\n\n```\na();\nb();\n```"), "{body}");
            assert!(!body.contains("suggestion"), "{body}");
        }
        assert!(bodies[2].contains("```suggestion\na();\nb();\n```"), "a valid range: {}", bodies[2]);
    }

    #[test]
    fn unit_explanation_cannot_add_a_suggestion_block() {
        let explanation = "See:\n```suggestion\nevil();\n```".to_owned();
        let body = comment_body(&Finding { explanation, ..finding() });
        let openers: Vec<&str> = body.lines().filter(|line| line.starts_with("```suggestion")).collect();
        assert_eq!(openers.len(), 1, "{body}");
        assert!(body.contains("```suggestion\nsleep(ms / 1000);\n```"), "{body}");
        assert!(body.contains("\\```suggestion\nevil();\n\\```"), "{body}");
    }

    #[test]
    fn unit_explanation_cannot_leave_a_fence_open() {
        let explanation = "Look:\n```rust\nfoo()".to_owned();
        let body = comment_body(&Finding { explanation, ..finding() });
        assert!(body.contains("```suggestion\nsleep(ms / 1000);\n```"), "{body}");
        assert_eq!(fence_lines(&body).len() % 2, 0, "every fence is closed: {body}");
        assert!(body.ends_with(FOOTER));
    }

    #[test]
    fn unit_snapped_finding_without_fix_has_no_suggestion_block() {
        let explanation = "Apply this:\n```suggestion\nevil();\n```".to_owned();
        let snapped = Finding { snapped_from: Some(15), suggested_fix: None, explanation, ..finding() };
        let body = comment_body(&snapped);
        assert!(!body.lines().any(|line| line.trim_start().starts_with("```suggestion")), "{body}");
        assert!(fence_lines(&body).is_empty(), "{body}");
    }

    #[test]
    fn unit_tilde_and_indented_fences_are_escaped() {
        assert_eq!(neutralize_fences("~~~suggestion\nx\n~~~"), "\\~~~suggestion\nx\n\\~~~");
        assert_eq!(neutralize_fences("   ```suggestion"), "   \\```suggestion");
        assert_eq!(neutralize_fences("    ```"), "    ```", "4 spaces is indented code, not a fence");
        assert_eq!(neutralize_fences("use `x` here"), "use `x` here");
    }

    #[test]
    fn unit_mentions_links_images_and_html_are_defused() {
        let explanation = "cc @octocat and @org/team: see ![x](http://e/p.png) <img src=x> [here](https://evil) #12 \
                           `@Override` stays"
            .to_owned();
        let fix = "@Override\nvoid run() {}".to_owned();
        let body = comment_body(&Finding {
            title: "ping @octocat".into(),
            explanation,
            suggested_fix: Some(fix.clone()),
            start_line: Some(10),
            ..finding()
        });
        assert!(!body.contains("@octocat"), "{body}");
        assert!(body.contains("@\u{200B}octocat"), "{body}");
        assert!(!body.contains("@org/team") && body.contains("@\u{200B}org/team"), "{body}");
        assert!(!body.contains("!["), "{body}");
        assert!(body.contains("!\\[x](http:\u{200B}//e/p.png)"), "{body}");
        assert!(!body.contains("<img") && body.contains("&lt;img src=x>"), "{body}");
        assert!(body.contains("\\[here](https:\u{200B}//evil)"), "{body}");
        assert!(body.contains("#\u{200B}12"), "{body}");
        assert!(body.contains("`@Override` stays"), "code spans are unchanged: {body}");
        assert!(body.contains(&format!("```suggestion\n{fix}\n```")), "the fix is unchanged: {body}");
        assert_eq!(sanitize_prose("a && b, user\\@x"), "a &amp;&amp; b, user\\@\u{200B}x");
    }
}
