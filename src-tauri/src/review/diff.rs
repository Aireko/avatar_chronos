//! Unified-diff parsing, line numbering and chunking.
//!
//! GitHub's `patch` field of a PR file is a unified diff without file
//! headers: one or more hunks starting with `@@ -a,b +c,d @@`. This module
//! numbers every line on the new (RIGHT) side, which is where inline review
//! comments go, and renders an annotated view for the model:
//!
//! ```text
//! FILE: src/timer.rs (modified)
//! @@ -40,3 +40,4 @@ fn wait()
//!    40   let start = now();
//!    41 + let secs = elapsed / 1000;
//!       - let secs = elapsed;
//!    42   sleep(secs);
//! ```
//!
//! Removed lines get no number: they cannot carry a RIGHT-side comment.
//! Within a hunk, the new-side lines (added and context) are contiguous, so
//! a hunk's commentable lines are one range.
//!
//! [`plan_chunks`] packs files into model-sized chunks, splitting a big file
//! by hunks and truncating a single oversized hunk, and skips files that are
//! not worth reviewing (lockfiles, minified, vendored, generated, binary).

use std::collections::BTreeSet;
use std::ops::RangeInclusive;

use super::types::{PrFile, SkippedFile};

/// Default size of one chunk of annotated diff, in bytes.
pub const DEFAULT_CHUNK_BYTES: usize = 24 * 1024;
/// Accepted range for a caller-supplied chunk size.
pub const CHUNK_BYTES_RANGE: RangeInclusive<usize> = 4096..=196_608;
/// Most chunks (model calls) per run; larger PRs are only partly reviewed.
pub const MAX_CHUNKS: usize = 40;

/// Width of the line-number column in the annotated view.
const NUMBER_WIDTH: usize = 5;

/// What a diff line does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Added,
    Context,
    Removed,
}

/// One line of a hunk.
#[derive(Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    /// New-side line number (`None` for removed lines).
    pub new_line: Option<u32>,
    pub text: String,
}

impl std::fmt::Debug for DiffLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiffLine")
            .field("kind", &self.kind)
            .field("new_line", &self.new_line)
            .field("text_bytes", &self.text.len())
            .finish()
    }
}

/// One `@@` hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// The `@@ ... @@` line, including any trailing function context.
    pub header: String,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

impl Hunk {
    /// The RIGHT-side lines that can carry a comment (added and context lines).
    pub fn commentable(&self) -> Option<RangeInclusive<u32>> {
        let first = self.lines.iter().find_map(|line| line.new_line)?;
        let last = self.lines.iter().rev().find_map(|line| line.new_line).unwrap_or(first);
        Some(first..=last)
    }

    /// Whether `line` is a commentable line of this hunk.
    pub fn contains(&self, line: u32) -> bool {
        self.commentable().is_some_and(|range| range.contains(&line))
    }
}

/// A file of the PR with its parsed hunks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub previous_path: Option<String>,
    /// Whether GitHub sent a patch at all.
    pub has_patch: bool,
    pub hunks: Vec<Hunk>,
}

impl FileDiff {
    /// Parses the patch of `file` (no hunks when it has none).
    pub fn from_pr_file(file: &PrFile) -> Self {
        Self {
            path: file.path.clone(),
            status: file.status.clone(),
            previous_path: file.previous_path.clone().filter(|previous| *previous != file.path),
            has_patch: file.patch.is_some(),
            hunks: file.patch.as_deref().map(parse_patch).unwrap_or_default(),
        }
    }

    /// The index of the hunk where `line` is commentable.
    pub fn hunk_of(&self, line: u32) -> Option<usize> {
        self.hunks.iter().position(|hunk| hunk.contains(line))
    }

    /// Whether `line` can carry a RIGHT-side comment.
    pub fn is_commentable(&self, line: u32) -> bool {
        self.hunk_of(line).is_some()
    }

    /// Every RIGHT-side commentable line.
    pub fn commentable_lines(&self) -> BTreeSet<u32> {
        self.hunks.iter().filter_map(Hunk::commentable).flatten().collect()
    }

    /// `FILE: path (status)` or `FILE: path (renamed from old)`.
    pub fn header(&self) -> String {
        match &self.previous_path {
            Some(previous) => format!("FILE: {} ({} from {previous})", self.path, self.status),
            None => format!("FILE: {} ({})", self.path, self.status),
        }
    }
}

/// Parses a GitHub `patch` into hunks. Text before the first `@@` (e.g. a
/// `diff --git` header), `\ No newline at end of file` markers and `\r` line
/// endings are ignored.
pub fn parse_patch(patch: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut next_new = 0u32;
    for raw in patch.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.starts_with("@@") {
            if let Some(new_start) = parse_hunk_header(line) {
                next_new = new_start;
                hunks.push(Hunk { header: line.to_owned(), new_start, lines: Vec::new() });
            }
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        let (kind, text) = match line.chars().next() {
            Some('+') => (LineKind::Added, &line[1..]),
            Some('-') => (LineKind::Removed, &line[1..]),
            Some(' ') => (LineKind::Context, &line[1..]),
            Some('\\') => continue,
            // Some tools drop the space of an empty context line.
            None => (LineKind::Context, ""),
            Some(_) => continue,
        };
        let new_line = match kind {
            LineKind::Removed => None,
            LineKind::Added | LineKind::Context => {
                let number = next_new;
                next_new = next_new.saturating_add(1);
                Some(number)
            }
        };
        hunk.lines.push(DiffLine { kind, new_line, text: text.to_owned() });
    }
    // A trailing empty "context" line is just the patch's final newline.
    for hunk in &mut hunks {
        if hunk.lines.last().is_some_and(|line| line.kind == LineKind::Context && line.text.is_empty()) {
            let declared_end = declared_new_end(&hunk.header);
            let last_number = hunk.lines.last().and_then(|line| line.new_line);
            if declared_end.is_some_and(|end| last_number.is_some_and(|number| number > end)) {
                hunk.lines.pop();
            }
        }
    }
    hunks
}

/// The new-side start of `@@ -a[,b] +c[,d] @@`.
fn parse_hunk_header(header: &str) -> Option<u32> {
    let new_part = header.split_whitespace().find(|part| part.starts_with('+'))?;
    let start = new_part[1..].split(',').next()?;
    start.parse().ok()
}

/// The last new-side line a hunk header declares (`c + d - 1`).
fn declared_new_end(header: &str) -> Option<u32> {
    let new_part = header.split_whitespace().find(|part| part.starts_with('+'))?;
    let mut parts = new_part[1..].split(',');
    let start: u32 = parts.next()?.parse().ok()?;
    let count: u32 = parts.next().map_or(Some(1), |count| count.parse().ok())?;
    Some((start + count).saturating_sub(1))
}

/// Renders one diff line with its new-side number.
fn render_line(line: &DiffLine) -> String {
    match (line.kind, line.new_line) {
        (LineKind::Added, Some(number)) => format!("{number:>NUMBER_WIDTH$} + {}", line.text),
        (LineKind::Context, Some(number)) => format!("{number:>NUMBER_WIDTH$}   {}", line.text),
        _ => format!("{:>NUMBER_WIDTH$} - {}", "", line.text),
    }
}

/// Renders a hunk, keeping it within `budget` bytes. Returns the text,
/// whether lines were cut, and how many of the hunk's lines were rendered.
fn render_hunk(hunk: &Hunk, budget: usize) -> (String, bool, usize) {
    let mut text = format!("{}\n", hunk.header);
    let note =
        |remaining: usize| format!("{:>NUMBER_WIDTH$} ... (hunk truncated: {remaining} more lines not shown)\n", "");
    // Room kept for the truncation note (its longest form).
    let reserve = note(hunk.lines.len()).len();
    for (index, line) in hunk.lines.iter().enumerate() {
        let rendered = render_line(line);
        let is_last = index + 1 == hunk.lines.len();
        let needed = rendered.len() + 1 + if is_last { 0 } else { reserve };
        if text.len().saturating_add(needed) > budget {
            text.push_str(&note(hunk.lines.len() - index));
            return (text, true, index);
        }
        text.push_str(&rendered);
        text.push('\n');
    }
    (text, false, hunk.lines.len())
}

/// Renders a whole file (header and every hunk), without a size limit.
pub fn render_file(file: &FileDiff) -> String {
    let mut text = format!("{}\n", file.header());
    for hunk in &file.hunks {
        text.push_str(&render_hunk(hunk, usize::MAX).0);
    }
    text
}

/// The first `lines` lines of `hunk` (what a truncated rendering showed).
fn hunk_prefix(hunk: &Hunk, lines: usize) -> Hunk {
    Hunk { header: hunk.header.clone(), new_start: hunk.new_start, lines: hunk.lines[..lines].to_vec() }
}

/// Why a path is not reviewed, if it is on the skip list.
///
/// The list is deliberately small: lockfiles, minified bundles and source
/// maps, vendored or build output directories, generated files, and binary or
/// image formats.
pub fn skip_reason(path: &str) -> Option<&'static str> {
    const LOCKFILES: [&str; 10] = [
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "cargo.lock",
        "gemfile.lock",
        "poetry.lock",
        "composer.lock",
        "go.sum",
    ];
    const MINIFIED: [&str; 4] = [".min.js", ".min.css", ".map", ".min.mjs"];
    const VENDORED_DIRS: [&str; 6] = ["node_modules/", "vendor/", "dist/", "build/", "target/", "third_party/"];
    const BINARY: [&str; 22] = [
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".icns", ".webp", ".svg", ".pdf", ".zip", ".gz", ".tar",
        ".woff", ".woff2", ".ttf", ".otf", ".eot", ".exe", ".dll", ".so", ".dylib",
    ];
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or(&lower);
    if LOCKFILES.contains(&file_name) {
        Some("lockfile")
    } else if MINIFIED.iter().any(|suffix| lower.ends_with(suffix)) {
        Some("minified file or source map")
    } else if VENDORED_DIRS.iter().any(|dir| lower.starts_with(dir) || lower.contains(&format!("/{dir}"))) {
        Some("vendored or build output")
    } else if file_name.contains(".generated.") || file_name.ends_with(".pb.go") || lower.starts_with("src-tauri/gen/")
    {
        Some("generated file")
    } else if BINARY.iter().any(|suffix| lower.ends_with(suffix)) {
        Some("binary or image file")
    } else {
        None
    }
}

/// One model call's worth of annotated diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// 0-based.
    pub index: usize,
    /// The files (paths) the chunk shows, in order.
    pub files: Vec<String>,
    /// The annotated diff text.
    pub text: String,
    /// The part of each file's diff that `text` shows: only the hunks (and,
    /// for a truncated hunk, only the lines) rendered into this chunk.
    /// Findings of this chunk are validated against these, so a line the
    /// model never saw cannot become an exact inline comment.
    pub shown: Vec<FileDiff>,
}

/// The result of [`plan_chunks`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChunkPlan {
    pub chunks: Vec<Chunk>,
    /// Files shown to the model (at least partly).
    pub files_reviewed: Vec<String>,
    pub files_skipped: Vec<SkippedFile>,
    /// Truncations and partial reviews, for the report's notes.
    pub notes: Vec<String>,
}

/// A piece of one file's annotated diff (the whole file, or a group of hunks).
struct Piece {
    path: String,
    text: String,
    /// The file with only the hunks (and lines) rendered into `text`.
    shown: FileDiff,
}

impl Piece {
    fn new(file: &FileDiff, text: String, hunks: Vec<Hunk>) -> Self {
        let shown = FileDiff {
            path: file.path.clone(),
            status: file.status.clone(),
            previous_path: file.previous_path.clone(),
            has_patch: file.has_patch,
            hunks,
        };
        Self { path: file.path.clone(), text, shown }
    }
}

/// Packs `files` into chunks of at most `chunk_bytes` annotated bytes and at
/// most `max_chunks` chunks. Files on the skip list, deleted files and files
/// without a patch are reported in `files_skipped`.
pub fn plan_chunks(files: &[FileDiff], chunk_bytes: usize, max_chunks: usize) -> ChunkPlan {
    let mut plan = ChunkPlan::default();
    let mut pieces = Vec::new();
    for file in files {
        if let Some(reason) = file_skip_reason(file) {
            plan.files_skipped.push(SkippedFile { path: file.path.clone(), reason: reason.to_owned() });
            continue;
        }
        pieces.extend(file_pieces(file, chunk_bytes, &mut plan.notes));
    }

    let mut chunks: Vec<Chunk> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for piece in pieces {
        let fits = chunks.last().is_some_and(|chunk| chunk.text.len() + 1 + piece.text.len() <= chunk_bytes);
        if !fits {
            if chunks.len() >= max_chunks {
                if !dropped.contains(&piece.path) {
                    dropped.push(piece.path);
                }
                continue;
            }
            chunks.push(Chunk { index: chunks.len(), files: Vec::new(), text: String::new(), shown: Vec::new() });
        }
        let chunk = chunks.last_mut().expect("a chunk was just ensured");
        if !chunk.text.is_empty() {
            chunk.text.push('\n');
        }
        chunk.text.push_str(&piece.text);
        if !chunk.files.contains(&piece.path) {
            chunk.files.push(piece.path);
        }
        match chunk.shown.iter_mut().find(|shown| shown.path == piece.shown.path) {
            Some(shown) => shown.hunks.extend(piece.shown.hunks),
            None => chunk.shown.push(piece.shown),
        }
    }

    for chunk in &chunks {
        for path in &chunk.files {
            if !plan.files_reviewed.contains(path) {
                plan.files_reviewed.push(path.clone());
            }
        }
    }
    for path in dropped {
        if plan.files_reviewed.contains(&path) {
            plan.notes
                .push(format!("{path}: only part of the diff was reviewed (the PR exceeds {max_chunks} model calls)"));
        } else {
            let reason = format!("not reviewed: the PR exceeds {max_chunks} model calls");
            plan.files_skipped.push(SkippedFile { path, reason });
        }
    }
    plan.chunks = chunks;
    plan
}

/// Why a file is not reviewed at all.
fn file_skip_reason(file: &FileDiff) -> Option<&'static str> {
    if let Some(reason) = skip_reason(&file.path) {
        Some(reason)
    } else if file.status == "removed" {
        Some("file deleted")
    } else if !file.has_patch {
        Some("no textual diff from GitHub (binary or too large)")
    } else if file.hunks.is_empty() {
        Some("no changed lines")
    } else {
        None
    }
}

/// Splits one file into pieces of at most `chunk_bytes`.
fn file_pieces(file: &FileDiff, chunk_bytes: usize, notes: &mut Vec<String>) -> Vec<Piece> {
    let whole = render_file(file);
    if whole.len() <= chunk_bytes {
        return vec![Piece::new(file, whole, file.hunks.clone())];
    }
    let mut pieces: Vec<Piece> = Vec::new();
    let mut current = String::new();
    let mut current_hunks: Vec<Hunk> = Vec::new();
    for hunk in &file.hunks {
        let header = if pieces.is_empty() && current.is_empty() {
            format!("{}\n", file.header())
        } else {
            format!("{} (continued)\n", file.header())
        };
        let (hunk_text, _, _) = render_hunk(hunk, usize::MAX);
        if !current.is_empty() && current.len() + hunk_text.len() <= chunk_bytes {
            current.push_str(&hunk_text);
            current_hunks.push(hunk.clone());
            continue;
        }
        if !current.is_empty() {
            pieces.push(Piece::new(file, std::mem::take(&mut current), std::mem::take(&mut current_hunks)));
        }
        let budget = chunk_bytes.saturating_sub(header.len());
        let (hunk_text, truncated, rendered) = render_hunk(hunk, budget);
        if truncated {
            notes.push(format!(
                "{}: a hunk starting at line {} was too large and was truncated",
                file.path, hunk.new_start
            ));
        }
        current = header + &hunk_text;
        current_hunks.push(hunk_prefix(hunk, rendered));
    }
    if !current.is_empty() {
        pieces.push(Piece::new(file, current, current_hunks));
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    const MULTI: &str =
        "@@ -1,3 +1,4 @@ fn main()\n a\n-b\n+B\n+C\n c\n@@ -10,2 +11,3 @@\n x\n+y\n z\n\\ No newline at end of file";

    fn file(path: &str, status: &str, patch: Option<&str>) -> FileDiff {
        FileDiff::from_pr_file(&PrFile {
            path: path.into(),
            status: status.into(),
            patch: patch.map(str::to_owned),
            additions: 0,
            deletions: 0,
            previous_path: None,
        })
    }

    fn numbers(hunk: &Hunk) -> Vec<(LineKind, Option<u32>)> {
        hunk.lines.iter().map(|line| (line.kind, line.new_line)).collect()
    }

    #[test]
    fn unit_parses_multiple_hunks_with_new_side_numbers() {
        let hunks = parse_patch(MULTI);
        assert_eq!(hunks.len(), 2);
        assert_eq!(
            numbers(&hunks[0]),
            [
                (LineKind::Context, Some(1)),
                (LineKind::Removed, None),
                (LineKind::Added, Some(2)),
                (LineKind::Added, Some(3)),
                (LineKind::Context, Some(4)),
            ]
        );
        assert_eq!(hunks[0].header, "@@ -1,3 +1,4 @@ fn main()");
        assert_eq!(
            numbers(&hunks[1]),
            [(LineKind::Context, Some(11)), (LineKind::Added, Some(12)), (LineKind::Context, Some(13))]
        );
        assert_eq!(hunks[1].lines[2].text, "z", "the no-newline marker is not a line");
    }

    #[test]
    fn unit_handles_crlf_empty_and_headerless_patches() {
        let hunks = parse_patch("@@ -1 +1 @@\r\n-old\r\n+new\r\n");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 2);
        assert_eq!(hunks[0].lines[1].text, "new");
        assert!(parse_patch("").is_empty());
        assert!(parse_patch("Binary files differ").is_empty());
        let hunks = parse_patch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n+two\n");
        assert_eq!(numbers(&hunks[0]), [(LineKind::Added, Some(1)), (LineKind::Added, Some(2))]);
    }

    #[test]
    fn unit_keeps_empty_context_lines_inside_hunks() {
        // The empty line in the middle lost its leading space.
        let hunks = parse_patch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c");
        assert_eq!(
            numbers(&hunks[0]),
            [
                (LineKind::Context, Some(1)),
                (LineKind::Context, Some(2)),
                (LineKind::Removed, None),
                (LineKind::Added, Some(3))
            ]
        );
    }

    #[test]
    fn unit_commentable_lines_are_added_and_context() {
        let diff = file("a.rs", "modified", Some(MULTI));
        assert_eq!(diff.commentable_lines().into_iter().collect::<Vec<_>>(), [1, 2, 3, 4, 11, 12, 13]);
        assert!(diff.is_commentable(12));
        assert!(!diff.is_commentable(5));
        assert_eq!(diff.hunk_of(13), Some(1));
        assert_eq!(diff.hunk_of(9), None);
    }

    #[test]
    fn unit_renders_annotated_view() {
        let diff = file("src/a.rs", "modified", Some(MULTI));
        let text = render_file(&diff);
        let expected = "FILE: src/a.rs (modified)\n\
                        @@ -1,3 +1,4 @@ fn main()\n    \
                        1   a\n      \
                        - b\n    \
                        2 + B\n    \
                        3 + C\n    \
                        4   c\n\
                        @@ -10,2 +11,3 @@\n   \
                        11   x\n   \
                        12 + y\n   \
                        13   z\n";
        assert_eq!(text, expected);
    }

    #[test]
    fn unit_renamed_header_names_the_old_path() {
        let diff = FileDiff::from_pr_file(&PrFile {
            path: "new.rs".into(),
            status: "renamed".into(),
            patch: Some("@@ -1 +1 @@\n-a\n+b".into()),
            additions: 1,
            deletions: 1,
            previous_path: Some("old.rs".into()),
        });
        assert_eq!(diff.header(), "FILE: new.rs (renamed from old.rs)");
        // A pure rename has no patch and no hunks.
        let pure = file("x.rs", "renamed", None);
        assert!(pure.hunks.is_empty());
    }

    #[test]
    fn unit_skip_list() {
        for (path, reason) in [
            ("package-lock.json", "lockfile"),
            ("src-tauri/Cargo.lock", "lockfile"),
            ("web/app.min.js", "minified file or source map"),
            ("dist/index.js", "vendored or build output"),
            ("ui/node_modules/x/index.js", "vendored or build output"),
            ("api.generated.ts", "generated file"),
            ("icons/icon.png", "binary or image file"),
            ("logo.SVG", "binary or image file"),
        ] {
            assert_eq!(skip_reason(path), Some(reason), "{path}");
        }
        for path in ["src/lib.rs", "src/distance.rs", "builder.ts", "README.md"] {
            assert_eq!(skip_reason(path), None, "{path}");
        }
    }

    #[test]
    fn unit_plans_chunks_and_reports_skipped_files() {
        let files = vec![
            file("a.rs", "modified", Some(MULTI)),
            file("package-lock.json", "modified", Some("@@ -1 +1 @@\n-a\n+b")),
            file("big.bin", "added", None),
            file("gone.rs", "removed", Some("@@ -1 +0,0 @@\n-a")),
            file("b.rs", "added", Some("@@ -0,0 +1 @@\n+x")),
        ];
        let plan = plan_chunks(&files, DEFAULT_CHUNK_BYTES, MAX_CHUNKS);
        assert_eq!(plan.chunks.len(), 1);
        assert_eq!(plan.chunks[0].files, ["a.rs", "b.rs"]);
        assert_eq!(plan.files_reviewed, ["a.rs", "b.rs"]);
        let skipped: Vec<_> =
            plan.files_skipped.iter().map(|skip| (skip.path.as_str(), skip.reason.as_str())).collect();
        assert_eq!(
            skipped,
            [
                ("package-lock.json", "lockfile"),
                ("big.bin", "no textual diff from GitHub (binary or too large)"),
                ("gone.rs", "file deleted"),
            ]
        );
    }

    #[test]
    fn unit_splits_big_files_by_hunk_and_truncates_oversized_hunks() {
        let small_hunks: String =
            (0..20).map(|i| format!("@@ -{0},1 +{0},1 @@\n-{1}\n+{1}x\n", i * 100 + 1, "a".repeat(200))).collect();
        let added: String = (0..300).map(|_| format!("+{}\n", "y".repeat(100))).collect();
        let big_hunk = format!("@@ -4999,0 +5000,300 @@\n{added}");
        let files = vec![file("many.rs", "modified", Some(&small_hunks)), file("huge.rs", "added", Some(&big_hunk))];
        let plan = plan_chunks(&files, 4096, MAX_CHUNKS);
        assert!(plan.chunks.len() > 2);
        for chunk in &plan.chunks {
            assert!(chunk.text.len() <= 4096, "chunk {} is {} bytes", chunk.index, chunk.text.len());
            assert!(chunk.text.starts_with("FILE: "));
        }
        assert!(plan.chunks.iter().any(|chunk| chunk.text.contains("(continued)")));
        let huge = plan.chunks.iter().find(|chunk| chunk.files == ["huge.rs"]).unwrap();
        assert!(huge.text.contains("hunk truncated"));
        assert!(plan.notes.iter().any(|note| note.starts_with("huge.rs: a hunk starting at line 5000")));
        assert_eq!(plan.files_reviewed, ["many.rs", "huge.rs"]);
        let indexes: Vec<_> = plan.chunks.iter().map(|chunk| chunk.index).collect();
        assert_eq!(indexes, (0..plan.chunks.len()).collect::<Vec<_>>());
    }

    #[test]
    fn unit_chunks_only_validate_the_lines_they_show() {
        use crate::review::findings::place;
        // many.rs: 20 one-line hunks at new lines 1, 101, ..., 1901 (split across chunks).
        let small_hunks: String =
            (0..20).map(|i| format!("@@ -{0},1 +{0},1 @@\n-{1}\n+{1}x\n", i * 100 + 1, "a".repeat(200))).collect();
        // huge.rs: one 300-line hunk at 5000..=5299 (truncated).
        let added: String = (0..300).map(|_| format!("+{}\n", "y".repeat(100))).collect();
        let big_hunk = format!("@@ -4999,0 +5000,300 @@\n{added}");
        let files = vec![file("many.rs", "modified", Some(&small_hunks)), file("huge.rs", "added", Some(&big_hunk))];
        let plan = plan_chunks(&files, 4096, MAX_CHUNKS);

        let many: Vec<&FileDiff> =
            plan.chunks.iter().filter_map(|chunk| chunk.shown.iter().find(|shown| shown.path == "many.rs")).collect();
        assert!(many.len() >= 2, "many.rs is split across chunks");
        let first = many[0];
        let last_line = 1901;
        assert!(!first.is_commentable(last_line), "a hunk of another chunk is not shown here");
        let placement = place(first, last_line, None);
        assert!(!placement.postable, "{placement:?}");
        assert!(place(many[many.len() - 1], last_line, None).postable, "but it is in its own chunk");
        let shown_hunks: usize = many.iter().map(|shown| shown.hunks.len()).sum();
        assert_eq!(shown_hunks, 20, "every hunk is shown exactly once");

        let huge = plan.chunks.iter().find(|chunk| chunk.files == ["huge.rs"]).unwrap();
        assert_eq!(huge.shown.len(), 1);
        let shown = &huge.shown[0];
        let range = shown.hunks[0].commentable().unwrap();
        assert_eq!(*range.start(), 5000);
        assert!(*range.end() < 5299, "only the rendered lines: {range:?}");
        assert!(huge.text.contains(&format!("{:>5} + ", range.end())));
        assert!(!huge.text.contains(&format!("{:>5} + ", range.end() + 1)));
        let placement = place(shown, 5200, None);
        assert!(!placement.postable, "a line after the truncation note: {placement:?}");
        assert!(place(shown, 5001, Some(5000)).postable);
    }

    #[test]
    fn unit_limits_the_number_of_chunks() {
        let files: Vec<_> = (0..5)
            .map(|i| file(&format!("f{i}.rs"), "added", Some(&format!("@@ -0,0 +1 @@\n+{}", "z".repeat(3000)))))
            .collect();
        let plan = plan_chunks(&files, 4096, 2);
        assert_eq!(plan.chunks.len(), 2);
        assert_eq!(plan.files_reviewed, ["f0.rs", "f1.rs"]);
        assert_eq!(plan.files_skipped.len(), 3);
        assert!(plan.files_skipped[0].reason.contains("exceeds 2 model calls"));
    }
}
