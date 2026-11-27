use super::events::SETTINGS_CHANGED;
use crate::error::AppResult;
use crate::settings::{self, ResolvedSettings, Scope, ScopeArg, SettingSchemaDto};
use crate::state::AppState;
use crate::workspace::service;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State, Window};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed<'a> {
    key: &'a str,
    scope: ScopeArg,
}

#[tauri::command]
pub fn settings_schema() -> Vec<SettingSchemaDto> {
    settings::schema_dto()
}

/// Resolved values for the calling window: default < user < its workspace.
#[tauri::command]
pub fn settings_values(window: Window, state: State<'_, AppState>) -> AppResult<ResolvedSettings> {
    service::resolve_settings(&state, window.label())
}

/// Store a validated value. `workspace` scope writes to the calling window's workspace (the app
/// database for folder workspaces, the workspace file for file workspaces).
#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    key: String,
    value: Value,
    scope: ScopeArg,
) -> AppResult<Value> {
    let v = match scope {
        ScopeArg::User => settings::set(&state.db.lock(), &Scope::User, &key, &value)?,
        ScopeArg::Workspace => service::set_workspace_setting(&state, window.label(), &key, &value)?,
    };
    apply_side_effects(&state, &key);
    state
        .output
        .info("settings", format!("{key} set ({} scope)", if scope == ScopeArg::User { "user" } else { "workspace" }));
    let _ = app.emit(SETTINGS_CHANGED, Changed { key: &key, scope });
    Ok(v)
}

#[tauri::command]
pub fn settings_reset(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    key: String,
    scope: ScopeArg,
) -> AppResult<()> {
    match scope {
        ScopeArg::User => settings::reset(&state.db.lock(), &Scope::User, &key)?,
        ScopeArg::Workspace => service::reset_workspace_setting(&state, window.label(), &key)?,
    }
    apply_side_effects(&state, &key);
    state.output.info(
        "settings",
        format!("{key} reset ({} scope)", if scope == ScopeArg::User { "user" } else { "workspace" }),
    );
    let _ = app.emit(SETTINGS_CHANGED, Changed { key: &key, scope });
    Ok(())
}

fn apply_side_effects(state: &AppState, key: &str) {
    if key == "output.maxLinesPerChannel" {
        if let Ok(v) = settings::get_user(&state.db.lock(), key) {
            if let Some(n) = v.as_u64() {
                state.output.set_capacity(n as usize);
            }
        }
    }
}
