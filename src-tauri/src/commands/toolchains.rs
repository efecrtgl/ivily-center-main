use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::toolchains::{self, Tool, TOOLS};
use crate::workspace::service;
use serde::Serialize;
use tauri::{AppHandle, Manager, Window};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub tools: Vec<Tool>,
    /// Tool ids that the window's workspace probably uses.
    pub relevant: Vec<&'static str>,
    pub detected_at: i64,
}

/// Detect installed tools (cached; `refresh` re-probes).
#[tauri::command]
pub async fn toolchains_detect(app: AppHandle, window: Window, refresh: bool) -> AppResult<Detection> {
    let state = app.state::<AppState>();
    let cached = state.toolchain_cache.lock().clone();
    let (tools, at) = match cached {
        Some(c) if !refresh => c,
        _ => {
            let cwd = state.data_dir.clone();
            let tools = tauri::async_runtime::spawn_blocking(move || toolchains::detect_all(&cwd))
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?;
            let at = crate::core::now_ms();
            *state.toolchain_cache.lock() = Some((tools.clone(), at));
            let found = tools.iter().filter(|t| t.status == toolchains::Status::Available).count();
            state.output.info("app", format!("toolchain detection: {found} of {} tools available", tools.len()));
            (tools, at)
        }
    };
    let roots: Vec<_> = service::current(&state, window.label())
        .map(|w| w.roots().into_iter().map(|r| r.path).collect())
        .unwrap_or_default();
    Ok(Detection { tools, relevant: toolchains::relevant_tools(&roots), detected_at: at })
}

/// Open the official download page of a known tool in the default browser.
/// Only URLs from the built-in table can be opened (the UI passes a tool id, not a URL).
#[tauri::command]
pub fn toolchains_open_homepage(id: String) -> AppResult<()> {
    let spec = TOOLS.iter().find(|t| t.id == id).ok_or_else(|| AppError::NotFound(format!("tool {id}")))?;
    crate::core::open_url(spec.homepage)
}
