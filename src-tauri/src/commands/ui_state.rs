use crate::app_state::{self, validate_ui_key, validate_ui_value};
use crate::error::AppResult;
use crate::state::AppState;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub fn ui_state_get(state: State<'_, AppState>, key: String) -> AppResult<Option<Value>> {
    validate_ui_key(&key)?;
    app_state::get(&state.db.lock(), &key)
}

#[tauri::command]
pub fn ui_state_set(state: State<'_, AppState>, key: String, value: Value) -> AppResult<()> {
    validate_ui_key(&key)?;
    validate_ui_value(&value)?;
    app_state::set(&state.db.lock(), &key, &value)
}
