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
