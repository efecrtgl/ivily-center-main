//! Workspace-scoped path resolution.
//!
//! The UI addresses files as `(root index, relative path)` within the calling window's workspace.
//! A relative path is validated component by component and joined to the root; the result (or,
//! for paths that do not exist yet, its nearest existing ancestor) is canonicalized and must stay
//! inside the root — a symlink or junction cannot be used to escape the workspace.

use crate::error::{AppError, AppResult};
use crate::workspace::paths::{key_is_within, path_key, NormalizedPath};
use std::path::{Path, PathBuf};

const MAX_REL_LEN: usize = 4096;
const MAX_COMPONENT: usize = 255;
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "com¹", "com²",
    "com³", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "lpt¹", "lpt²", "lpt³", "conin$",
    "conout$",
];

/// A resolved location inside a workspace root.
#[derive(Debug, Clone)]
pub struct Target {
    pub root_index: usize,
    pub root: NormalizedPath,
    /// Normalized relative path with `/` separators (`""` = the root itself).
    pub rel: String,
    pub abs: PathBuf,
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::validation("invalid_path", msg)
}

/// Validate one file or folder name (no separators).
pub fn validate_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.chars().count() > MAX_COMPONENT {
        return Err(invalid("names must be 1–255 characters"));
    }
    if name == "." || name == ".." {
        return Err(invalid("'.' and '..' are not valid names"));
    }
    if let Some(c) =
        name.chars().find(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return Err(invalid(format!("names cannot contain '{}'", c.escape_default())));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(invalid("names cannot end with a dot or a space"));
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(invalid(format!("'{name}' is a reserved device name on Windows")));
    }
    Ok(())
}

/// Split and validate a relative path. `""` and `"."` mean the root.
pub fn normalize_rel(rel: &str) -> AppResult<Vec<String>> {
    if rel.len() > MAX_REL_LEN {
        return Err(invalid("path is too long"));
    }
    let trimmed = rel.trim_matches(|c| c == '/' || c == '\\');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(Vec::new());
    }
    if rel.starts_with('/') || rel.starts_with('\\') || rel.contains(':') {
        return Err(invalid("paths must be relative to a workspace folder"));
    }
    trimmed
        .split(['/', '\\'])
        .map(|c| {
            validate_name(c)?;
            Ok(c.to_string())
        })
        .collect()
}

pub fn join_rel(parts: &[String]) -> String {
    parts.join("/")
}

/// Canonicalize `p`, or its nearest existing ancestor, and check it is inside `root`.
fn check_containment(root: &NormalizedPath, p: &Path) -> AppResult<()> {
    let mut probe = p.to_path_buf();
    loop {
        match dunce::canonicalize(&probe) {
            Ok(c) => {
                if key_is_within(&path_key(&c), &root.key) {
                    return Ok(());
                }
                return Err(AppError::PermissionDenied(format!("{} is outside the workspace folder", p.display())));
            }
            Err(_) => {
                if !probe.pop() {
                    return Err(invalid("path cannot be resolved"));
                }
            }
        }
    }
}

/// Resolve `(root_index, rel)` against the workspace roots.
pub fn resolve(roots: &[NormalizedPath], root_index: usize, rel: &str) -> AppResult<Target> {
    let root =
        roots.get(root_index).ok_or_else(|| AppError::validation("invalid_root", "unknown workspace folder"))?.clone();
    let parts = normalize_rel(rel)?;
    let mut abs = root.path.clone();
    for p in &parts {
        abs.push(p);
    }
    check_containment(&root, &abs)?;
    Ok(Target { root_index, root, rel: join_rel(&parts), abs })
}

impl Target {
    /// A child of this (directory) target.
    pub fn child(&self, name: &str) -> AppResult<Target> {
        validate_name(name)?;
        let rel = if self.rel.is_empty() { name.to_string() } else { format!("{}/{name}", self.rel) };
        let abs = self.abs.join(name);
        check_containment(&self.root, &abs)?;
        Ok(Target { root_index: self.root_index, root: self.root.clone(), rel, abs })
    }

    pub fn parent(&self) -> Option<Target> {
        if self.rel.is_empty() {
            return None;
        }
        let rel = self.rel.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
        Some(Target {
            root_index: self.root_index,
            root: self.root.clone(),
            rel,
            abs: self.abs.parent()?.to_path_buf(),
        })
    }

    pub fn name(&self) -> String {
        self.abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    pub fn is_root(&self) -> bool {
        self.rel.is_empty()
    }
}

/// Convert an absolute path below a root into a relative `/` path (watcher events).
pub fn rel_of(root: &Path, abs: &Path) -> Option<String> {
    let r = abs.strip_prefix(root).ok()?;
    Some(r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::paths::normalize_dir;

    #[test]
    fn rejects_traversal_and_windows_pitfalls() {
        for bad in [
            "..",
            "../x",
            "a/../../x",
            "a/./b",
            r"C:\Windows",
            "/etc/passwd",
            r"\\server\share",
            "file.txt:stream",
            "CON",
            "nul.txt",
            "a/COM1/b",
            "lpt9.log",
            "trailing.",
            "space ",
            "a/b?",
            "a\u{0}b",
            "x|y",
        ] {
            assert!(normalize_rel(bad).is_err(), "{bad:?} must be rejected");
        }
        assert_eq!(normalize_rel("").unwrap(), Vec::<String>::new());
        assert_eq!(normalize_rel("src/main.rs").unwrap(), vec!["src", "main.rs"]);
        assert_eq!(normalize_rel(r"src\lib").unwrap(), vec!["src", "lib"]);
        assert!(normalize_rel("console.log.js").is_ok(), "reserved names only match the whole stem");
        assert!(normalize_rel(".gitignore").is_ok());
    }

    #[test]
    fn resolves_inside_roots_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        let roots = vec![normalize_dir(dir.path()).unwrap()];
        let t = resolve(&roots, 0, "src/new.rs").unwrap();
        assert_eq!(t.rel, "src/new.rs");
        assert!(t.abs.starts_with(&roots[0].path));
        assert!(resolve(&roots, 1, "x").is_err());
        assert_eq!(t.parent().unwrap().rel, "src");
        assert_eq!(t.parent().unwrap().parent().unwrap().rel, "");
        assert!(resolve(&roots, 0, "").unwrap().is_root());
    }

    #[cfg(windows)]
    #[test]
    fn junctions_cannot_escape_the_root() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        let ws = tempfile::tempdir().unwrap();
        let link = ws.path().join("escape");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return; // junction creation unavailable in this environment
        }
        let roots = vec![normalize_dir(ws.path()).unwrap()];
        assert!(matches!(resolve(&roots, 0, "escape/secret.txt"), Err(AppError::PermissionDenied(_))));
        assert!(matches!(resolve(&roots, 0, "escape/new.txt"), Err(AppError::PermissionDenied(_))));
    }
}
