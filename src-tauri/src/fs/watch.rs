//! File watching for the open workspace of each window.
//!
//! One recursive OS watcher per workspace root (ReadDirectoryChangesW on Windows). Raw events are
//! batched for 150 ms, mapped to `(root, relative path)`, de-duplicated and delivered to a sink.
//! Changes inside `.git` are reduced to a single `git` flag (used by the Git view later), and very
//! large bursts (e.g. `npm install`) collapse into a `rescan` hint instead of thousands of paths.

use super::scope::rel_of;
use crate::workspace::paths::NormalizedPath;
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

const BATCH: Duration = Duration::from_millis(150);
const MAX_PATHS: usize = 500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub root: usize,
    /// Changed paths relative to the root (created, modified, removed or renamed).
    pub paths: Vec<String>,
    /// Too many changes to list: reload what is visible.
    pub rescan: bool,
    /// Something inside `.git` changed (branch, index, refs).
    pub git: bool,
}

pub type Sink = Arc<dyn Fn(FsChange) + Send + Sync>;

/// Keeps the OS watchers alive; dropping it stops watching.
pub struct WatchHandle {
    _watchers: Vec<notify::RecommendedWatcher>,
}

fn classify(root: &NormalizedPath, path: &std::path::Path) -> Option<(String, bool)> {
    let rel = rel_of(&root.path, path)?;
    if rel == ".git" || rel.starts_with(".git/") {
        return Some((String::new(), true));
    }
    Some((rel, false))
}

/// Start watching `roots`. Errors for individual roots are reported through `on_error`.
pub fn watch(roots: Vec<NormalizedPath>, sink: Sink, on_error: impl Fn(String) + Send + 'static) -> WatchHandle {
    let (tx, rx) = mpsc::channel::<(usize, PathBuf)>();
    let mut watchers = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        let tx = tx.clone();
        let res = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for p in ev.paths {
                    let _ = tx.send((i, p));
                }
            }
        });
        match res {
            Ok(mut w) => match w.watch(&root.path, RecursiveMode::Recursive) {
                Ok(()) => watchers.push(w),
                Err(e) => on_error(format!("cannot watch {}: {e}", root.display())),
            },
            Err(e) => on_error(format!("cannot create a file watcher: {e}")),
        }
    }
    drop(tx);
    std::thread::Builder::new().name("ivily-fs-watch".into()).spawn(move || batch_loop(rx, roots, sink)).ok();
    WatchHandle { _watchers: watchers }
}

fn batch_loop(rx: mpsc::Receiver<(usize, PathBuf)>, roots: Vec<NormalizedPath>, sink: Sink) {
    // Ends when every watcher (and so every sender) has been dropped.
    while let Ok(first) = rx.recv() {
        let deadline = Instant::now() + BATCH;
        let mut pending = vec![first];
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(ev) => pending.push(ev),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        for change in group(&roots, pending) {
            sink(change);
        }
    }
}

/// Group raw events into one `FsChange` per root.
pub fn group(roots: &[NormalizedPath], events: Vec<(usize, PathBuf)>) -> Vec<FsChange> {
    let mut per_root: Vec<(BTreeSet<String>, bool)> = vec![(BTreeSet::new(), false); roots.len()];
    for (i, p) in events {
        let Some(root) = roots.get(i) else { continue };
        if let Some((rel, git)) = classify(root, &p) {
            if git {
                per_root[i].1 = true;
            } else {
                per_root[i].0.insert(rel);
            }
        }
    }
    per_root
        .into_iter()
        .enumerate()
        .filter(|(_, (paths, git))| !paths.is_empty() || *git)
        .map(|(root, (paths, git))| {
            let rescan = paths.len() > MAX_PATHS;
            FsChange { root, paths: if rescan { Vec::new() } else { paths.into_iter().collect() }, rescan, git }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::paths::normalize_dir;
    use parking_lot::Mutex;

    #[test]
    fn groups_events_per_root() {
        let d = tempfile::tempdir().unwrap();
        let roots = vec![normalize_dir(d.path()).unwrap()];
        let r = &roots[0].path;
        let changes = group(
            &roots,
            vec![(0, r.join("src/a.rs")), (0, r.join("src/a.rs")), (0, r.join(".git/index")), (0, r.join("b"))],
        );
        assert_eq!(
            changes,
            vec![FsChange { root: 0, paths: vec!["b".into(), "src/a.rs".into()], rescan: false, git: true }]
        );
        let many: Vec<_> = (0..MAX_PATHS + 1).map(|n| (0, r.join(format!("f{n}")))).collect();
        assert!(group(&roots, many)[0].rescan);
    }

    #[test]
    fn delivers_real_changes() {
        let d = tempfile::tempdir().unwrap();
        let roots = vec![normalize_dir(d.path()).unwrap()];
        let got = Arc::new(Mutex::new(Vec::<FsChange>::new()));
        let g = got.clone();
        let handle = watch(roots.clone(), Arc::new(move |c| g.lock().push(c)), |_| {});
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(roots[0].path.join("new.txt"), "x").unwrap();
        let start = Instant::now();
        while got.lock().is_empty() && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(handle);
        let all = got.lock().clone();
        assert!(all.iter().any(|c| c.paths.iter().any(|p| p == "new.txt")), "{all:?}");
    }
}
