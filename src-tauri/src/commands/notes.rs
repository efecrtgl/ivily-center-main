//! Workspace notes: one Markdown document per workspace, stored in the application data folder
//! (`notes/<workspace id>.md`), never inside the project.

use crate::editor_io::{self, Encoding, Eol};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::workspace::service;
use std::path::PathBuf;
use tauri::{State, Window};

const MAX_NOTES: usize = 1024 * 1024;

fn notes_path(state: &AppState, label: &str) -> AppResult<PathBuf> {
    let ws =
        service::current(state, label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let id = &ws.record.id;
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(AppError::Internal("unexpected workspace id".into()));
    }
    Ok(state.data_dir.join("notes").join(format!("{id}.md")))
}

#[tauri::command]
pub fn notes_read(window: Window, state: State<'_, AppState>) -> AppResult<String> {
    let p = notes_path(&state, window.label())?;
    match std::fs::read(&p) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn notes_write(window: Window, state: State<'_, AppState>, content: String) -> AppResult<()> {
    if content.len() > MAX_NOTES {
        return Err(AppError::validation("too_large", "notes are limited to 1 MB"));
    }
    let p = notes_path(&state, window.label())?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if content.is_empty() && !p.exists() {
        return Ok(());
    }
    editor_io::write(&p, &content, Encoding::Utf8, Eol::Lf, None, !p.exists()).map(|_| ())
}
