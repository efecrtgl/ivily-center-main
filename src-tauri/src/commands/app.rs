use crate::core::StartupIssue;
use crate::db::DbHealth;
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub database: DbHealth,
    /// Problems found at startup that the UI should surface once.
    pub startup_issues: Vec<StartupIssue>,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        name: crate::APP_NAME,
        version: crate::APP_VERSION,
        database: state.db_health.clone(),
        startup_issues: state.startup_issues.clone(),
    }
}
