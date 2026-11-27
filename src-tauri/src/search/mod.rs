//! Workspace search (ripgrep libraries), replace, and the Quick Open file index.
//!
//! * Searching is read-only: files are never modified by a search.
//! * Walks respect `.gitignore` (optional), hidden-file rules and `files.exclude`; symlinks are not
//!   followed; files larger than 10 MB and binary files are skipped.
//! * Searches run on a thread pool, stream results in batches and stop when cancelled or when the
//!   result limit is reached.
//! * Replace only touches files the user confirmed, re-reads each file and refuses to write if it
//!   changed since the preview (content hash).

pub mod fuzzy;

use crate::error::{AppError, AppResult};
use crate::fs::list::{build_globs, is_excluded};
use crate::workspace::paths::NormalizedPath;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{sinks::UTF8, BinaryDetection, SearcherBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const PREVIEW_CHARS: usize = 240;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub pattern: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Glob patterns (comma separated in the UI) that files must match.
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Honour .gitignore and files.exclude (default true).
    #[serde(default = "yes")]
    pub use_ignore: bool,
    #[serde(default = "default_max")]
    pub max_results: usize,
}

fn yes() -> bool {
    true
}
fn default_max() -> usize {
    20_000
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based line number.
    pub line: u64,
    /// Ranges in the preview, in UTF-16 code units (JavaScript string indices).
    pub ranges: Vec<(usize, usize)>,
    pub preview: String,
    /// Character offset of the preview within the line (0 when the line was not trimmed).
    pub preview_offset: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub root: usize,
    pub path: String,
    pub matches: Vec<LineMatch>,
}

pub fn build_matcher(q: &Query) -> AppResult<RegexMatcher> {
    if q.pattern.is_empty() || q.pattern.len() > 4096 {
        return Err(AppError::validation("invalid_query", "enter a search term"));
    }
    RegexMatcherBuilder::new()
        .fixed_strings(!q.is_regex)
        .case_insensitive(!q.case_sensitive)
        .word(q.whole_word)
        .line_terminator(Some(b'\n'))
        .build(&q.pattern)
        .map_err(|e| AppError::validation("invalid_regex", format!("invalid regular expression: {e}")))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Build a preview of a long line around its first match and convert byte ranges to UTF-16.
fn preview(line: &str, byte_ranges: &[(usize, usize)]) -> (String, usize, Vec<(usize, usize)>) {
    let line = line.trim_end_matches(['\n', '\r']);
    let first = byte_ranges.first().map(|r| r.0).unwrap_or(0).min(line.len());
    // Start a little before the first match when the line is long.
    let mut start = 0;
    if line.chars().count() > PREVIEW_CHARS && first > 40 {
        start = first - 40;
        while !line.is_char_boundary(start) {
            start -= 1;
        }
    }
    let end = line[start..].char_indices().nth(PREVIEW_CHARS).map(|(i, _)| start + i).unwrap_or(line.len());
    let text = &line[start..end];
    let ranges = byte_ranges
        .iter()
        .filter(|(s, e)| *s >= start && *e <= end && s < e)
        .map(|(s, e)| (utf16_len(&line[start..*s]), utf16_len(&line[start..*e])))
        .collect();
    (text.to_string(), utf16_len(&line[..start]), ranges)
}

/// Search one file. Returns matches (possibly empty). Binary files yield nothing.
pub fn search_file(matcher: &RegexMatcher, path: &Path, budget: &AtomicUsize) -> Vec<LineMatch> {
    let mut out = Vec::new();
    let mut searcher = SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).line_number(true).build();
    let _ = searcher.search_path(
        matcher,
        path,
        UTF8(|lnum, line| {
            let mut ranges = Vec::new();
            let _ = matcher.find_iter(line.as_bytes(), |m| {
                ranges.push((m.start(), m.end()));
                ranges.len() < 1000
            });
            if ranges.is_empty() {
                return Ok(true);
            }
            let (text, offset, r) = preview(line, &ranges);
            out.push(LineMatch { line: lnum, ranges: r, preview: text, preview_offset: offset });
            let prev = budget.fetch_sub(1, Ordering::Relaxed);
            Ok(prev > 1)
        }),
    );
    out
}

/// Files to search in a root (relative `/` paths), honouring ignore rules and globs.
pub fn walk(
    root: &NormalizedPath,
    exclude_setting: &[String],
    q: &Query,
    cancel: &AtomicBool,
    mut f: impl FnMut(String, std::path::PathBuf) -> bool,
) {
    let excl = build_globs(&if q.use_ignore { [exclude_setting, &q.exclude[..]].concat() } else { q.exclude.clone() });
    let incl = build_globs(
        &q.include
            .iter()
            .map(|g| if g.contains('/') || g.starts_with("**") { g.clone() } else { format!("**/{g}") })
            .collect::<Vec<_>>(),
    );
    let walker = ignore::WalkBuilder::new(&root.path)
        .hidden(false)
        .git_ignore(q.use_ignore)
        .git_global(false)
        .git_exclude(q.use_ignore)
        .ignore(q.use_ignore)
        .parents(false)
        .follow_links(false)
        .require_git(false)
        .build();
    for entry in walker {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(rel) = crate::fs::scope::rel_of(&root.path, entry.path()) else { continue };
        if rel.starts_with(".git/") || is_excluded(&excl, &rel) {
            continue;
        }
        if !q.include.is_empty() && !incl.is_match(&rel) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        if !f(rel, entry.into_path()) {
            return;
        }
    }
}

/// Run a search over all roots; `emit` receives batches of file matches.
pub fn run(
    roots: &[NormalizedPath],
    exclude_setting: &[String],
    q: &Query,
    cancel: Arc<AtomicBool>,
    emit: impl Fn(Vec<FileMatches>) + Send + Sync,
) -> AppResult<SearchSummary> {
    let matcher = build_matcher(q)?;
    let budget = AtomicUsize::new(q.max_results.clamp(1, 100_000));
    let files_searched = AtomicUsize::new(0);
    let mut total = 0usize;
    let mut file_count = 0usize;
    let mut batch: Vec<FileMatches> = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        let mut paths = Vec::new();
        walk(root, exclude_setting, q, &cancel, |rel, abs| {
            paths.push((rel, abs));
            paths.len() < 500_000
        });
        // Search in parallel, preserving per-file order of results.
        use rayon_like::par_map;
        let results = par_map(&paths, |(rel, abs)| {
            if cancel.load(Ordering::Relaxed) || budget.load(Ordering::Relaxed) == 0 {
                return None;
            }
            files_searched.fetch_add(1, Ordering::Relaxed);
            let m = search_file(&matcher, abs, &budget);
            (!m.is_empty()).then(|| FileMatches { root: i, path: rel.clone(), matches: m })
        });
        for fm in results.into_iter().flatten() {
            total += fm.matches.len();
            file_count += 1;
            batch.push(fm);
            if batch.len() >= 50 {
                emit(std::mem::take(&mut batch));
            }
        }
        if cancel.load(Ordering::Relaxed) {
            break;
        }
    }
    if !batch.is_empty() {
        emit(batch);
    }
    Ok(SearchSummary {
        matches: total,
        files: file_count,
        files_searched: files_searched.load(Ordering::Relaxed),
        limit_hit: budget.load(Ordering::Relaxed) == 0,
        cancelled: cancel.load(Ordering::Relaxed),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub matches: usize,
    pub files: usize,
    pub files_searched: usize,
    pub limit_hit: bool,
    pub cancelled: bool,
}

/// Minimal scoped parallel map over a slice using std threads (no extra dependency).
mod rayon_like {
    pub fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16);
        if items.len() < 64 || threads == 1 {
            return items.iter().map(&f).collect();
        }
        let chunk = items.len().div_ceil(threads);
        std::thread::scope(|s| {
            let handles: Vec<_> =
                items.chunks(chunk).map(|c| s.spawn(|| c.iter().map(&f).collect::<Vec<R>>())).collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        })
    }
}

/// Replace all matches in one file's content. Returns the new content and the number of
/// replacements. With `is_regex`, `$1`/`${name}` in the replacement refer to capture groups.
pub fn replace_in(content: &str, q: &Query, replacement: &str) -> AppResult<(String, usize)> {
    let mut pattern = if q.is_regex { q.pattern.clone() } else { regex::escape(&q.pattern) };
    if q.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| AppError::validation("invalid_regex", e.to_string()))?;
    let count = re.find_iter(content).count();
    let out = if q.is_regex {
        re.replace_all(content, replacement).into_owned()
    } else {
        re.replace_all(content, regex::NoExpand(replacement)).into_owned()
    };
    Ok((out, count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::paths::normalize_dir;

    fn q(pattern: &str) -> Query {
        Query {
            pattern: pattern.into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include: vec![],
            exclude: vec![],
            use_ignore: true,
            max_results: 1000,
        }
    }

    fn tree() -> (tempfile::TempDir, Vec<NormalizedPath>) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::create_dir_all(p.join("target")).unwrap();
        std::fs::create_dir_all(p.join("node_modules/x")).unwrap();
        std::fs::write(p.join("src/main.rs"), "fn main() {\n    let needle = 1; // Needle\n}\n").unwrap();
        std::fs::write(p.join("src/lib.rs"), "pub fn needles() {}\n").unwrap();
        std::fs::write(p.join("target/out.rs"), "needle\n").unwrap();
        std::fs::write(p.join("node_modules/x/i.js"), "needle\n").unwrap();
        std::fs::write(p.join("bin.dat"), b"needle\0\x01\x02").unwrap();
        std::fs::write(p.join("ünï.txt"), "café needle ünï\n").unwrap();
        std::fs::write(p.join(".gitignore"), "target/\n").unwrap();
        let roots = vec![normalize_dir(p).unwrap()];
        (d, roots)
    }

    fn collect(roots: &[NormalizedPath], query: &Query) -> (Vec<FileMatches>, SearchSummary) {
        let out = std::sync::Mutex::new(Vec::new());
        let s = run(roots, &["**/node_modules".into()], query, Arc::new(AtomicBool::new(false)), |b| {
            out.lock().unwrap().extend(b)
        })
        .unwrap();
        let mut v = out.into_inner().unwrap();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        (v, s)
    }

    #[test]
    fn finds_text_respecting_ignores_and_binaries() {
        let (_d, roots) = tree();
        let (files, s) = collect(&roots, &q("needle"));
        let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["src/lib.rs", "src/main.rs", "ünï.txt"]);
        assert_eq!(files[1].matches[0].line, 2);
        assert_eq!(files[1].matches[0].ranges.len(), 2, "case-insensitive: needle and Needle");
        assert!(!s.limit_hit);
        // UTF-16 ranges: "café " is 5 UTF-16 units.
        assert_eq!(files[2].matches[0].ranges[0], (5, 11));
    }

    #[test]
    fn options_regex_case_word_include_and_no_ignore() {
        let (_d, roots) = tree();
        let mut query = q("needle");
        query.case_sensitive = true;
        query.whole_word = true;
        let (files, _) = collect(&roots, &query);
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["src/main.rs", "ünï.txt"]);
        let mut re = q(r"fn \w+\(\)");
        re.is_regex = true;
        re.include = vec!["*.rs".into()];
        let (files, _) = collect(&roots, &re);
        assert_eq!(files.len(), 2);
        let mut all = q("needle");
        all.use_ignore = false;
        let (files, _) = collect(&roots, &all);
        assert!(files.iter().any(|f| f.path == "target/out.rs"));
        assert!(files.iter().any(|f| f.path.starts_with("node_modules")));
        let mut bad = q("(");
        bad.is_regex = true;
        assert!(build_matcher(&bad).is_err());
    }

    #[test]
    fn result_limit_and_cancellation() {
        let (_d, roots) = tree();
        let mut query = q("e");
        query.max_results = 2;
        let (_, s) = collect(&roots, &query);
        assert!(s.limit_hit);
        let cancel = Arc::new(AtomicBool::new(true));
        let s = run(&roots, &[], &q("needle"), cancel, |_| {}).unwrap();
        assert!(s.cancelled);
        assert_eq!(s.files, 0);
    }

    #[test]
    fn replacement_literal_and_regex() {
        let (out, n) = replace_in("a.b a.b axb", &q("a.b"), "$1").unwrap();
        assert_eq!((out.as_str(), n), ("$1 $1 axb", 2), "literal: dots and $ are not special");
        let mut re = q(r"(\w+)@(\w+)");
        re.is_regex = true;
        assert_eq!(replace_in("me@home you@work", &re, "$2:$1").unwrap().0, "home:me work:you");
        let mut w = q("cat");
        w.whole_word = true;
        assert_eq!(replace_in("cat concat Cat", &w, "dog").unwrap().0, "dog concat dog");
    }

    #[test]
    fn previews_long_lines_around_the_match() {
        let line = format!("{}needle{}", "x".repeat(500), "y".repeat(500));
        let (text, offset, ranges) = preview(&line, &[(500, 506)]);
        assert_eq!(offset, 460);
        assert_eq!(&text[ranges[0].0..ranges[0].1], "needle");
        assert!(text.chars().count() <= PREVIEW_CHARS);
    }
}

/// Manual benchmark on a large real tree: `cargo test --release bench_large_tree -- --ignored --nocapture`.
#[cfg(test)]
mod bench {
    use super::*;
    use crate::workspace::paths::normalize_dir;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn bench_large_tree() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("node_modules");
        let root = normalize_dir(&dir).expect("run `npm ci` first");
        let walk_q = Query {
            pattern: "x".into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include: vec![],
            exclude: vec![],
            use_ignore: false,
            max_results: 1,
        };
        let t = Instant::now();
        let mut files = Vec::new();
        walk(&root, &[], &walk_q, &AtomicBool::new(false), |rel, _| {
            files.push((0usize, rel));
            true
        });
        let walk_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let best = fuzzy::best("editormodel", files.iter().map(|(r, p)| (*r, p.as_str())), 50);
        let fuzzy_ms = t.elapsed().as_millis();
        for (pattern, regex) in [("useState", false), (r"function\s+\w+Async", true)] {
            let q = Query {
                pattern: pattern.into(),
                is_regex: regex,
                case_sensitive: false,
                whole_word: false,
                include: vec![],
                exclude: vec![],
                use_ignore: false,
                max_results: 20_000,
            };
            let t = Instant::now();
            let s = run(std::slice::from_ref(&root), &[], &q, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
            eprintln!(
                "search {pattern:?}: {} matches in {} files ({} searched) in {} ms, limit hit: {}",
                s.matches,
                s.files,
                s.files_searched,
                t.elapsed().as_millis(),
                s.limit_hit
            );
        }
        eprintln!(
            "walk: {} files in {walk_ms} ms; fuzzy over all: {fuzzy_ms} ms (best: {:?})",
            files.len(),
            best.first().map(|b| &b.1)
        );
    }
}
