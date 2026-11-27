//! Debug commands: list configurations/adapters, start an adapter for a configuration (trust +
//! approval), exchange DAP messages, stop.

use crate::dap::{self, Adapter, FileVars, LaunchConfig};
use crate::error::{AppError, AppResult};
use crate::lsp::framing;
use crate::state::AppState;
use crate::workspace::{service, trust::Capability};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::BufRead;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State, Window};

pub const DAP_MESSAGE: &str = "dap://message";
pub const DAP_EXIT: &str = "dap://exit";
const APPROVALS_KEY: &str = "debug.approvals";

#[derive(Clone, Serialize)]
struct MessageEvent {
    id: u64,
    body: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: u64,
    code: Option<i32>,
}

fn string_list(state: &AppState, label: &str, key: &str) -> AppResult<Vec<String>> {
    Ok(service::resolve_settings(state, label)?
        .values
        .get(key)
        .and_then(|v| v.value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect())
}

fn adapters(state: &AppState, label: &str) -> AppResult<Vec<Adapter>> {
    let mut list = state.dap_adapters.lock().clone().unwrap_or_else(|| {
        let d = dap::detect(&state.data_dir);
        *state.dap_adapters.lock() = Some(d.clone());
        d
    });
    // User adapters take precedence for the same type.
    let mut user = dap::user_adapters(&string_list(state, label, "debug.adapters")?);
    user.append(&mut list);
    Ok(user)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInfo {
    #[serde(flatten)]
    config: LaunchConfig,
    adapter: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugInfo {
    configs: Vec<ConfigInfo>,
    adapters: Vec<Adapter>,
    issues: Vec<String>,
    can_run: bool,
}

#[tauri::command]
pub fn dap_info(window: Window, state: State<'_, AppState>, refresh: Option<bool>) -> AppResult<DebugInfo> {
    if refresh.unwrap_or(false) {
        *state.dap_adapters.lock() = None;
    }
    let label = window.label();
    let ws =
        service::current(&state, label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let (configs, issues) = dap::discover(&ws.roots());
    let adapters = adapters(&state, label)?;
    let can_run = service::require_capability(&state, label, Capability::Debugging).is_ok();
    Ok(DebugInfo {
        configs: configs
            .into_iter()
            .map(|c| ConfigInfo {
                adapter: adapters.iter().find(|a| a.types.contains(&c.ty)).map(|a| a.name.clone()),
                config: c,
            })
            .collect(),
        adapters,
        issues,
        can_run,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRef {
    root: usize,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StartOutcome {
    /// Approval needed: show `config` (substituted) to the user, then call again with `approve`.
    NeedsApproval {
        config: Value,
        adapter: String,
    },
    Started {
        id: u64,
        adapter: String,
        adapter_id: String,
        request: String,
        config: Value,
    },
}

/// Start the adapter for configuration `config_id`. The resolved configuration is returned so the
/// UI sends it as the `launch`/`attach` arguments.
#[tauri::command]
pub fn dap_start(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    config_id: String,
    approve: bool,
    file: Option<FileRef>,
) -> AppResult<StartOutcome> {
    let label = window.label().to_string();
    service::require_capability(&state, &label, Capability::Debugging)?;
    let ws =
        service::current(&state, &label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let roots = ws.roots();
    let (configs, _) = dap::discover(&roots);
    let cfg = configs
        .iter()
        .find(|c| c.id == config_id)
        .ok_or_else(|| AppError::NotFound(format!("launch configuration {config_id}")))?;
    let adapter = adapters(&state, &label)?.into_iter().find(|a| a.types.contains(&cfg.ty)).ok_or_else(|| {
        AppError::NotFound(format!(
            "no debug adapter for type '{}' is installed (see Run and Debug → adapters)",
            cfg.ty
        ))
    })?;
    let folder = roots.get(cfg.root).ok_or_else(|| AppError::NotFound("workspace folder".into()))?.path.clone();
    let vars = match file {
        Some(f) => {
            let t = crate::fs::target(&state, &label, f.root, &f.path)?;
            FileVars { file: Some(t.abs), relative: Some(f.path) }
        }
        None => FileVars::default(),
    };
    let resolved = dap::substitute(&cfg.raw, &folder, &vars).map_err(|e| AppError::validation("launch_config", e))?;
    let fp = dap::fingerprint(&ws.record.id, &cfg.id, &resolved);
    let mut all: BTreeMap<String, BTreeSet<String>> =
        crate::app_state::get(&state.db.lock(), APPROVALS_KEY).ok().flatten().unwrap_or_default();
    let set = all.entry(ws.record.id.clone()).or_default();
    if !set.contains(&fp) {
        if !approve {
            return Ok(StartOutcome::NeedsApproval { config: resolved, adapter: adapter.name });
        }
        if set.len() >= 500 {
            set.pop_first();
        }
        set.insert(fp);
        crate::app_state::set(&state.db.lock(), APPROVALS_KEY, &all)?;
        state.output.info("debug", format!("launch configuration approved: {}", cfg.name));
    }

    let (process, stdout, stderr) = dap::spawn(&adapter, &folder, &label)?;
    let id = state.dap_next.fetch_add(1, Ordering::Relaxed);
    state.output.info(
        "debug",
        format!("[{}] started {} for '{}' (pid {})", adapter.id, adapter.program, cfg.name, process.child.id()),
    );
    state.dap.lock().insert(id, process);

    let app_out = app.clone();
    let label_out = label.clone();
    std::thread::Builder::new()
        .name(format!("dap-{id}-out"))
        .spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            while let Ok(Some(body)) = framing::read_message(&mut reader) {
                let body = String::from_utf8_lossy(&body).into_owned();
                let _ = app_out.emit_to(label_out.as_str(), DAP_MESSAGE, MessageEvent { id, body });
            }
            let st = app_out.state::<AppState>();
            let code =
                st.dap.lock().remove(&id).and_then(|mut p| p.child.try_wait().ok().flatten()).and_then(|s| s.code());
            st.output.info(
                "debug",
                format!("debug adapter {id} exited{}", code.map(|c| format!(" (code {c})")).unwrap_or_default()),
            );
            let _ = app_out.emit_to(label_out.as_str(), DAP_EXIT, ExitEvent { id, code });
        })
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let app_err = app.clone();
    std::thread::Builder::new()
        .name(format!("dap-{id}-err"))
        .spawn(move || {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                app_err.state::<AppState>().output.log(
                    "debug",
                    crate::output::Level::Info,
                    line.chars().take(2000).collect::<String>(),
                );
            }
        })
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StartOutcome::Started {
        id,
        adapter: adapter.name,
        adapter_id: adapter.id,
        request: cfg.request.clone(),
        config: resolved,
    })
}

#[tauri::command]
pub fn dap_send(window: Window, state: State<'_, AppState>, id: u64, message: String) -> AppResult<()> {
    if message.len() > framing::MAX_MESSAGE_BYTES {
        return Err(AppError::validation("too_large", "message too large"));
    }
    let mut map = state.dap.lock();
    let p = map
        .get_mut(&id)
        .filter(|p| p.window == window.label())
        .ok_or_else(|| AppError::NotFound("debug session".into()))?;
    p.send(&message)
}

#[tauri::command]
pub fn dap_stop(window: Window, state: State<'_, AppState>, id: u64) -> AppResult<()> {
    let mut map = state.dap.lock();
    if map.get(&id).is_some_and(|p| p.window == window.label()) {
        map.remove(&id); // dropping the job ends the adapter and the debuggee
    }
    Ok(())
}

/// Forget launch approvals of the current workspace.
#[tauri::command]
pub fn dap_revoke_approvals(window: Window, state: State<'_, AppState>) -> AppResult<()> {
    let ws = service::current(&state, window.label())
        .ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let mut all: BTreeMap<String, BTreeSet<String>> =
        crate::app_state::get(&state.db.lock(), APPROVALS_KEY).ok().flatten().unwrap_or_default();
    if all.remove(&ws.record.id).is_some() {
        crate::app_state::set(&state.db.lock(), APPROVALS_KEY, &all)?;
    }
    Ok(())
}

/// Stop every debug session of a window.
pub fn stop_window(state: &AppState, label: &str) {
    state.dap.lock().retain(|_, p| p.window != label);
}
