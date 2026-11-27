//! Lazy directory listing with exclusions and `.gitignore` support.
//!
//! Only one directory is read per call (the explorer loads children on expand). Exclusion globs
//! (`files.exclude`) remove entries; `.gitignore` matches are reported (`ignored`) so the UI can dim
//! or hide them. Nested `.gitignore` files are honoured: the deepest file that has an opinion wins.

use super::scope::Target;
use crate::error::AppResult;
use globset::{GlobSet, GlobSetBuilder};
use ignore::gitignore::Gitignore;
use ignore::Match;
use serde::Serialize;
use std::path::Path;

pub const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    /// A symbolic link or junction (not followed by the explorer).
    Link,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified: i64,
    pub hidden: bool,
    pub ignored: bool,
    pub readonly: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitIgnored {
    Dim,
    Hide,
    Show,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    FoldersFirst,
    Mixed,
    Type,
    Modified,
}

pub struct ListOptions {
    pub show_hidden: bool,
    pub git_ignored: GitIgnored,
    pub exclude: GlobSet,
    pub sort: Sort,
}

impl ListOptions {
    pub fn from_settings(values: &crate::settings::ResolvedSettings) -> Self {
        let get = |k: &str| values.values.get(k).map(|r| r.value.clone()).unwrap_or_default();
        let patterns: Vec<String> = get("files.exclude")
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        Self {
            show_hidden: get("explorer.showHidden").as_bool().unwrap_or(true),
            git_ignored: match get("explorer.gitIgnored").as_str() {
                Some("hide") => GitIgnored::Hide,
                Some("show") => GitIgnored::Show,
                _ => GitIgnored::Dim,
            },
            exclude: build_globs(&patterns),
            sort: match get("explorer.sortOrder").as_str() {
                Some("mixed") => Sort::Mixed,
                Some("type") => Sort::Type,
                Some("modified") => Sort::Modified,
                _ => Sort::FoldersFirst,
            },
        }
    }
}

/// Compile exclusion globs; invalid patterns are skipped (validated as plain strings in settings).
pub fn build_globs(patterns: &[String]) -> GlobSet {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let p = p.trim().trim_start_matches("./");
        if p.is_empty() {
            continue;
        }
        if let Ok(g) = globset::GlobBuilder::new(p).literal_separator(true).case_insensitive(cfg!(windows)).build() {
            b.add(g);
        }
    }
    b.build().unwrap_or_else(|_| GlobSet::empty())
}

/// True if `rel` (or any of its parent directories) matches an exclusion glob.
pub fn is_excluded(set: &GlobSet, rel: &str) -> bool {
    if set.is_empty() || rel.is_empty() {
        return false;
    }
    let mut cur = rel;
    loop {
        if set.is_match(cur) {
            return true;
        }
        match cur.rsplit_once('/') {
            Some((parent, _)) => cur = parent,
            None => return false,
        }
    }
}

/// `.gitignore` matchers from the root down to `dir` (deepest last), plus `.git/info/exclude`.
pub fn gitignore_chain(root: &Path, dir: &Path) -> Vec<Gitignore> {
    let mut dirs = vec![dir.to_path_buf()];
    let mut cur = dir;
    while cur != root {
        match cur.parent() {
            Some(p) if p.starts_with(root) => {
                dirs.push(p.to_path_buf());
                cur = p;
            }
            _ => break,
        }
    }
    dirs.reverse();
    let mut out = Vec::new();
    let info_exclude = root.join(".git").join("info").join("exclude");
    if info_exclude.is_file() {
        let mut b = ignore::gitignore::GitignoreBuilder::new(root);
        if b.add(&info_exclude).is_none() {
            if let Ok(g) = b.build() {
                out.push(g);
            }
        }
    }
    for d in dirs {
        let f = d.join(".gitignore");
        if f.is_file() {
            let (g, _err) = Gitignore::new(&f);
            out.push(g);
        }
    }
    out
}

/// Evaluate a path against a matcher chain (deepest decision wins).
pub fn is_git_ignored(chain: &[Gitignore], path: &Path, is_dir: bool) -> bool {
    for g in chain.iter().rev() {
        match g.matched_path_or_any_parents(path, is_dir) {
            Match::Ignore(_) => return true,
            Match::Whitelist(_) => return false,
            Match::None => {}
        }
    }
    false
}

#[cfg(windows)]
fn hidden_attr(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x2 != 0
}
#[cfg(not(windows))]
fn hidden_attr(_meta: &std::fs::Metadata) -> bool {
    false
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn ext(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<Entry>,
    /// The directory had more than `MAX_ENTRIES` entries; the rest were not listed.
    pub truncated: bool,
    /// The directory itself is ignored by `.gitignore` (children inherit the flag).
    pub ignored: bool,
}

pub fn list(dir: &Target, opts: &ListOptions) -> AppResult<Listing> {
    let chain =
        if opts.git_ignored == GitIgnored::Show { Vec::new() } else { gitignore_chain(&dir.root.path, &dir.abs) };
    let dir_ignored = !dir.is_root() && is_git_ignored(&chain, &dir.abs, true);
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in std::fs::read_dir(&dir.abs)? {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        let rel = if dir.rel.is_empty() { name.clone() } else { format!("{}/{name}", dir.rel) };
        if is_excluded(&opts.exclude, &rel) {
            continue;
        }
        let Ok(lmeta) = std::fs::symlink_metadata(item.path()) else { continue };
        let kind = if lmeta.file_type().is_symlink() {
            EntryKind::Link
        } else if lmeta.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        };
        let hidden = name.starts_with('.') || hidden_attr(&lmeta);
        if hidden && !opts.show_hidden {
            continue;
        }
        let ignored =
            dir_ignored || (!chain.is_empty() && is_git_ignored(&chain, &item.path(), kind == EntryKind::Dir));
        if ignored && opts.git_ignored == GitIgnored::Hide {
            continue;
        }
        entries.push(Entry {
            name,
            kind,
            size: if kind == EntryKind::File { lmeta.len() } else { 0 },
            modified: millis(lmeta.modified()),
            hidden,
            ignored,
            readonly: lmeta.permissions().readonly(),
        });
    }
    sort(&mut entries, opts.sort);
    Ok(Listing { entries, truncated, ignored: dir_ignored })
}

/// Natural, case-insensitive name ordering ("file2" < "file10").
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let o = na
                    .trim_start_matches('0')
                    .len()
                    .cmp(&nb.trim_start_matches('0').len())
                    .then_with(|| na.trim_start_matches('0').cmp(nb.trim_start_matches('0')));
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

pub fn sort(entries: &mut [Entry], order: Sort) {
    let dir_first = |e: &Entry| if e.kind == EntryKind::Dir { 0 } else { 1 };
    match order {
        Sort::FoldersFirst => {
            entries.sort_by(|a, b| dir_first(a).cmp(&dir_first(b)).then_with(|| natural_cmp(&a.name, &b.name)))
        }
        Sort::Mixed => entries.sort_by(|a, b| natural_cmp(&a.name, &b.name)),
        Sort::Type => entries.sort_by(|a, b| {
            dir_first(a)
                .cmp(&dir_first(b))
                .then_with(|| ext(&a.name).cmp(&ext(&b.name)))
                .then_with(|| natural_cmp(&a.name, &b.name))
        }),
        Sort::Modified => {
            entries.sort_by(|a, b| dir_first(a).cmp(&dir_first(b)).then_with(|| b.modified.cmp(&a.modified)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::scope::resolve;
    use crate::workspace::paths::normalize_dir;

    fn opts(patterns: &[&str], git: GitIgnored) -> ListOptions {
        ListOptions {
            show_hidden: true,
            git_ignored: git,
            exclude: build_globs(&patterns.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
            sort: Sort::FoldersFirst,
        }
    }

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        for dir in ["src", "target", "node_modules/pkg", ".git", "src/gen"] {
            std::fs::create_dir_all(p.join(dir)).unwrap();
        }
        for f in
            ["src/main.rs", "src/file10.rs", "src/file2.rs", "README.md", "debug.log", "keep.log", "src/gen/out.rs"]
        {
            std::fs::write(p.join(f), "x").unwrap();
        }
        std::fs::write(p.join(".gitignore"), "target/\n*.log\n!keep.log\n").unwrap();
        std::fs::write(p.join("src/.gitignore"), "gen/\n").unwrap();
        d
    }

    #[test]
    fn excludes_and_marks_gitignored() {
        let d = tree();
        let roots = vec![normalize_dir(d.path()).unwrap()];
        let root = resolve(&roots, 0, "").unwrap();
        let l = list(&root, &opts(&["**/.git", "**/node_modules"], GitIgnored::Dim)).unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| (e.name.as_str(), e.ignored)).collect();
        assert_eq!(
            names,
            vec![
                ("src", false),
                ("target", true),
                (".gitignore", false),
                ("debug.log", true),
                ("keep.log", false),
                ("README.md", false)
            ]
        );

        let hidden = list(&root, &opts(&["**/.git"], GitIgnored::Hide)).unwrap();
        assert!(!hidden.entries.iter().any(|e| e.name == "target" || e.name == "debug.log"));
        assert!(hidden.entries.iter().any(|e| e.name == "node_modules"));
    }

    #[test]
    fn nested_gitignore_and_natural_sort() {
        let d = tree();
        let roots = vec![normalize_dir(d.path()).unwrap()];
        let src = resolve(&roots, 0, "src").unwrap();
        let l = list(&src, &opts(&[], GitIgnored::Dim)).unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["gen", ".gitignore", "file2.rs", "file10.rs", "main.rs"]);
        assert!(l.entries[0].ignored, "src/gen ignored by src/.gitignore");
        let gen = list(&resolve(&roots, 0, "src/gen").unwrap(), &opts(&[], GitIgnored::Dim)).unwrap();
        assert!(gen.ignored && gen.entries[0].ignored, "children of ignored folders inherit");
    }

    #[test]
    fn exclusion_matches_parents() {
        let set = build_globs(&["**/node_modules".into(), "*.tmp".into()]);
        assert!(is_excluded(&set, "node_modules"));
        assert!(is_excluded(&set, "a/node_modules/x/y.js"));
        assert!(is_excluded(&set, "x.tmp"));
        assert!(!is_excluded(&set, "a/x.tmp"), "* does not cross folders");
        assert!(!is_excluded(&set, "src/main.rs"));
    }

    #[test]
    fn natural_ordering() {
        let mut v = vec!["b10", "B2", "a", "b1"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["a", "b1", "B2", "b10"]);
    }
}
