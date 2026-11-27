//! Path validation and normalization for workspace roots.
//!
//! Windows paths are case-insensitive and may be spelled many ways (`c:/Code/App/`,
//! `C:\code\app`, `\\?\C:\code\app`). Every workspace and trust record is keyed by a *path key*:
//! the canonical path (symlinks/junctions resolved, verbatim prefix removed), with backslashes,
//! no trailing separator and lower-cased. Two spellings of one folder therefore map to one record.

use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

pub const WORKSPACE_FILE_EXT: &str = "ivily-workspace";
const MAX_PATH_CHARS: usize = 4096;

/// A validated, canonical path plus its comparison key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedPath {
    pub path: PathBuf,
    pub key: String,
}

impl NormalizedPath {
    pub fn display(&self) -> String {
        self.path.display().to_string()
    }
}

/// Comparison key for an (already canonical) path.
pub fn path_key(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('/', "\\");
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// True if `child` equals `parent` or lies below it (both are path keys).
pub fn key_is_within(child: &str, parent: &str) -> bool {
    if child == parent {
        return true;
    }
    let prefix =
        if parent.ends_with('\\') || parent.ends_with('/') { parent.to_string() } else { format!("{parent}\\") };
    let prefix_unix = prefix.replace('\\', "/");
    child.starts_with(&prefix) || child.starts_with(&prefix_unix)
}

/// `C:\` or `\\server\share` — trusting such a root "including children" is refused.
pub fn is_volume_root(p: &Path) -> bool {
    p.parent().is_none()
}

fn check_input(p: &Path) -> AppResult<()> {
    let s = p.to_string_lossy();
    if s.is_empty() || s.chars().count() > MAX_PATH_CHARS || s.chars().any(|c| c == '\0') {
        return Err(AppError::validation("invalid_path", "the path is empty, too long or malformed"));
    }
    if !p.is_absolute() {
        return Err(AppError::validation("invalid_path", "the path must be absolute"));
    }
    // Device namespace paths (\\.\PhysicalDrive0, \\.\pipe\...) are never workspaces.
    if s.starts_with(r"\\.\") {
        return Err(AppError::validation("invalid_path", "device paths cannot be opened"));
    }
    Ok(())
}

fn canonical(p: &Path) -> AppResult<PathBuf> {
    dunce::canonicalize(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(format!("{} does not exist", p.display())),
        std::io::ErrorKind::PermissionDenied => {
            AppError::PermissionDenied(format!("{} is not accessible", p.display()))
        }
        _ => AppError::Io(format!("{}: {e}", p.display())),
    })
}

/// Validate an existing, readable directory.
pub fn normalize_dir(p: &Path) -> AppResult<NormalizedPath> {
    check_input(p)?;
    let canon = canonical(p)?;
    let meta = std::fs::metadata(&canon)?;
    if !meta.is_dir() {
        return Err(AppError::validation("not_a_directory", format!("{} is not a folder", canon.display())));
    }
    std::fs::read_dir(&canon)
        .map_err(|e| AppError::PermissionDenied(format!("{} cannot be read: {e}", canon.display())))?;
    Ok(NormalizedPath { key: path_key(&canon), path: canon })
}

/// Validate an existing `*.ivily-workspace` file.
pub fn normalize_workspace_file(p: &Path) -> AppResult<NormalizedPath> {
    check_input(p)?;
    let canon = canonical(p)?;
    if !std::fs::metadata(&canon)?.is_file() {
        return Err(AppError::validation("not_a_file", format!("{} is not a file", canon.display())));
    }
    if !has_workspace_ext(&canon) {
        return Err(AppError::validation(
            "not_a_workspace_file",
            format!("{} is not a .{WORKSPACE_FILE_EXT} file", canon.display()),
        ));
    }
    Ok(NormalizedPath { key: path_key(&canon), path: canon })
}

/// Validate a target for a new workspace file: absolute, `.ivily-workspace`, parent folder exists.
pub fn normalize_new_workspace_file(p: &Path) -> AppResult<NormalizedPath> {
    check_input(p)?;
    let p = if has_workspace_ext(p) { p.to_path_buf() } else { p.with_extension(WORKSPACE_FILE_EXT) };
    let parent = p.parent().ok_or_else(|| AppError::validation("invalid_path", "the file needs a parent folder"))?;
    let name = p.file_name().ok_or_else(|| AppError::validation("invalid_path", "missing file name"))?;
    let parent = normalize_dir(parent)?;
    let path = parent.path.join(name);
    Ok(NormalizedPath { key: path_key(&path), path })
}

pub fn has_workspace_ext(p: &Path) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case(WORKSPACE_FILE_EXT)).unwrap_or(false)
}

/// Display name for a folder (`C:\code\shop` → `shop`, `D:\` → `D:`).
pub fn folder_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().trim_end_matches(['\\', '/']).to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Available,
    Missing,
    Inaccessible,
    /// The check did not finish in time (e.g. an unreachable network share).
    Unreachable,
}

/// Check that a path still exists and is accessible, without blocking longer than `timeout`
/// (metadata calls on disconnected network drives can hang for a long time).
pub fn check_availability(path: PathBuf, expect_dir: bool, timeout: Duration) -> Availability {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let r = match std::fs::metadata(&path) {
            Ok(m) if m.is_dir() != expect_dir => Availability::Missing,
            Ok(m) if m.is_dir() => match std::fs::read_dir(&path) {
                Ok(_) => Availability::Available,
                Err(_) => Availability::Inaccessible,
            },
            Ok(_) => Availability::Available,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Availability::Missing,
            Err(_) => Availability::Inaccessible,
        };
        let _ = tx.send(r);
    });
    rx.recv_timeout(timeout).unwrap_or(Availability::Unreachable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_ignore_case_separators_and_trailing_slashes() {
        if cfg!(windows) {
            assert_eq!(path_key(Path::new(r"C:\Code\App\")), r"c:\code\app");
            assert_eq!(path_key(Path::new("C:/Code/App")), r"c:\code\app");
            assert_eq!(path_key(Path::new(r"C:\")), r"c:\");
        }
    }

    #[test]
    fn containment_is_component_based() {
        assert!(key_is_within(r"c:\code\app", r"c:\code"));
        assert!(key_is_within(r"c:\code", r"c:\code"));
        assert!(key_is_within(r"c:\code\app", r"c:\"));
        assert!(!key_is_within(r"c:\codebase", r"c:\code"), "sibling with common prefix is not inside");
        assert!(!key_is_within(r"c:\code", r"c:\code\app"));
    }

    #[test]
    fn validates_directories() {
        let dir = tempfile::tempdir().unwrap();
        let n = normalize_dir(dir.path()).unwrap();
        assert!(n.path.is_absolute());
        assert!(!n.path.to_string_lossy().starts_with(r"\\?\"), "verbatim prefix must be removed");
        // Different spelling, same key.
        let alt = PathBuf::from(dir.path().to_string_lossy().to_uppercase() + "\\");
        if cfg!(windows) {
            assert_eq!(normalize_dir(&alt).unwrap().key, n.key);
        }
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(matches!(normalize_dir(&file), Err(AppError::Validation { code: "not_a_directory", .. })));
        assert!(matches!(normalize_dir(&dir.path().join("missing")), Err(AppError::NotFound(_))));
        assert!(normalize_dir(Path::new("relative\\path")).is_err());
        assert!(normalize_dir(Path::new(r"\\.\PhysicalDrive0")).is_err());
    }

    #[test]
    fn validates_workspace_files() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("app.ivily-workspace");
        std::fs::write(&f, "{}").unwrap();
        assert!(normalize_workspace_file(&f).is_ok());
        let other = dir.path().join("app.json");
        std::fs::write(&other, "{}").unwrap();
        assert!(normalize_workspace_file(&other).is_err());
        let new = normalize_new_workspace_file(&dir.path().join("new")).unwrap();
        assert!(has_workspace_ext(&new.path));
        assert!(normalize_new_workspace_file(&dir.path().join("nope").join("x.ivily-workspace")).is_err());
    }

    #[test]
    fn availability() {
        let dir = tempfile::tempdir().unwrap();
        let t = Duration::from_secs(2);
        assert_eq!(check_availability(dir.path().to_path_buf(), true, t), Availability::Available);
        assert_eq!(check_availability(dir.path().join("gone"), true, t), Availability::Missing);
    }

    #[test]
    fn names() {
        assert_eq!(folder_name(Path::new(r"C:\code\shop")), "shop");
    }
}
