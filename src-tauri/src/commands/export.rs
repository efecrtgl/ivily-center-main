//! "Save as" for generated text (output logs, settings exports …). The user picks the file in a
//! native dialog owned by the backend; an existing file is only replaced after an explicit
//! confirmation (opaque token, see `GrantKind::SaveTarget`).

use crate::editor_io::{self, Encoding, Eol};
use crate::error::{AppError, AppResult};
use crate::fs;
use crate::state::AppState;
use crate::workspace::grants::GrantKind;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

const MAX_EXPORT: usize = 64 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExportOutcome {
    Saved {
        path: String,
    },
    /// The chosen file exists; ask, then call `save_text_confirm` with the token.
    ConfirmOverwrite {
        token: String,
        path: String,
    },
}

fn write_new_or_replace(path: &Path, content: &str) -> AppResult<()> {
    editor_io::write(path, content, Encoding::Utf8, Eol::Crlf, None, !path.exists()).map(|_| ())
}

#[tauri::command]
pub async fn save_text_dialog(
    app: AppHandle,
    window: Window,
    title: String,
    suggested_name: String,
    extension: String,
    content: String,
) -> AppResult<Option<ExportOutcome>> {
    if content.len() > MAX_EXPORT {
        return Err(AppError::validation("too_large", "the content is too large to export"));
    }
    if !extension.chars().all(|c| c.is_ascii_alphanumeric()) || extension.len() > 10 {
        return Err(AppError::validation("invalid_extension", "invalid file extension"));
    }
    let state = app.state::<AppState>();
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title.chars().take(80).collect::<String>())
        .add_filter(extension.to_uppercase(), &[extension.as_str()]);
    if fs::scope::validate_name(&suggested_name).is_ok() {
        dialog = dialog.set_file_name(suggested_name);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    if path.exists() {
        let token = state.grants.insert(GrantKind::SaveTarget, path.clone());
        return Ok(Some(ExportOutcome::ConfirmOverwrite { token, path: path.display().to_string() }));
    }
    write_new_or_replace(&path, &content)?;
    state.output.info("app", format!("exported {}", path.display()));
    Ok(Some(ExportOutcome::Saved { path: path.display().to_string() }))
}

#[tauri::command]
pub fn save_text_confirm(state: State<'_, AppState>, token: String, content: String) -> AppResult<ExportOutcome> {
    if content.len() > MAX_EXPORT {
        return Err(AppError::validation("too_large", "the content is too large to export"));
    }
    let path = state
        .grants
        .take(&token, GrantKind::SaveTarget)
        .ok_or_else(|| AppError::NotFound("save target (choose the file again)".into()))?;
    write_new_or_replace(&path, &content)?;
    state.output.info("app", format!("exported {} (replaced)", path.display()));
    Ok(ExportOutcome::Saved { path: path.display().to_string() })
}

const MAX_IMPORT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedText {
    pub name: String,
    pub content: String,
}

/// Let the user pick a small UTF-8 text file (settings, themes, icon packs) and return its
/// contents. Only the file the user chose is read; the caller validates the content.
#[tauri::command]
pub async fn open_text_dialog(
    app: AppHandle,
    window: Window,
    title: String,
    extensions: Vec<String>,
) -> AppResult<Option<ImportedText>> {
    if extensions.is_empty()
        || extensions.len() > 5
        || extensions.iter().any(|e| e.is_empty() || e.len() > 10 || !e.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return Err(AppError::validation("invalid_extension", "invalid file extensions"));
    }
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title.chars().take(80).collect::<String>())
        .add_filter(exts.join(", ").to_uppercase(), &exts)
        .blocking_pick_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    read_text_file(&path).map(Some)
}

fn read_text_file(path: &Path) -> AppResult<ImportedText> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(AppError::validation("not_a_file", "not a file"));
    }
    if meta.len() > MAX_IMPORT {
        return Err(AppError::validation("too_large", "the file is larger than 2 MB"));
    }
    let bytes = std::fs::read(path)?;
    let content =
        String::from_utf8(bytes).map_err(|_| AppError::validation("not_utf8", "the file is not UTF-8 text"))?;
    Ok(ImportedText {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        content: content.trim_start_matches('\u{feff}').to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_small_utf8_files_only() {
        let d = tempfile::tempdir().unwrap();
        let ok = d.path().join("a.json");
        std::fs::write(&ok, "\u{feff}{\"a\":1}").unwrap();
        assert_eq!(read_text_file(&ok).unwrap().content, "{\"a\":1}");
        let bin = d.path().join("b.json");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_text_file(&bin).is_err());
        assert!(read_text_file(d.path()).is_err());
    }
}
