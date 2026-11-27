//! Opaque tokens for paths chosen by the user in native dialogs.
//!
//! The webview never supplies filesystem paths. When a dialog result has to round-trip through
//! the UI (e.g. "this file exists — overwrite?", or a discovered project the user may click),
//! Rust keeps the path and gives the UI a token. A token is single-purpose (its kind is checked)
//! and the table is bounded.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    /// A project folder found by discovery inside a folder the user picked.
    Discovered,
    /// A workspace-file target the user picked that already exists (overwrite needs confirmation).
    SaveTarget,
    /// A file outside the workspace that the user opened in the editor via a dialog.
    ExternalDoc,
    /// An extension folder the user picked for installation (preview before confirmation).
    ExtensionSource,
}

const MAX_GRANTS: usize = 1000;

/// (counter, token → (kind, path))
type Table = (u64, HashMap<String, (GrantKind, PathBuf)>);

#[derive(Default)]
pub struct PathGrants {
    inner: Mutex<Table>,
}

impl PathGrants {
    pub fn insert(&self, kind: GrantKind, path: PathBuf) -> String {
        let mut g = self.inner.lock();
        if g.1.len() >= MAX_GRANTS {
            g.1.clear();
        }
        g.0 += 1;
        let token = format!("g{}_{:x}", g.0, crate::core::now_ms());
        g.1.insert(token.clone(), (kind, path));
        token
    }

    /// Look up a token of the expected kind (kept for reuse, e.g. clicking several discovered projects).
    pub fn get(&self, token: &str, kind: GrantKind) -> Option<PathBuf> {
        self.inner.lock().1.get(token).filter(|(k, _)| *k == kind).map(|(_, p)| p.clone())
    }

    /// Consume a token of the expected kind.
    pub fn take(&self, token: &str, kind: GrantKind) -> Option<PathBuf> {
        let mut g = self.inner.lock();
        match g.1.get(token) {
            Some((k, _)) if *k == kind => g.1.remove(token).map(|(_, p)| p),
            _ => None,
        }
    }

    /// Drop all tokens of a kind (e.g. a new discovery replaces the previous results).
    pub fn clear_kind(&self, kind: GrantKind) {
        self.inner.lock().1.retain(|_, (k, _)| *k != kind);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_kind_checked_and_single_use_on_take() {
        let g = PathGrants::default();
        let t = g.insert(GrantKind::SaveTarget, PathBuf::from(r"C:\x.ivily-workspace"));
        assert_eq!(g.get(&t, GrantKind::Discovered), None);
        assert_eq!(g.take(&t, GrantKind::Discovered), None);
        assert!(g.take(&t, GrantKind::SaveTarget).is_some());
        assert_eq!(g.take(&t, GrantKind::SaveTarget), None);
        assert_eq!(g.get("made-up", GrantKind::SaveTarget), None);
        let d = g.insert(GrantKind::Discovered, PathBuf::from(r"C:\p"));
        assert!(g.get(&d, GrantKind::Discovered).is_some());
        g.clear_kind(GrantKind::Discovered);
        assert!(g.get(&d, GrantKind::Discovered).is_none());
    }
}
