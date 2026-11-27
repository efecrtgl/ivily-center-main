//! Workspace, trust and session commands.
//!
//! Security: the webview never passes a filesystem path. Locations come from native dialogs shown
//! here in Rust, from known workspace ids, from opaque grant tokens, or from the command line.
//! The workspace is always that of the calling window.

use crate::error::{AppError, AppResult};
use crate::settings;
use crate::state::AppState;
use crate::workspace::grants::GrantKind;
use crate::workspace::paths::{check_availability, Availability, WORKSPACE_FILE_EXT};
use crate::workspace::service::{self, GrantRequest, SaveOutcome, StartupResult, WorkspaceInfo};
use crate::workspace::trust::{TrustRecord, WorkspaceTrust};
use crate::workspace::{self, session, Kind, MetaPatch, WorkspaceRecord};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

fn pick_folder(app: &AppHandle, window: &Window, title: &str) -> Option<PathBuf> {
    app.dialog().file().set_parent(window).set_title(title).blocking_pick_folder().and_then(|p| p.into_path().ok())
}

fn pick_workspace_file(app: &AppHandle, window: &Window, title: &str) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .add_filter("Ivily workspace", &[WORKSPACE_FILE_EXT])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
}

#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> AppResult<Vec<WorkspaceRecord>> {
    workspace::list(&state.db.lock())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityDto {
    id: String,
    status: Availability,
}

/// Check whether recent workspaces still exist. Checks run in parallel with a timeout each, so
/// an unreachable network share cannot freeze the launcher.
#[tauri::command]
pub async fn workspace_availability(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<Vec<AvailabilityDto>> {
    if ids.len() > 500 {
        return Err(AppError::validation("too_many", "at most 500 workspaces per request"));
    }
    let records: Vec<WorkspaceRecord> = {
        let db = state.db.lock();
        ids.iter().filter_map(|id| workspace::get(&db, id).ok()).collect()
    };
    let handles: Vec<_> = records
        .into_iter()
        .map(|r| {
            std::thread::spawn(move || AvailabilityDto {
                status: check_availability(PathBuf::from(&r.path), r.kind == Kind::Folder, Duration::from_secs(3)),
                id: r.id,
            })
        })
        .collect();
    Ok(handles.into_iter().filter_map(|h| h.join().ok()).collect())
}

#[tauri::command]
pub fn workspace_current(window: Window, state: State<'_, AppState>) -> AppResult<Option<WorkspaceInfo>> {
    service::current(&state, window.label()).map(|w| service::info(&state, &w)).transpose()
}

/// Show a native dialog and open the chosen folder or workspace file. `None` = cancelled.
#[tauri::command]
pub async fn workspace_open_dialog(app: AppHandle, window: Window, kind: Kind) -> AppResult<Option<WorkspaceInfo>> {
    let picked = match kind {
        Kind::Folder => pick_folder(&app, &window, "Open Folder"),
        Kind::File => pick_workspace_file(&app, &window, "Open Workspace File"),
    };
    let Some(path) = picked else { return Ok(None) };
    let state = app.state::<AppState>();
    service::open_path(&state, window.label(), &path).map(Some)
}

#[tauri::command]
pub fn workspace_open_recent(window: Window, state: State<'_, AppState>, id: String) -> AppResult<WorkspaceInfo> {
    service::open_record(&state, window.label(), &id)
}

#[tauri::command]
pub fn workspace_open_discovered(
    window: Window,
    state: State<'_, AppState>,
    token: String,
) -> AppResult<WorkspaceInfo> {
    let path = state
        .grants
        .get(&token, GrantKind::Discovered)
        .ok_or_else(|| AppError::NotFound("discovered project (search again)".into()))?;
    service::open_path(&state, window.label(), &path)
}

#[tauri::command]
pub fn workspace_close(window: Window, state: State<'_, AppState>) -> AppResult<()> {
    service::close(&state, window.label())
}

#[tauri::command]
pub fn workspace_startup(window: Window, state: State<'_, AppState>) -> AppResult<StartupResult> {
    let setting = settings::get_user(&state.db.lock(), "workbench.startup")?;
    service::startup(&state, window.label(), setting.as_str().unwrap_or("lastWorkspace"))
}

#[tauri::command]
pub fn workspace_update_meta(state: State<'_, AppState>, id: String, patch: MetaPatch) -> AppResult<WorkspaceRecord> {
    let r = workspace::update_meta(&state.db.lock(), &id, &patch)?;
    // Keep an open workspace's in-memory record in sync (name shown in the title bar).
    for w in state.workspaces.lock().values_mut().filter(|w| w.record.id == id) {
        w.record = r.clone();
    }
    Ok(r)
}

#[tauri::command]
pub fn workspace_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    service::remove(&state, &id)
}

/// Pick a new location for a workspace whose folder or file moved. `None` = cancelled.
#[tauri::command]
pub async fn workspace_relocate(app: AppHandle, window: Window, id: String) -> AppResult<Option<WorkspaceRecord>> {
    let kind = workspace::get(&app.state::<AppState>().db.lock(), &id)?.kind;
    let picked = match kind {
        Kind::Folder => pick_folder(&app, &window, "Locate Folder"),
        Kind::File => pick_workspace_file(&app, &window, "Locate Workspace File"),
    };
    let Some(path) = picked else { return Ok(None) };
    service::relocate(&app.state::<AppState>(), &id, &path).map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDto {
    token: String,
    name: String,
    path: String,
    markers: Vec<&'static str>,
    known_workspace_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    root: String,
    projects: Vec<DiscoveredDto>,
}

/// Let the user pick a folder (e.g. `C:\code`) and list the projects directly inside it.
#[tauri::command]
pub async fn workspace_discover(app: AppHandle, window: Window) -> AppResult<Option<DiscoveryResult>> {
    let Some(root) = pick_folder(&app, &window, "Find Projects in Folder") else { return Ok(None) };
    let state = app.state::<AppState>();
    let found = workspace::discover::discover(&root)?;
    state.grants.clear_kind(GrantKind::Discovered);
    let known: Vec<(String, String)> = {
        let db = state.db.lock();
        found
            .iter()
            .filter_map(|c| {
                db.query_row("SELECT id FROM workspace WHERE path_key = ?1", [&c.location.key], |r| {
                    r.get::<_, String>(0)
                })
                .ok()
                .map(|id| (c.location.key.clone(), id))
            })
            .collect()
    };
    let projects = found
        .into_iter()
        .map(|c| DiscoveredDto {
            known_workspace_id: known.iter().find(|(k, _)| *k == c.location.key).map(|(_, id)| id.clone()),
            token: state.grants.insert(GrantKind::Discovered, c.location.path.clone()),
            name: c.name,
            path: c.path,
            markers: c.markers,
        })
        .collect();
    state.output.info("workspace", format!("project discovery in {}", root.display()));
    Ok(Some(DiscoveryResult { root: root.display().to_string(), projects }))
}

/// Save the open workspace as a workspace file chosen in a save dialog. `None` = cancelled.
#[tauri::command]
pub async fn workspace_save_as(app: AppHandle, window: Window) -> AppResult<Option<SaveOutcome>> {
    let state = app.state::<AppState>();
    let ws = service::current(&state, window.label())
        .ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save Workspace As")
        .add_filter("Ivily workspace", &[WORKSPACE_FILE_EXT])
        .set_file_name(format!("{}.{WORKSPACE_FILE_EXT}", ws.record.name));
    if let Some(first) = ws.roots().first() {
        dialog = dialog.set_directory(&first.path);
    }
    let Some(target) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    service::save_as(&state, window.label(), &target, false).map(Some)
}

/// The user confirmed replacing the existing file behind `token`.
#[tauri::command]
pub fn workspace_save_as_confirm(window: Window, state: State<'_, AppState>, token: String) -> AppResult<SaveOutcome> {
    let target = state
        .grants
        .take(&token, GrantKind::SaveTarget)
        .ok_or_else(|| AppError::NotFound("save target (choose the file again)".into()))?;
    service::save_as(&state, window.label(), &target, true)
}

#[tauri::command]
pub fn workspace_reload_file(window: Window, state: State<'_, AppState>) -> AppResult<WorkspaceInfo> {
    service::reload_file(&state, window.label())
}

// ── Trust ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn trust_current(window: Window, state: State<'_, AppState>) -> AppResult<Option<WorkspaceTrust>> {
    service::current(&state, window.label()).map(|w| service::trust_of(&state, &w)).transpose()
}

#[tauri::command]
pub fn trust_grant(window: Window, state: State<'_, AppState>, request: GrantRequest) -> AppResult<WorkspaceTrust> {
    service::grant_trust(&state, window.label(), &request)
}

#[tauri::command]
pub fn trust_deny(window: Window, state: State<'_, AppState>) -> AppResult<WorkspaceTrust> {
    service::deny_trust(&state, window.label())
}

#[tauri::command]
pub fn trust_list(state: State<'_, AppState>) -> AppResult<Vec<TrustRecord>> {
    service::list_trust(&state)
}

#[tauri::command]
pub fn trust_revoke(state: State<'_, AppState>, path_key: String) -> AppResult<()> {
    service::revoke_trust(&state, &path_key)
}

// ── Session ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn session_load(window: Window, state: State<'_, AppState>) -> AppResult<session::LoadedSession> {
    service::load_session(&state, window.label())
}

#[tauri::command]
pub fn session_save(window: Window, state: State<'_, AppState>, session: Value) -> AppResult<()> {
    service::save_session(&state, window.label(), &session)
}

/// The workbench finished restoring: reset the crash-loop counter.
#[tauri::command]
pub fn session_ready(state: State<'_, AppState>) -> AppResult<()> {
    session::mark_ready(&state.db.lock())
}
