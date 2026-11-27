//! Language server commands. See `crate::lsp` for the security model.

use crate::error::{AppError, AppResult};
use crate::lsp::{self, framing, SERVERS};
use crate::state::AppState;
use crate::workspace::service;
use crate::workspace::trust::Capability;
use serde::Serialize;
use std::io::BufRead;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State, Window};

pub const LSP_MESSAGE: &str = "lsp://message";
pub const LSP_EXIT: &str = "lsp://exit";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MessageEvent {
    id: u64,
    body: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    id: u64,
    server: &'static str,
    code: Option<i32>,
}

fn string_list(values: &crate::settings::ResolvedSettings, key: &str) -> Vec<String> {
    values
        .values
        .get(key)
        .and_then(|v| v.value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    #[serde(flatten)]
    pub spec: &'static lsp::ServerSpec,
    /// Resolved executable, if found.
    pub path: Option<String>,
    pub disabled: bool,
}

#[tauri::command]
pub fn lsp_servers(window: Window, state: State<'_, AppState>) -> AppResult<Vec<ServerInfo>> {
    let values = service::resolve_settings(&state, window.label())?;
    let overrides = string_list(&values, "lsp.serverPaths");
    let disabled = string_list(&values, "lsp.disabledServers");
    Ok(SERVERS
        .iter()
        .map(|s| ServerInfo {
            spec: s,
            path: lsp::resolve_exe(s, &overrides).map(|p| p.display().to_string()),
            disabled: disabled.iter().any(|d| d == s.id),
        })
        .collect())
}

/// Start (or reuse) a server for the window's workspace. Requires the `languageServers` trust
/// capability. Returns the instance id.
#[tauri::command]
pub fn lsp_start(app: AppHandle, window: Window, state: State<'_, AppState>, server: String) -> AppResult<u64> {
    let label = window.label().to_string();
    let spec = lsp::spec(&server).ok_or_else(|| AppError::NotFound(format!("language server {server}")))?;
    let values = service::resolve_settings(&state, &label)?;
    if values.values.get("lsp.enabled").and_then(|v| v.value.as_bool()) == Some(false) {
        return Err(AppError::validation("lsp_disabled", "language servers are turned off in settings"));
    }
    if string_list(&values, "lsp.disabledServers").iter().any(|d| d == spec.id) {
        return Err(AppError::validation("lsp_disabled", format!("{} is disabled in settings", spec.name)));
    }
    service::require_capability(&state, &label, Capability::LanguageServers)?;
    if let Some((id, _)) = state.lsp.lock().iter().find(|(_, p)| p.server == spec.id && p.window == label) {
        return Ok(*id);
    }
    let exe = lsp::resolve_exe(spec, &string_list(&values, "lsp.serverPaths")).ok_or_else(|| {
        AppError::NotFound(format!("{} is not installed. Install it with: {}", spec.name, spec.install))
    })?;
    let ws =
        service::current(&state, &label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let cwd = ws
        .roots()
        .first()
        .map(|r| r.path.clone())
        .ok_or_else(|| AppError::validation("no_folders", "the workspace has no available folder"))?;
    let (process, stdout, stderr) = lsp::spawn(spec, &exe, &cwd, &label)?;
    let id = state.lsp_next.fetch_add(1, Ordering::Relaxed);
    let trace = values.values.get("lsp.trace").and_then(|v| v.value.as_bool()).unwrap_or(false);
    state.output.info("lsp", format!("[{}] started {} (pid {})", spec.id, exe.display(), process.child.id()));
    state.lsp.lock().insert(id, process);

    // stdout → messages to the window
    let app_out = app.clone();
    let label_out = label.clone();
    std::thread::Builder::new()
        .name(format!("lsp-{}-out", spec.id))
        .spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            while let Ok(Some(body)) = framing::read_message(&mut reader) {
                let body = String::from_utf8_lossy(&body).into_owned();
                if trace {
                    let st = app_out.state::<AppState>();
                    st.output.log(
                        "lsp",
                        crate::output::Level::Trace,
                        format!("[{}] ← {}", spec.id, body.chars().take(400).collect::<String>()),
                    );
                }
                let _ = app_out.emit_to(label_out.as_str(), LSP_MESSAGE, MessageEvent { id, body });
            }
            let st = app_out.state::<AppState>();
            let code =
                st.lsp.lock().remove(&id).and_then(|mut p| p.child.try_wait().ok().flatten()).and_then(|s| s.code());
            st.output.warn(
                "lsp",
                format!("[{}] stopped{}", spec.id, code.map(|c| format!(" (exit code {c})")).unwrap_or_default()),
            );
            let _ = app_out.emit_to(label_out.as_str(), LSP_EXIT, ExitEvent { id, server: spec.id, code });
        })
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // stderr → Language Servers output channel
    let app_err = app.clone();
    std::thread::Builder::new()
        .name(format!("lsp-{}-err", spec.id))
        .spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let st = app_err.state::<AppState>();
                st.output.log(
                    "lsp",
                    crate::output::Level::Info,
                    format!("[{}] {}", spec.id, line.chars().take(2000).collect::<String>()),
                );
            }
        })
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(window: Window, state: State<'_, AppState>, id: u64, message: String) -> AppResult<()> {
    if message.len() > framing::MAX_MESSAGE_BYTES {
        return Err(AppError::validation("too_large", "message too large"));
    }
    let mut servers = state.lsp.lock();
    let p = servers
        .get_mut(&id)
        .filter(|p| p.window == window.label())
        .ok_or_else(|| AppError::NotFound("language server instance".into()))?;
    p.send(&message)
}

#[tauri::command]
pub fn lsp_stop(window: Window, state: State<'_, AppState>, id: u64) -> AppResult<()> {
    let mut servers = state.lsp.lock();
    if servers.get(&id).is_some_and(|p| p.window == window.label()) {
        servers.remove(&id); // dropping the job kills the process tree
    }
    Ok(())
}

/// Stop every server of a window (its workspace changed or it closed).
pub fn stop_window(state: &AppState, label: &str) {
    let mut servers = state.lsp.lock();
    let ids: Vec<u64> = servers.iter().filter(|(_, p)| p.window == label).map(|(id, _)| *id).collect();
    for id in ids {
        if let Some(p) = servers.remove(&id) {
            state.output.info("lsp", format!("[{}] stopped (workspace changed)", p.server));
        }
    }
}
