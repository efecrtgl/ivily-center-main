//! Terminal commands. Output streams to the webview through a per-terminal IPC channel (raw
//! bytes); input, resize and kill are commands scoped to the calling window.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::terminal::{self, Profile};
use crate::workspace::service;
use serde::Serialize;
use std::io::Read;
use std::sync::atomic::Ordering;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State, Window};

pub const TERMINAL_EXIT: &str = "terminal://exit";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    id: u64,
    code: Option<u32>,
}

fn profiles_for(state: &AppState, label: &str) -> AppResult<Vec<Profile>> {
    let mut list = state.terminal_profiles.lock().clone().unwrap_or_else(|| {
        let p = terminal::detect_profiles(&state.data_dir);
        *state.terminal_profiles.lock() = Some(p.clone());
        p
    });
    let values = service::resolve_settings(state, label)?;
    let user: Vec<String> = values
        .values
        .get("terminal.profiles")
        .and_then(|v| v.value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    list.extend(terminal::user_profiles(&user));
    Ok(list)
}

#[tauri::command]
pub fn terminal_profiles(window: Window, state: State<'_, AppState>, refresh: Option<bool>) -> AppResult<Vec<Profile>> {
    if refresh.unwrap_or(false) {
        *state.terminal_profiles.lock() = None;
    }
    profiles_for(&state, window.label())
}

/// Start a terminal (explicit user action). `root` selects the workspace folder used as working
/// directory; without a workspace the user's home folder is used.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn terminal_create(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    profile: String,
    root: Option<usize>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<u64> {
    let label = window.label().to_string();
    let p = profiles_for(&state, &label)?
        .into_iter()
        .find(|p| p.id == profile)
        .ok_or_else(|| AppError::NotFound(format!("terminal profile {profile}")))?;
    let cwd = match service::current(&state, &label) {
        Some(ws) => {
            let roots = ws.roots();
            roots.get(root.unwrap_or(0)).or(roots.first()).map(|r| r.path.clone())
        }
        None => None,
    }
    .or_else(dirs::home_dir)
    .ok_or_else(|| AppError::Internal("no working directory".into()))?;
    let (session, mut reader) = terminal::spawn(&p, &cwd, cols, rows, &label)?;
    let id = state.terminal_next.fetch_add(1, Ordering::Relaxed);
    state.output.info("app", format!("terminal {id}: started {} in {}", p.name, cwd.display()));
    state.terminals.lock().insert(id, session);

    let app2 = app.clone();
    std::thread::Builder::new()
        .name(format!("terminal-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let st = app2.state::<AppState>();
            let code = st.terminals.lock().remove(&id).and_then(|mut s| s.try_exit_code());
            let _ = app2.emit_to(label.as_str(), TERMINAL_EXIT, ExitEvent { id, code });
        })
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(id)
}

fn with_session<T>(
    state: &AppState,
    label: &str,
    id: u64,
    f: impl FnOnce(&mut terminal::Session) -> AppResult<T>,
) -> AppResult<T> {
    let mut sessions = state.terminals.lock();
    let s = sessions.get_mut(&id).filter(|s| s.window == label).ok_or_else(|| AppError::NotFound("terminal".into()))?;
    f(s)
}

#[tauri::command]
pub fn terminal_write(window: Window, state: State<'_, AppState>, id: u64, data: String) -> AppResult<()> {
    if data.len() > 1024 * 1024 {
        return Err(AppError::validation("too_large", "input too large"));
    }
    with_session(&state, window.label(), id, |s| s.write(data.as_bytes()))
}

#[tauri::command]
pub fn terminal_resize(window: Window, state: State<'_, AppState>, id: u64, cols: u16, rows: u16) -> AppResult<()> {
    with_session(&state, window.label(), id, |s| s.resize(cols, rows))
}

#[tauri::command]
pub fn terminal_kill(window: Window, state: State<'_, AppState>, id: u64) -> AppResult<()> {
    let mut sessions = state.terminals.lock();
    if sessions.get(&id).is_some_and(|s| s.window == window.label()) {
        sessions.remove(&id); // dropping kills the shell and its job (process tree)
    }
    Ok(())
}

/// Close all terminals of a window (workspace changed or window closed).
pub fn kill_window(state: &AppState, label: &str) {
    state.terminals.lock().retain(|_, s| s.window != label);
}
