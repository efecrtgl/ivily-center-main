//! Portable workspace files (`*.ivily-workspace`).
//!
//! Format (version 1, JSON):
//!
//! ```json
//! {
//!   "ivilyWorkspace": 1,
//!   "name": "Shop",
//!   "folders": [ { "path": "." }, { "path": "../shared-lib", "name": "Shared" } ],
//!   "settings": { "appearance.theme": "pixel-dark" }
//! }
//! ```
//!
//! * Folder paths are relative to the file's directory (portable) or absolute.
//! * `settings` holds workspace-scoped settings only; they are validated by the settings registry
//!   when read. Trust is **never** read from a workspace file.
//! * Unknown fields are preserved when Center rewrites the file (forward compatibility).
//! * Files are written only on explicit user action, atomically (temp file + rename), and never
//!   over a file that changed on disk since it was read ([`write_atomic`] compares content hashes).

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

pub const FORMAT_VERSION: u32 = 1;
pub const MAX_FILE_BYTES: usize = 1024 * 1024;
pub const MAX_FOLDERS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FolderEntry {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceFile {
    #[serde(rename = "ivilyWorkspace")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub folders: Vec<FolderEntry>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub settings: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::validation("invalid_workspace_file", msg)
}

/// Parse and validate file contents.
pub fn parse(bytes: &[u8]) -> AppResult<WorkspaceFile> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(invalid("the workspace file is larger than 1 MB"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("the workspace file is not UTF-8 text"))?;
    let text = text.trim_start_matches('\u{feff}');
    let raw: Value = serde_json::from_str(text)
        .map_err(|e| invalid(format!("not valid JSON (line {}, column {})", e.line(), e.column())))?;
    let version = raw.get("ivilyWorkspace").and_then(Value::as_u64);
    match version {
        None => return Err(invalid("missing \"ivilyWorkspace\" version field")),
        Some(v) if v > FORMAT_VERSION as u64 => {
            return Err(AppError::Unsupported(format!(
                "this workspace file uses format {v}; this version of Ivily Center supports format {FORMAT_VERSION}"
            )))
        }
        Some(0) => return Err(invalid("unsupported format version 0")),
        _ => {}
    }
    let file: WorkspaceFile = serde_json::from_value(raw).map_err(|e| invalid(e.to_string()))?;
    if file.folders.is_empty() {
        return Err(invalid("the workspace has no folders"));
    }
    if file.folders.len() > MAX_FOLDERS {
        return Err(invalid(format!("a workspace may have at most {MAX_FOLDERS} folders")));
    }
    for f in &file.folders {
        if f.path.trim().is_empty() || f.path.len() > 1024 || f.path.contains('\0') {
            return Err(invalid("a folder path is empty or malformed"));
        }
        if f.name.as_deref().is_some_and(|n| n.chars().count() > 128) {
            return Err(invalid("a folder name is longer than 128 characters"));
        }
    }
    if file.name.as_deref().is_some_and(|n| n.chars().count() > 128) {
        return Err(invalid("the workspace name is longer than 128 characters"));
    }
    Ok(file)
}

pub fn serialize(file: &WorkspaceFile) -> AppResult<Vec<u8>> {
    let mut s = serde_json::to_string_pretty(file).map_err(|e| AppError::Internal(e.to_string()))?;
    s.push('\n');
    Ok(s.into_bytes())
}

pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Read and parse a workspace file; returns the parsed file and the hash of its bytes.
pub fn read(path: &Path) -> AppResult<(WorkspaceFile, String)> {
    let meta = std::fs::metadata(path)?;
    if meta.len() as usize > MAX_FILE_BYTES {
        return Err(invalid("the workspace file is larger than 1 MB"));
    }
    let bytes = std::fs::read(path)?;
    Ok((parse(&bytes)?, hash(&bytes)))
}

/// Resolve a folder entry against the workspace file's directory.
pub fn resolve_folder(base_dir: &Path, entry: &FolderEntry) -> PathBuf {
    let p = Path::new(entry.path.trim());
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base_dir.join(p)
    }
}

/// Path to store for `folder` in a file located in `base_dir`: relative when the folder is the
/// base directory or below it, absolute otherwise.
pub fn portable_folder_path(base_dir: &Path, folder: &Path) -> String {
    let base_key = super::paths::path_key(base_dir);
    let folder_key = super::paths::path_key(folder);
    if folder_key == base_key {
        return ".".into();
    }
    if super::paths::key_is_within(&folder_key, &base_key) {
        if let Ok(rel) = folder.strip_prefix(base_dir) {
            if rel.components().all(|c| matches!(c, Component::Normal(_))) {
                return rel.to_string_lossy().into_owned();
            }
        }
    }
    folder.to_string_lossy().into_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode<'a> {
    /// The target must not exist.
    CreateNew,
    /// The user confirmed replacing whatever is at the target.
    ReplaceConfirmed,
    /// The target must still have this content hash (the version Center read).
    Update { expected_hash: &'a str },
}

/// Write atomically. Returns the hash of the written bytes.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: WriteMode<'_>) -> AppResult<String> {
    match mode {
        WriteMode::CreateNew if path.exists() => {
            return Err(AppError::Conflict(format!("{} already exists", path.display())));
        }
        WriteMode::Update { expected_hash } => match std::fs::read(path) {
            Ok(current) if hash(&current) == expected_hash => {}
            Ok(_) => return Err(AppError::Conflict(format!("{} was changed outside Ivily Center", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::Conflict(format!("{} was deleted or moved", path.display())))
            }
            Err(e) => return Err(e.into()),
        },
        _ => {}
    }
    let dir = path.parent().ok_or_else(|| AppError::validation("invalid_path", "missing parent folder"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", crate::core::now_ms()));
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(hash(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_and_round_trips_unknown_fields() {
        let src = br#"{ "ivilyWorkspace": 1, "name": "Shop", "folders": [{ "path": ".", "color": "red" }],
                        "settings": { "appearance.theme": "glass" }, "futureField": { "a": 1 } }"#;
        let f = parse(src).unwrap();
        assert_eq!(f.name.as_deref(), Some("Shop"));
        assert_eq!(f.extra["futureField"], json!({ "a": 1 }));
        assert_eq!(f.folders[0].extra["color"], json!("red"));
        let again = parse(&serialize(&f).unwrap()).unwrap();
        assert_eq!(again, f);
    }

    #[test]
    fn rejects_invalid_files() {
        for (src, why) in [
            (&b"not json"[..], "json"),
            (br#"{ "folders": [{ "path": "." }] }"#, "version"),
            (br#"{ "ivilyWorkspace": 1, "folders": [] }"#, "no folders"),
            (br#"{ "ivilyWorkspace": 1, "folders": [{ "path": "" }] }"#, "empty path"),
            (br#"{ "ivilyWorkspace": 1, "folders": "." }"#, "wrong type"),
        ] {
            assert!(parse(src).is_err(), "{why}");
        }
        assert!(matches!(
            parse(br#"{ "ivilyWorkspace": 2, "folders": [{ "path": "." }] }"#),
            Err(AppError::Unsupported(_))
        ));
        assert!(parse(&vec![b' '; MAX_FILE_BYTES + 1]).is_err());
        // UTF-8 BOM is accepted.
        assert!(parse("\u{feff}{ \"ivilyWorkspace\": 1, \"folders\": [{ \"path\": \".\" }] }".as_bytes()).is_ok());
    }

    #[test]
    fn portable_paths() {
        let base = Path::new(r"C:\code\shop");
        assert_eq!(portable_folder_path(base, Path::new(r"C:\code\shop")), ".");
        assert_eq!(portable_folder_path(base, Path::new(r"C:\code\shop\web")), "web");
        assert_eq!(portable_folder_path(base, Path::new(r"D:\lib")), r"D:\lib");
        assert_eq!(portable_folder_path(base, Path::new(r"C:\code\shopping")), r"C:\code\shopping");
        assert_eq!(
            resolve_folder(base, &FolderEntry { path: "web".into(), name: None, extra: Map::new() }),
            base.join("web")
        );
    }

    #[test]
    fn atomic_writes_never_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("w.ivily-workspace");
        let h1 = write_atomic(&p, b"one", WriteMode::CreateNew).unwrap();
        assert!(matches!(write_atomic(&p, b"x", WriteMode::CreateNew), Err(AppError::Conflict(_))));
        let h2 = write_atomic(&p, b"two", WriteMode::Update { expected_hash: &h1 }).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        // External modification is detected and the file is left alone.
        std::fs::write(&p, b"edited elsewhere").unwrap();
        assert!(matches!(
            write_atomic(&p, b"three", WriteMode::Update { expected_hash: &h2 }),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(std::fs::read(&p).unwrap(), b"edited elsewhere");
        write_atomic(&p, b"replaced", WriteMode::ReplaceConfirmed).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"replaced");
        // Deleted file is a conflict, not a silent re-create.
        std::fs::remove_file(&p).unwrap();
        assert!(write_atomic(&p, b"x", WriteMode::Update { expected_hash: &h2 }).is_err());
        assert!(!p.exists());
        // No temp files left behind.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
