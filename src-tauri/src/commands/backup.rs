//! Backup commands: list, create, verify, restore (staged), export, import, delete.

use crate::backup::{self, BackupInfo, Manifest};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::workspace::grants::GrantKind;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupList {
    backups: Vec<BackupInfo>,
    folder: String,
    restore_pending: bool,
}

#[tauri::command]
pub fn backup_list(state: State<'_, AppState>) -> BackupList {
    BackupList {
        backups: backup::list(&state.data_dir),
        folder: state.data_dir.join(backup::DIR).display().to_string(),
        restore_pending: state.data_dir.join(backup::PENDING).join("restore.json").is_file(),
    }
}

fn keep(state: &AppState) -> usize {
    crate::settings::resolve(&state.db.lock(), &crate::settings::WorkspaceLayer::None)
        .ok()
        .and_then(|r| r.values.get("backup.keep").and_then(|v| v.value.as_u64()))
        .unwrap_or(10) as usize
}

/// Create a backup now. `kind`: `manual` or `automatic` (startup schedule).
#[tauri::command]
pub async fn backup_create(app: AppHandle, kind: String) -> AppResult<String> {
    if !matches!(kind.as_str(), "manual" | "automatic") {
        return Err(AppError::validation("invalid_kind", "invalid backup kind"));
    }
    let app2 = app.clone();
    let name = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        let conn = state.db.lock();
        backup::create(&conn, &state.data_dir, &kind)
            .map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;
    let state = app.state::<AppState>();
    state.output.info("app", format!("backup created: {name}"));
    for removed in backup::apply_retention(&state.data_dir, keep(&state)) {
        state.output.info("app", format!("old automatic backup removed: {removed}"));
    }
    Ok(name)
}

#[tauri::command]
pub async fn backup_verify(app: AppHandle, name: String) -> AppResult<Manifest> {
    let state = app.state::<AppState>();
    let path = backup::resolve(&state.data_dir, &name)?;
    tauri::async_runtime::spawn_blocking(move || backup::verify(&path))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Stage a restore (verified, extracted), after taking a safety backup of the current state.
/// It is applied when the app starts the next time.
#[tauri::command]
pub async fn backup_restore(app: AppHandle, name: String) -> AppResult<Manifest> {
    let app2 = app.clone();
    let m = tauri::async_runtime::spawn_blocking(move || -> AppResult<Manifest> {
        let state = app2.state::<AppState>();
        let path = backup::resolve(&state.data_dir, &name)?;
        backup::verify(&path)?;
        {
            let conn = state.db.lock();
            backup::create(&conn, &state.data_dir, "safety")?;
        }
        backup::stage_restore(&state.data_dir, &path)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;
    app.state::<AppState>().output.info("app", "restore staged; it is applied at the next start");
    Ok(m)
}

#[tauri::command]
pub fn backup_cancel_restore(state: State<'_, AppState>) -> AppResult<bool> {
    backup::cancel_restore(&state.data_dir)
}

/// Delete one backup (explicit user action; the UI confirms).
#[tauri::command]
pub fn backup_delete(state: State<'_, AppState>, name: String) -> AppResult<()> {
    let path = backup::resolve(&state.data_dir, &name)?;
    std::fs::remove_file(path)?;
    state.output.info("app", format!("backup deleted: {name}"));
    Ok(())
}

/// Copy a backup to a location the user picks.
#[tauri::command]
pub async fn backup_export(app: AppHandle, window: Window, name: String) -> AppResult<Option<String>> {
    let state = app.state::<AppState>();
    let src = backup::resolve(&state.data_dir, &name)?;
    let Some(dest) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Export Backup")
        .set_file_name(&name)
        .add_filter("Zip archive", &["zip"])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    if dest.exists() {
        let token = state.grants.insert(GrantKind::SaveTarget, dest.clone());
        return Err(AppError::Conflict(format!("exists:{token}:{}", dest.display())));
    }
    std::fs::copy(&src, &dest)?;
    Ok(Some(dest.display().to_string()))
}

/// Overwrite confirmed by the user after `backup_export` reported an existing file.
#[tauri::command]
pub fn backup_export_confirm(state: State<'_, AppState>, name: String, token: String) -> AppResult<String> {
    let src = backup::resolve(&state.data_dir, &name)?;
    let dest = state
        .grants
        .take(&token, GrantKind::SaveTarget)
        .ok_or_else(|| AppError::NotFound("export target (choose it again)".into()))?;
    let partial = dest.with_extension("zip.partial");
    std::fs::copy(&src, &partial)?;
    std::fs::rename(&partial, &dest)?;
    Ok(dest.display().to_string())
}

/// Pick an archive, verify it and copy it into the backup folder.
#[tauri::command]
pub async fn backup_import(app: AppHandle, window: Window) -> AppResult<Option<String>> {
    let Some(src) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Import Backup")
        .add_filter("Ivily Center backup", &["zip"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let app2 = app.clone();
    let name = tauri::async_runtime::spawn_blocking(move || backup::import(&app2.state::<AppState>().data_dir, &src))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    Ok(Some(name))
}

/// Restart the app (to apply a staged restore).
#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart();
}
