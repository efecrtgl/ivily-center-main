//! Editor document commands. Documents are workspace items `(root, path)` or external files the
//! user picked in a dialog (opaque token). Drafts (unsaved content for crash recovery) live in the
//! app data directory, per workspace.

use crate::editor_io::{self, drafts, Encoding, Eol, SaveResult, TextDocument};
use crate::error::{AppError, AppResult};
use crate::fs;
use crate::state::AppState;
use crate::workspace::grants::GrantKind;
use crate::workspace::paths::{key_is_within, path_key};
use crate::workspace::service;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum DocRef {
    Workspace { root: usize, path: String },
    External { external: String },
}

fn resolve(state: &AppState, label: &str, r: &DocRef) -> AppResult<PathBuf> {
    match r {
        DocRef::Workspace { root, path } => Ok(fs::target(state, label, *root, path)?.abs),
        DocRef::External { external } => state
            .grants
            .get(external, GrantKind::ExternalDoc)
            .ok_or_else(|| AppError::NotFound("this file is no longer available; open it again".into())),
    }
}

/// Express an absolute path the user picked as a DocRef: inside the workspace when possible.
fn to_ref(state: &AppState, label: &str, path: PathBuf) -> DocRef {
    if let Some(ws) = service::current(state, label) {
        if let Ok(canon) = dunce::canonicalize(&path).or_else(|_| {
            path.parent()
                .and_then(|p| dunce::canonicalize(p).ok())
                .map(|p| p.join(path.file_name().unwrap_or_default()))
                .ok_or(())
        }) {
            let key = path_key(&canon);
            for (i, root) in ws.roots().iter().enumerate() {
                if key != root.key && key_is_within(&key, &root.key) {
                    if let Some(rel) = fs::scope::rel_of(&root.path, &canon) {
                        if fs::scope::normalize_rel(&rel).is_ok() {
                            return DocRef::Workspace { root: i, path: rel };
                        }
                    }
                }
            }
        }
    }
    DocRef::External { external: state.grants.insert(GrantKind::ExternalDoc, path) }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDoc {
    #[serde(rename = "ref")]
    pub doc_ref: DocRef,
    pub name: String,
    /// Full path for display.
    pub location: String,
    #[serde(flatten)]
    pub doc: TextDocument,
}

#[tauri::command]
pub fn doc_read(window: Window, state: State<'_, AppState>, doc: DocRef) -> AppResult<OpenedDoc> {
    let path = resolve(&state, window.label(), &doc)?;
    let text = editor_io::read(&path)?;
    Ok(OpenedDoc {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        location: path.display().to_string(),
        doc_ref: doc,
        doc: text,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn doc_write(
    window: Window,
    state: State<'_, AppState>,
    doc: DocRef,
    content: String,
    encoding: Encoding,
    eol: Eol,
    expected_hash: Option<String>,
    create: Option<bool>,
) -> AppResult<SaveResult> {
    let path = resolve(&state, window.label(), &doc)?;
    editor_io::write(&path, &content, encoding, eol, expected_hash.as_deref(), create.unwrap_or(false))
}

/// "Open File…": native dialog. `None` = cancelled.
#[tauri::command]
pub async fn doc_open_dialog(app: AppHandle, window: Window) -> AppResult<Option<Vec<DocRef>>> {
    let mut dialog = app.dialog().file().set_parent(&window).set_title("Open File");
    let state = app.state::<AppState>();
    if let Some(first) = service::current(&state, window.label()).and_then(|w| w.roots().into_iter().next()) {
        dialog = dialog.set_directory(first.path);
    }
    let Some(files) = dialog.blocking_pick_files() else { return Ok(None) };
    Ok(Some(
        files
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .take(50)
            .map(|p| to_ref(&state, window.label(), p))
            .collect(),
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SaveAsOutcome {
    Saved {
        #[serde(rename = "ref")]
        doc_ref: DocRef,
        name: String,
        location: String,
        result: SaveResult,
    },
    /// The chosen file exists; ask the user, then call `doc_save_as_confirm` with the token.
    ConfirmOverwrite { token: String, path: String },
}

fn finish_save_as(
    state: &AppState,
    label: &str,
    path: PathBuf,
    content: &str,
    encoding: Encoding,
    eol: Eol,
) -> AppResult<SaveAsOutcome> {
    let result = editor_io::write(&path, content, encoding, eol, None, false)?;
    Ok(SaveAsOutcome::Saved {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        location: path.display().to_string(),
        doc_ref: to_ref(state, label, path),
        result,
    })
}

/// "Save As…": native save dialog; never replaces an existing file without confirmation.
#[tauri::command]
pub async fn doc_save_as_dialog(
    app: AppHandle,
    window: Window,
    suggested_name: String,
    content: String,
    encoding: Encoding,
    eol: Eol,
) -> AppResult<Option<SaveAsOutcome>> {
    let state = app.state::<AppState>();
    let mut dialog = app.dialog().file().set_parent(&window).set_title("Save As");
    if !suggested_name.is_empty() && fs::scope::validate_name(&suggested_name).is_ok() {
        dialog = dialog.set_file_name(suggested_name);
    }
    if let Some(first) = service::current(&state, window.label()).and_then(|w| w.roots().into_iter().next()) {
        dialog = dialog.set_directory(first.path);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    if path.exists() {
        let token = state.grants.insert(GrantKind::SaveTarget, path.clone());
        return Ok(Some(SaveAsOutcome::ConfirmOverwrite { token, path: path.display().to_string() }));
    }
    finish_save_as(&state, window.label(), path, &content, encoding, eol).map(Some)
}

#[tauri::command]
pub fn doc_save_as_confirm(
    window: Window,
    state: State<'_, AppState>,
    token: String,
    content: String,
    encoding: Encoding,
    eol: Eol,
) -> AppResult<SaveAsOutcome> {
    let path = state
        .grants
        .take(&token, GrantKind::SaveTarget)
        .ok_or_else(|| AppError::NotFound("save target (choose the file again)".into()))?;
    finish_save_as(&state, window.label(), path, &content, encoding, eol)
}

// ── Drafts ──────────────────────────────────────────────────────────────────

fn drafts_dir(state: &AppState, label: &str) -> PathBuf {
    let ws = service::current(state, label).map(|w| w.record.id).unwrap_or_else(|| "_none".into());
    state.data_dir.join("drafts").join(ws)
}

#[tauri::command]
pub fn draft_save(window: Window, state: State<'_, AppState>, draft: drafts::Draft) -> AppResult<()> {
    drafts::save(&drafts_dir(&state, window.label()), &draft)
}

#[tauri::command]
pub fn draft_list(window: Window, state: State<'_, AppState>) -> AppResult<Vec<drafts::Draft>> {
    Ok(drafts::list(&drafts_dir(&state, window.label())))
}

#[tauri::command]
pub fn draft_delete(window: Window, state: State<'_, AppState>, key: String) -> AppResult<()> {
    drafts::delete(&drafts_dir(&state, window.label()), &key)
}
