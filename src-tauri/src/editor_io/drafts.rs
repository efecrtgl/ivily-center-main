//! Crash-recovery drafts ("hot exit"): the content of unsaved editor documents, stored in the app
//! data directory (never in the project), per workspace. Drafts survive crashes and window closes
//! and are restored as dirty documents; they are deleted when the document is saved or the user
//! discards the changes.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_DRAFT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_DRAFTS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// Editor document key (e.g. `0:src/main.rs`, `untitled:3`, `external:<token>`).
    pub key: String,
    pub content: String,
    pub encoding: super::Encoding,
    pub eol: super::Eol,
    /// Hash of the file the edits are based on (`None` for untitled documents).
    pub base_hash: Option<String>,
    pub saved_at: i64,
}

fn file_for(dir: &Path, key: &str) -> PathBuf {
    let h = super::hash(key.as_bytes());
    dir.join(format!("{}.json", &h[..32]))
}

fn validate_key(key: &str) -> AppResult<()> {
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
        return Err(AppError::validation("invalid_key", "invalid document key"));
    }
    Ok(())
}

pub fn save(dir: &Path, draft: &Draft) -> AppResult<()> {
    validate_key(&draft.key)?;
    if draft.content.len() > MAX_DRAFT_BYTES {
        return Err(AppError::validation("too_large", "document too large for recovery"));
    }
    std::fs::create_dir_all(dir)?;
    let path = file_for(dir, &draft.key);
    if !path.exists() && std::fs::read_dir(dir)?.count() >= MAX_DRAFTS {
        return Err(AppError::validation("too_many", "too many unsaved documents for recovery"));
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(draft).map_err(|e| AppError::Internal(e.to_string()))?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn delete(dir: &Path, key: &str) -> AppResult<()> {
    validate_key(key)?;
    match std::fs::remove_file(file_for(dir, key)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// All readable drafts (unreadable files are skipped, not deleted).
pub fn list(dir: &Path) -> Vec<Draft> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice::<Draft>(&b).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_list_delete() {
        let d = tempfile::tempdir().unwrap();
        let draft = Draft {
            key: "0:src/main.rs".into(),
            content: "fn main() {}".into(),
            encoding: crate::editor_io::Encoding::Utf8,
            eol: crate::editor_io::Eol::Lf,
            base_hash: Some("abc".into()),
            saved_at: 1,
        };
        save(d.path(), &draft).unwrap();
        save(d.path(), &Draft { content: "fn main() { x }".into(), ..draft.clone() }).unwrap();
        let all = list(d.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].content, "fn main() { x }");
        std::fs::write(d.path().join("junk.json"), "{not json").unwrap();
        assert_eq!(list(d.path()).len(), 1, "corrupt drafts are skipped");
        delete(d.path(), "0:src/main.rs").unwrap();
        delete(d.path(), "0:src/main.rs").unwrap();
        assert!(list(d.path()).is_empty());
        assert!(save(d.path(), &Draft { key: String::new(), ..draft }).is_err());
    }
}
