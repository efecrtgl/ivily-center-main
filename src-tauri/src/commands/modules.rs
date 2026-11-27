//! Ivily module commands (IEP client): status of every known module, allowlisted read-only
//! requests and opening a module's own window on request.

use crate::error::{AppError, AppResult};
use crate::iep::{self, ModuleStatus};
use crate::state::AppState;
use crate::workspace::service;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, Window};

fn overrides(state: &AppState, label: &str) -> AppResult<Vec<String>> {
    Ok(service::resolve_settings(state, label)?
        .values
        .get("ecosystem.modulePaths")
        .and_then(|v| v.value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect())
}

fn integration_enabled(state: &AppState, label: &str) -> AppResult<bool> {
    Ok(service::resolve_settings(state, label)?
        .values
        .get("ecosystem.enabled")
        .and_then(|v| v.value.as_bool())
        .unwrap_or(true))
}

/// Status of all known modules. Cached; `refresh` asks every installed module again (in parallel).
#[tauri::command]
pub async fn modules_status(app: AppHandle, window: Window, refresh: Option<bool>) -> AppResult<Vec<ModuleStatus>> {
    let state = app.state::<AppState>();
    if !integration_enabled(&state, window.label())? {
        return Err(AppError::validation(
            "ecosystem_disabled",
            "the Ivily ecosystem integration is turned off in settings",
        ));
    }
    if !refresh.unwrap_or(false) {
        if let Some(c) = state.modules.lock().clone() {
            return Ok(c);
        }
    }
    let ov = overrides(&state, window.label())?;
    let list = tauri::async_runtime::spawn_blocking(move || {
        std::thread::scope(|s| {
            let handles: Vec<_> = iep::PROVIDERS.iter().map(|p| s.spawn(|| iep::status(p, &ov))).collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect::<Vec<_>>()
        })
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    for m in &list {
        state.output.info(
            "app",
            format!(
                "module {}: {}{}",
                m.product,
                m.status,
                m.message.as_deref().map(|x| format!(" — {x}")).unwrap_or_default()
            ),
        );
    }
    *state.modules.lock() = Some(list.clone());
    Ok(list)
}

/// One allowlisted, read-only request to a module.
#[tauri::command]
pub async fn module_request(
    app: AppHandle,
    window: Window,
    product: String,
    method: String,
    params: Option<Value>,
) -> AppResult<Value> {
    let state = app.state::<AppState>();
    if !integration_enabled(&state, window.label())? {
        return Err(AppError::validation(
            "ecosystem_disabled",
            "the Ivily ecosystem integration is turned off in settings",
        ));
    }
    let p = iep::provider(&product).ok_or_else(|| AppError::NotFound(format!("module {product}")))?;
    let path = iep::locate(p, &overrides(&state, window.label())?)
        .ok_or_else(|| AppError::NotFound(format!("{} is not installed", p.name)))?;
    iep::check_binary(p, &path).map_err(|e| AppError::validation("module_incompatible", e))?;
    let params = params.unwrap_or(Value::Null);
    if serde_json::to_vec(&params).map(|b| b.len()).unwrap_or(usize::MAX) > 16 * 1024 {
        return Err(AppError::validation("too_large", "parameters too large"));
    }
    tauri::async_runtime::spawn_blocking(move || iep::request(p, &path, &method, &params))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Open the module's own application window (explicit user action).
#[tauri::command]
pub fn module_open(window: Window, state: State<'_, AppState>, product: String) -> AppResult<()> {
    let p = iep::provider(&product).ok_or_else(|| AppError::NotFound(format!("module {product}")))?;
    let path = iep::locate(p, &overrides(&state, window.label())?)
        .ok_or_else(|| AppError::NotFound(format!("{} is not installed", p.name)))?;
    // Only open the expected product (any version).
    let info = iep::version::read(&path)
        .ok_or_else(|| AppError::validation("module_incompatible", "the file has no version information"))?;
    if !info.product_name.eq_ignore_ascii_case(p.name) {
        return Err(AppError::validation(
            "module_incompatible",
            format!("the file is '{}', not {}", info.product_name, p.name),
        ));
    }
    std::process::Command::new(&path)
        .current_dir(path.parent().unwrap_or(std::path::Path::new(".")))
        .spawn()
        .map_err(|e| AppError::Io(format!("could not start {}: {e}", p.name)))?;
    state.output.info("app", format!("opened {}", p.name));
    Ok(())
}
