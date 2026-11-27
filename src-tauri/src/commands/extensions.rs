//! Extension commands: list, install from a folder (preview + confirm), enable/disable, remove.

use crate::error::{AppError, AppResult};
use crate::extensions::{self, Manifest};
use crate::state::AppState;
use crate::workspace::grants::GrantKind;
use crate::workspace::service;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

const DISABLED_KEY: &str = "extensions.disabled";

fn base(state: &AppState) -> PathBuf {
    state.data_dir.join("extensions")
}

fn disabled(state: &AppState) -> BTreeSet<String> {
    crate::app_state::get(&state.db.lock(), DISABLED_KEY).ok().flatten().unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    manifest: Manifest,
    enabled: bool,
    /// Asset path → JSON text (validated by the UI before use).
    files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionList {
    installed: Vec<InstalledExtension>,
    issues: Vec<String>,
    /// Ids recommended by the open workspace (`.ivily/extensions.json`); informational only.
    recommendations: Vec<String>,
}

#[tauri::command]
pub fn extensions_list(window: Window, state: State<'_, AppState>) -> AppResult<ExtensionList> {
    let (list, issues) = extensions::list_installed(&base(&state));
    let off = disabled(&state);
    let recommendations = service::current(&state, window.label())
        .map(|ws| extensions::recommendations(&ws.roots().into_iter().map(|r| r.path).collect::<Vec<_>>()))
        .unwrap_or_default();
    Ok(ExtensionList {
        installed: list
            .into_iter()
            .map(|(m, files)| InstalledExtension { enabled: !off.contains(&m.id), manifest: m, files })
            .collect(),
        issues,
        recommendations,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    token: String,
    manifest: Manifest,
    files: Vec<String>,
    replaces: Option<String>,
}

/// Pick an extension folder and validate it. Nothing is installed until `extensions_install_confirm`.
#[tauri::command]
pub async fn extensions_install_dialog(app: AppHandle, window: Window) -> AppResult<Option<InstallPreview>> {
    let state = app.state::<AppState>();
    let Some(dir) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Select an extension folder")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let (manifest, files) = extensions::read_source(&dir)?;
    let replaces = extensions::list_installed(&base(&state))
        .0
        .into_iter()
        .find(|(m, _)| m.id == manifest.id)
        .map(|(m, _)| m.version);
    let token = state.grants.insert(GrantKind::ExtensionSource, dir);
    Ok(Some(InstallPreview { token, files: files.keys().cloned().collect(), manifest, replaces }))
}

#[tauri::command]
pub fn extensions_install_confirm(state: State<'_, AppState>, token: String) -> AppResult<Manifest> {
    let dir = state
        .grants
        .take(&token, GrantKind::ExtensionSource)
        .ok_or_else(|| AppError::NotFound("extension folder (select it again)".into()))?;
    // Re-read: the folder may have changed since the preview.
    let (manifest, files) = extensions::read_source(&dir)?;
    extensions::install(&base(&state), &manifest, &files)?;
    state.output.info("app", format!("extension installed: {} {}", manifest.id, manifest.version));
    Ok(manifest)
}

#[tauri::command]
pub fn extensions_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> AppResult<()> {
    if !extensions::valid_id(&id) {
        return Err(AppError::validation("invalid_extension", "invalid id"));
    }
    let mut off = disabled(&state);
    if enabled {
        off.remove(&id);
    } else {
        off.insert(id);
    }
    crate::app_state::set(&state.db.lock(), DISABLED_KEY, &off)
}

#[tauri::command]
pub fn extensions_uninstall(state: State<'_, AppState>, id: String) -> AppResult<()> {
    extensions::uninstall(&base(&state), &id)?;
    let mut off = disabled(&state);
    if off.remove(&id) {
        crate::app_state::set(&state.db.lock(), DISABLED_KEY, &off)?;
    }
    state.output.info("app", format!("extension removed: {id}"));
    Ok(())
}
