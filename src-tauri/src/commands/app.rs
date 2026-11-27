use crate::core::StartupIssue;
use crate::db::DbHealth;
use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

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
pub fn app_info(window: Window, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        name: crate::APP_NAME,
        version: crate::APP_VERSION,
        database: state.db_health.clone(),
        // Startup problems are reported once, in the main window.
        startup_issues: if window.label() == "main" { state.startup_issues.clone() } else { Vec::new() },
    }
}

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// Open another workbench window. It starts on the launcher, or opens `workspace_id` when given.
#[tauri::command]
pub async fn window_new(app: AppHandle, workspace_id: Option<String>) -> crate::error::AppResult<String> {
    if let Some(id) = &workspace_id {
        if !crate::workspace::valid_id(id) {
            return Err(crate::error::AppError::validation("invalid_id", "invalid workspace id"));
        }
    }
    let n = NEXT_WINDOW.fetch_add(1, Ordering::Relaxed);
    let label = format!("w-{n}");
    let url = match &workspace_id {
        Some(id) => format!("index.html?workspace={id}"),
        None => "index.html".to_string(),
    };
    let offset = 32.0 * ((n % 8) as f64);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Ivily Center")
        .inner_size(1280.0, 820.0)
        .min_inner_size(800.0, 520.0)
        .position(80.0 + offset, 60.0 + offset)
        .decorations(false)
        .shadow(true)
        .background_color(tauri::window::Color(16, 17, 20, 255))
        .build()
        .map_err(|e| crate::error::AppError::Internal(format!("could not open a window: {e}")))?;
    app.state::<AppState>().output.info("window", format!("opened window {label}"));
    Ok(label)
}

/// Bring another Ivily Center window to the front (e.g. the one that already has a workspace open).
#[tauri::command]
pub fn window_focus(app: AppHandle, label: String) -> crate::error::AppResult<()> {
    let w =
        app.get_webview_window(&label).ok_or_else(|| crate::error::AppError::NotFound(format!("window {label}")))?;
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}
