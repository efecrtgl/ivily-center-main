//! File operations. None of them overwrite an existing file or folder: conflicts are errors or are
//! resolved by choosing a unique name (when the caller asks for it). Deletion goes to the Recycle
//! Bin; permanent deletion is a separate operation the UI only offers behind a confirmation.

use super::scope::{validate_name, Target};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

fn exists_err(t: &Target) -> AppError {
    AppError::Conflict(format!("'{}' already exists", t.rel))
}

pub fn create_file(t: &Target) -> AppResult<()> {
    if t.is_root() {
        return Err(AppError::validation("invalid_path", "missing file name"));
    }
    std::fs::OpenOptions::new().write(true).create_new(true).open(&t.abs).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            exists_err(t)
        } else {
            e.into()
        }
    })?;
    Ok(())
}

pub fn create_dir(t: &Target) -> AppResult<()> {
    if t.abs.exists() {
        return Err(exists_err(t));
    }
    std::fs::create_dir(&t.abs)?;
    Ok(())
}

/// Rename within the same folder. A case-only rename (`readme.md` → `README.md`) is allowed.
pub fn rename(t: &Target, new_name: &str) -> AppResult<Target> {
    validate_name(new_name)?;
    let parent =
        t.parent().ok_or_else(|| AppError::validation("invalid_path", "a workspace folder cannot be renamed here"))?;
    let dest = parent.child(new_name)?;
    let case_only = dest.abs != t.abs && dest.rel.eq_ignore_ascii_case(&t.rel);
    if dest.abs.exists() && !case_only {
        return Err(exists_err(&dest));
    }
    if !t.abs.exists() && std::fs::symlink_metadata(&t.abs).is_err() {
        return Err(AppError::NotFound(t.rel.clone()));
    }
    std::fs::rename(&t.abs, &dest.abs)?;
    Ok(dest)
}

/// `name.ext` → `name copy.ext`, `name copy 2.ext`, … (first that does not exist in `dir`).
pub fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem} copy {}{ext}", crate::core::now_ms())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OnConflict {
    Fail,
    /// Pick `name copy`, `name copy 2`, …
    Rename,
}

fn copy_recursive(src: &Path, dst: &Path, depth: usize) -> AppResult<()> {
    if depth > 128 {
        return Err(AppError::validation("too_deep", "folder nesting is too deep to copy"));
    }
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::Unsupported(format!("{} is a link; links are not copied", src.display())));
    }
    if meta.is_dir() {
        std::fs::create_dir(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()), depth + 1)?;
        }
    } else {
        if dst.exists() {
            return Err(AppError::Conflict(format!("{} already exists", dst.display())));
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

fn destination(src: &Target, dest_dir: &Target, policy: OnConflict) -> AppResult<Target> {
    if !dest_dir.abs.is_dir() {
        return Err(AppError::validation("not_a_directory", "the destination is not a folder"));
    }
    let name = src.name();
    let name = match policy {
        OnConflict::Fail => name,
        OnConflict::Rename => unique_name(&dest_dir.abs, &name),
    };
    let dest = dest_dir.child(&name)?;
    if dest.abs.exists() {
        return Err(exists_err(&dest));
    }
    // Copying or moving a folder into itself would recurse forever / is impossible.
    let s = crate::workspace::paths::path_key(&src.abs);
    let d = crate::workspace::paths::path_key(&dest.abs);
    if crate::workspace::paths::key_is_within(&d, &s) {
        return Err(AppError::validation("into_itself", "a folder cannot be copied or moved into itself"));
    }
    Ok(dest)
}

pub fn copy(src: &Target, dest_dir: &Target, policy: OnConflict) -> AppResult<Target> {
    if src.is_root() {
        return Err(AppError::validation("invalid_path", "a workspace folder cannot be copied"));
    }
    let dest = destination(src, dest_dir, policy)?;
    if let Err(e) = copy_recursive(&src.abs, &dest.abs, 0) {
        // Do not leave a half-copied folder behind (it was created by us, so it is safe to remove).
        if dest.abs.is_dir() {
            let _ = std::fs::remove_dir_all(&dest.abs);
        }
        return Err(e);
    }
    Ok(dest)
}

pub fn move_to(src: &Target, dest_dir: &Target) -> AppResult<Target> {
    if src.is_root() {
        return Err(AppError::validation("invalid_path", "a workspace folder cannot be moved"));
    }
    let dest = destination(src, dest_dir, OnConflict::Fail)?;
    match std::fs::rename(&src.abs, &dest.abs) {
        Ok(()) => Ok(dest),
        Err(_) => {
            // Different volume: copy, then remove the source only after the copy succeeded.
            copy_recursive(&src.abs, &dest.abs, 0).inspect_err(|_| {
                if dest.abs.is_dir() {
                    let _ = std::fs::remove_dir_all(&dest.abs);
                }
            })?;
            if src.abs.is_dir() {
                std::fs::remove_dir_all(&src.abs)?;
            } else {
                std::fs::remove_file(&src.abs)?;
            }
            Ok(dest)
        }
    }
}

pub fn duplicate(src: &Target) -> AppResult<Target> {
    let parent =
        src.parent().ok_or_else(|| AppError::validation("invalid_path", "a workspace folder cannot be duplicated"))?;
    copy(src, &parent, OnConflict::Rename)
}

/// Move to the Recycle Bin.
pub fn trash(targets: &[Target]) -> AppResult<()> {
    let paths: Vec<PathBuf> = targets
        .iter()
        .map(|t| {
            if t.is_root() {
                Err(AppError::validation("invalid_path", "a workspace folder cannot be deleted here"))
            } else {
                Ok(t.abs.clone())
            }
        })
        .collect::<AppResult<_>>()?;
    trash::delete_all(&paths).map_err(|e| AppError::Io(format!("could not move to the Recycle Bin: {e}")))
}

/// Permanent deletion (UI requires explicit confirmation). Links are removed, not followed.
pub fn delete_permanently(targets: &[Target]) -> AppResult<()> {
    for t in targets {
        if t.is_root() {
            return Err(AppError::validation("invalid_path", "a workspace folder cannot be deleted here"));
        }
        let meta = std::fs::symlink_metadata(&t.abs)?;
        if meta.file_type().is_symlink() {
            if std::fs::remove_file(&t.abs).is_err() {
                std::fs::remove_dir(&t.abs)?;
            }
        } else if meta.is_dir() {
            std::fs::remove_dir_all(&t.abs)?;
        } else {
            std::fs::remove_file(&t.abs)?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Properties {
    pub name: String,
    pub path: String,
    pub kind: super::list::EntryKind,
    pub size: u64,
    pub created: i64,
    pub modified: i64,
    pub readonly: bool,
    pub hidden: bool,
    /// Direct children (folders only).
    pub items: Option<usize>,
}

pub fn properties(t: &Target) -> AppResult<Properties> {
    let meta = std::fs::symlink_metadata(&t.abs)?;
    let ms = |r: std::io::Result<std::time::SystemTime>| {
        r.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
    };
    let kind = if meta.file_type().is_symlink() {
        super::list::EntryKind::Link
    } else if meta.is_dir() {
        super::list::EntryKind::Dir
    } else {
        super::list::EntryKind::File
    };
    #[cfg(windows)]
    let hidden = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x2 != 0
    };
    #[cfg(not(windows))]
    let hidden = t.name().starts_with('.');
    Ok(Properties {
        name: t.name(),
        path: t.abs.display().to_string(),
        kind,
        size: meta.len(),
        created: ms(meta.created()),
        modified: ms(meta.modified()),
        readonly: meta.permissions().readonly(),
        hidden,
        items: if kind == super::list::EntryKind::Dir {
            std::fs::read_dir(&t.abs).ok().map(|r| r.count())
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::scope::resolve;
    use crate::workspace::paths::normalize_dir;

    fn setup() -> (tempfile::TempDir, Vec<crate::workspace::paths::NormalizedPath>) {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/a.rs"), "fn a() {}").unwrap();
        let roots = vec![normalize_dir(d.path()).unwrap()];
        (d, roots)
    }

    #[test]
    fn create_never_overwrites() {
        let (_d, roots) = setup();
        let t = resolve(&roots, 0, "src/a.rs").unwrap();
        assert!(matches!(create_file(&t), Err(AppError::Conflict(_))));
        assert_eq!(std::fs::read_to_string(&t.abs).unwrap(), "fn a() {}");
        create_file(&resolve(&roots, 0, "src/b.rs").unwrap()).unwrap();
        create_dir(&resolve(&roots, 0, "src/mod").unwrap()).unwrap();
        assert!(create_dir(&resolve(&roots, 0, "src/mod").unwrap()).is_err());
    }

    #[test]
    fn rename_rules() {
        let (_d, roots) = setup();
        let a = resolve(&roots, 0, "src/a.rs").unwrap();
        std::fs::write(roots[0].path.join("src/b.rs"), "b").unwrap();
        assert!(matches!(rename(&a, "b.rs"), Err(AppError::Conflict(_))));
        assert!(rename(&a, "../x.rs").is_err());
        assert!(rename(&a, "CON").is_err());
        let r = rename(&a, "A.rs").unwrap();
        assert_eq!(r.rel, "src/A.rs");
        assert!(rename(&resolve(&roots, 0, "").unwrap(), "x").is_err());
    }

    #[test]
    fn copy_move_duplicate() {
        let (_d, roots) = setup();
        let src = resolve(&roots, 0, "src").unwrap();
        let root = resolve(&roots, 0, "").unwrap();
        let a = resolve(&roots, 0, "src/a.rs").unwrap();
        assert_eq!(duplicate(&a).unwrap().rel, "src/a copy.rs");
        assert_eq!(duplicate(&a).unwrap().rel, "src/a copy 2.rs");
        assert!(matches!(copy(&a, &src, OnConflict::Fail), Err(AppError::Conflict(_))));
        assert!(copy(&src, &src, OnConflict::Rename).is_err(), "folder into itself");
        let copied = copy(&src, &root, OnConflict::Rename).unwrap();
        assert_eq!(copied.rel, "src copy");
        assert!(roots[0].path.join("src copy/a copy 2.rs").exists());
        std::fs::create_dir(roots[0].path.join("dest")).unwrap();
        let moved = move_to(&a, &resolve(&roots, 0, "dest").unwrap()).unwrap();
        assert_eq!(moved.rel, "dest/a.rs");
        assert!(!a.abs.exists());
        assert!(move_to(&resolve(&roots, 0, "dest").unwrap(), &resolve(&roots, 0, "dest").unwrap()).is_err());
    }

    #[test]
    fn permanent_delete_and_root_protection() {
        let (_d, roots) = setup();
        let root = resolve(&roots, 0, "").unwrap();
        assert!(trash(std::slice::from_ref(&root)).is_err());
        assert!(delete_permanently(std::slice::from_ref(&root)).is_err());
        let src = resolve(&roots, 0, "src").unwrap();
        delete_permanently(std::slice::from_ref(&src)).unwrap();
        assert!(!src.abs.exists());
        assert!(roots[0].path.exists());
    }

    #[test]
    fn properties_of_folder() {
        let (_d, roots) = setup();
        let p = properties(&resolve(&roots, 0, "src").unwrap()).unwrap();
        assert_eq!(p.items, Some(1));
        assert_eq!(p.kind, crate::fs::list::EntryKind::Dir);
    }
}
