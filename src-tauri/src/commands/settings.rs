use super::events::SETTINGS_CHANGED;
use crate::error::AppResult;
use crate::settings::{self, ResolvedSettings, Scope, ScopeArg, SettingSchemaDto};
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed<'a> {
    key: &'a str,
    scope: &'static str,
}

fn scope_name(s: &Scope) -> &'static str {
    match s {
        Scope::User => "user",
        Scope::Workspace(_) => "workspace",
    }
}

#[tauri::command]
pub fn settings_schema() -> Vec<SettingSchemaDto> {
    settings::schema_dto()
}

#[tauri::command]
pub fn settings_values(state: State<'_, AppState>, workspace_id: Option<String>) -> AppResult<ResolvedSettings> {
    let ws = workspace_id.as_deref().map(Scope::workspace).transpose()?;
    settings::resolve(&state.db.lock(), ws.as_ref())
}

/// Store a validated value. Side effects of backend-consumed settings are applied here.
#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: Value,
    scope: ScopeArg,
) -> AppResult<Value> {
    let scope = scope.into_scope()?;
    let v = settings::set(&state.db.lock(), &scope, &key, &value)?;
    apply_side_effects(&state, &key, &v);
    state.output.info("settings", format!("{key} set ({} scope)", scope_name(&scope)));
    let _ = app.emit(SETTINGS_CHANGED, Changed { key: &key, scope: scope_name(&scope) });
    Ok(v)
}

#[tauri::command]
pub fn settings_reset(app: AppHandle, state: State<'_, AppState>, key: String, scope: ScopeArg) -> AppResult<()> {
    let scope = scope.into_scope()?;
    {
        let db = state.db.lock();
        settings::reset(&db, &scope, &key)?;
        if let Ok(v) = settings::get_user(&db, &key) {
            apply_side_effects(&state, &key, &v);
        }
    }
    state.output.info("settings", format!("{key} reset ({} scope)", scope_name(&scope)));
    let _ = app.emit(SETTINGS_CHANGED, Changed { key: &key, scope: scope_name(&scope) });
    Ok(())
}

fn apply_side_effects(state: &AppState, key: &str, v: &Value) {
    if key == "output.maxLinesPerChannel" {
        if let Some(n) = v.as_u64() {
            state.output.set_capacity(n as usize);
        }
    }
}
