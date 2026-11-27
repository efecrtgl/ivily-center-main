//! Parsers for git's machine-readable output formats.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Original path for renames/copies.
    pub orig: Option<String>,
    /// Index (staged) status letter: `.` unchanged, `M`, `A`, `D`, `R`, `C`, `T`.
    pub index: char,
    /// Working-tree status letter.
    pub worktree: char,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
    /// `merge`, `rebase`, `cherry-pick`, `revert` in progress.
    pub operation: Option<&'static str>,
}

/// Parse `git status --porcelain=v2 -z --branch`.
pub fn parse_status(out: &str) -> Status {
    let mut st = Status::default();
    let mut parts = out.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(rec) = parts.next() {
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.head ") {
                if v == "(detached)" {
                    st.detached = true;
                } else {
                    st.branch = Some(v.to_string());
                }
            } else if let Some(v) = h.strip_prefix("branch.oid ") {
                st.head = (v != "(initial)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for t in v.split_whitespace() {
                    if let Some(n) = t.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = t.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() == 9 {
                    let xy: Vec<char> = f[1].chars().collect();
                    st.files.push(FileStatus {
                        path: f[8].into(),
                        orig: None,
                        index: xy[0],
                        worktree: xy[1],
                        untracked: false,
                        conflicted: false,
                    });
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                if f.len() == 10 {
                    let xy: Vec<char> = f[1].chars().collect();
                    let orig = parts.next().map(String::from);
                    st.files.push(FileStatus {
                        path: f[9].into(),
                        orig,
                        index: xy[0],
                        worktree: xy[1],
                        untracked: false,
                        conflicted: false,
                    });
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() == 11 {
                    let xy: Vec<char> = f[1].chars().collect();
                    st.files.push(FileStatus {
                        path: f[10].into(),
                        orig: None,
                        index: xy[0],
                        worktree: xy[1],
                        untracked: false,
                        conflicted: true,
                    });
                }
            }
            b'?' => {
                st.files.push(FileStatus {
                    path: rec[2..].into(),
                    orig: None,
                    index: '.',
                    worktree: '?',
                    untracked: true,
                    conflicted: false,
                });
            }
            _ => {}
        }
    }
    st
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub upstream: Option<String>,
    pub current: bool,
    pub commit: String,
    pub date: i64,
    /// e.g. `[ahead 1, behind 2]` or `[gone]`.
    pub track: String,
}

pub fn parse_branches(out: &str) -> Vec<Branch> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() < 7 {
                return None;
            }
            let remote = f[0].starts_with("refs/remotes/");
            if remote && f[0].ends_with("/HEAD") {
                return None;
            }
            Some(Branch {
                name: f[1].into(),
                remote,
                upstream: (!f[2].is_empty()).then(|| f[2].into()),
                current: f[3] == "*",
                commit: f[4].into(),
                date: f[5].parse().unwrap_or(0),
                track: f[6].into(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub refs: String,
    pub subject: String,
}

pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\u{1e}')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = rec.split('\0').collect();
            if f.len() < 8 || f[0].is_empty() {
                return None;
            }
            Some(Commit {
                sha: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                email: f[3].into(),
                time: f[4].parse().unwrap_or(0),
                parents: f[5].split_whitespace().map(String::from).collect(),
                refs: f[6].into(),
                subject: f[7].into(),
            })
        })
        .collect()
}

/// `diff-tree -z --name-status` → `(status, path, orig)`.
pub fn parse_name_status(out: &str) -> Vec<(String, String, Option<String>)> {
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    let mut res = Vec::new();
    while let Some(status) = parts.next() {
        let letter = status.chars().next().unwrap_or('M').to_string();
        if letter == "R" || letter == "C" {
            let (Some(from), Some(to)) = (parts.next(), parts.next()) else { break };
            res.push((letter, to.to_string(), Some(from.to_string())));
        } else if let Some(p) = parts.next() {
            res.push((letter, p.to_string(), None));
        }
    }
    res
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub name: String,
    pub message: String,
    pub time: i64,
}

pub fn parse_stashes(out: &str) -> Vec<Stash> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            (f.len() >= 3 && !f[0].is_empty()).then(|| Stash {
                name: f[0].into(),
                message: f[1].into(),
                time: f[2].parse().unwrap_or(0),
            })
        })
        .collect()
}
