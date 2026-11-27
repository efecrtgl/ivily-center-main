//! File explorer commands. Paths are always `(root index, relative path)` inside the calling
//! window's workspace; see `fs::scope` for validation.

use crate::error::AppResult;
use crate::fs::{self, list::Listing, ops, ops::OnConflict, ops::Properties, watch};
use crate::state::AppState;
use crate::workspace::service;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Window};

pub const FS_CHANGED: &str = "fs://changed";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemRef {
    pub root: usize,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub root: usize,
    pub path: String,
}

fn to_result(t: fs::scope::Target) -> ItemResult {
    ItemResult { root: t.root_index, path: t.rel }
}

const MAX_ITEMS: usize = 10_000;

fn targets(state: &AppState, label: &str, items: &[ItemRef]) -> AppResult<Vec<fs::scope::Target>> {
    if items.len() > MAX_ITEMS {
        return Err(crate::error::AppError::validation("too_many", "too many items"));
    }
    items.iter().map(|i| fs::target(state, label, i.root, &i.path)).collect()
}

/// (Re)start the file watcher for the window's current workspace (or stop it).
pub fn sync_watcher(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let roots = service::current(&state, label).map(|w| w.roots());
    let mut watchers = state.watchers.lock();
    watchers.remove(label);
    if let Some(roots) = roots {
        let emitter = app.clone();
        let target_label = label.to_string();
        let output = state.output.clone();
        let handle = watch::watch(
            roots,
            Arc::new(move |change| {
                super::search::invalidate_index(&emitter.state::<AppState>(), &target_label);
                let _ = emitter.emit_to(target_label.as_str(), FS_CHANGED, change);
            }),
            move |msg| output.warn("workspace", msg),
        );
        watchers.insert(label.to_string(), handle);
    }
}

#[tauri::command]
pub fn fs_list(window: Window, state: State<'_, AppState>, root: usize, path: String) -> AppResult<Listing> {
    let t = fs::target(&state, window.label(), root, &path)?;
    fs::list::list(&t, &fs::list_options(&state, window.label())?)
}

#[tauri::command]
pub fn fs_create_file(window: Window, state: State<'_, AppState>, root: usize, path: String) -> AppResult<ItemResult> {
    let t = fs::target(&state, window.label(), root, &path)?;
    ops::create_file(&t)?;
    Ok(to_result(t))
}

#[tauri::command]
pub fn fs_create_dir(window: Window, state: State<'_, AppState>, root: usize, path: String) -> AppResult<ItemResult> {
    let t = fs::target(&state, window.label(), root, &path)?;
    ops::create_dir(&t)?;
    Ok(to_result(t))
}

#[tauri::command]
pub fn fs_rename(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    path: String,
    new_name: String,
) -> AppResult<ItemResult> {
    let t = fs::target(&state, window.label(), root, &path)?;
    ops::rename(&t, &new_name).map(to_result)
}

#[tauri::command]
pub fn fs_copy(
    window: Window,
    state: State<'_, AppState>,
    items: Vec<ItemRef>,
    dest: ItemRef,
    on_conflict: OnConflict,
) -> AppResult<Vec<ItemResult>> {
    let label = window.label();
    let dest = fs::target(&state, label, dest.root, &dest.path)?;
    targets(&state, label, &items)?.iter().map(|s| ops::copy(s, &dest, on_conflict).map(to_result)).collect()
}

#[tauri::command]
pub fn fs_move(
    window: Window,
    state: State<'_, AppState>,
    items: Vec<ItemRef>,
    dest: ItemRef,
) -> AppResult<Vec<ItemResult>> {
    let label = window.label();
    let dest = fs::target(&state, label, dest.root, &dest.path)?;
    targets(&state, label, &items)?.iter().map(|s| ops::move_to(s, &dest).map(to_result)).collect()
}

#[tauri::command]
pub fn fs_duplicate(window: Window, state: State<'_, AppState>, root: usize, path: String) -> AppResult<ItemResult> {
    let t = fs::target(&state, window.label(), root, &path)?;
    ops::duplicate(&t).map(to_result)
}

#[tauri::command]
pub fn fs_trash(window: Window, state: State<'_, AppState>, items: Vec<ItemRef>) -> AppResult<()> {
    let t = targets(&state, window.label(), &items)?;
    ops::trash(&t)?;
    state.output.info("workspace", format!("moved {} item(s) to the Recycle Bin", t.len()));
    Ok(())
}

#[tauri::command]
pub fn fs_delete_permanently(window: Window, state: State<'_, AppState>, items: Vec<ItemRef>) -> AppResult<()> {
    let t = targets(&state, window.label(), &items)?;
    ops::delete_permanently(&t)?;
    state.output.info("workspace", format!("permanently deleted {} item(s)", t.len()));
    Ok(())
}

#[tauri::command]
pub fn fs_properties(window: Window, state: State<'_, AppState>, root: usize, path: String) -> AppResult<Properties> {
    ops::properties(&fs::target(&state, window.label(), root, &path)?)
}

/// Show the item in Windows Explorer (selected).
#[tauri::command]
pub fn fs_reveal(window: Window, state: State<'_, AppState>, root: usize, path: String) -> AppResult<()> {
    let t = fs::target(&state, window.label(), root, &path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", t.abs.display())).spawn()?;
    }
    #[cfg(not(windows))]
    let _ = t;
    Ok(())
}
