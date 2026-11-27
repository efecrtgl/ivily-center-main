//! Task commands. Tasks run in a terminal session (visible output, input, kill) after the trust
//! and approval checks in [`task_run`].

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::tasks::{self, LoadIssue, Task};
use crate::terminal::Profile;
use crate::workspace::{service, trust::Capability};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::Ordering;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State, Window};

const APPROVALS_KEY: &str = "tasks.approvals";
const MAX_APPROVALS: usize = 1000;

type Approvals = BTreeMap<String, BTreeSet<String>>;

fn approvals(state: &AppState) -> Approvals {
    crate::app_state::get::<Approvals>(&state.db.lock(), APPROVALS_KEY).ok().flatten().unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    #[serde(flatten)]
    task: Task,
    command: String,
    approved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    tasks: Vec<TaskInfo>,
    issues: Vec<LoadIssue>,
    can_run: bool,
}

fn load(state: &AppState, label: &str) -> AppResult<(String, Vec<Task>, Vec<LoadIssue>)> {
    let ws =
        service::current(state, label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let (t, i) = tasks::discover(&ws.roots());
    Ok((ws.record.id.clone(), t, i))
}

/// List tasks (reading definition files only; nothing runs).
#[tauri::command]
pub fn tasks_list(window: Window, state: State<'_, AppState>) -> AppResult<TaskList> {
    let (ws_id, list, issues) = load(&state, window.label())?;
    let approved = approvals(&state).remove(&ws_id).unwrap_or_default();
    let can_run = service::require_capability(&state, window.label(), Capability::TaskExecution).is_ok();
    Ok(TaskList {
        tasks: list
            .into_iter()
            .map(|t| TaskInfo { command: t.display(), approved: approved.contains(&t.fingerprint(&ws_id)), task: t })
            .collect(),
        issues,
        can_run,
    })
}

/// Start one task (not its dependencies — the UI runs the plan in order). Requires the
/// `taskExecution` capability and, unless already approved, `approve: true` from an explicit
/// user confirmation of the displayed command. Returns the terminal id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn task_run(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    id: String,
    approve: bool,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<u64> {
    let label = window.label().to_string();
    service::require_capability(&state, &label, Capability::TaskExecution)?;
    let ws =
        service::current(&state, &label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let (ws_id, list, _) = load(&state, &label)?;
    let task = list.iter().find(|t| t.id == id).ok_or_else(|| AppError::NotFound(format!("task {id}")))?;
    if let Some(e) = &task.error {
        return Err(AppError::validation("task_invalid", e.clone()));
    }
    let exec = task.exec.as_ref().ok_or_else(|| AppError::validation("task_composite", "the task has no command"))?;
    let fp = task.fingerprint(&ws_id);
    let mut all = approvals(&state);
    let set = all.entry(ws_id.clone()).or_default();
    if !set.contains(&fp) {
        if !approve {
            return Err(AppError::validation("task_needs_approval", "this task's command has not been approved yet"));
        }
        if set.len() >= MAX_APPROVALS {
            set.pop_first();
        }
        set.insert(fp);
        crate::app_state::set(&state.db.lock(), APPROVALS_KEY, &all)?;
        state.output.info("workspace", format!("task approved: {} ({})", task.label, task.display()));
    }
    let shell_setting = service::resolve_settings(&state, &label)?
        .values
        .get("tasks.shell")
        .and_then(|v| v.value.as_str().map(String::from))
        .unwrap_or_else(|| "auto".into());
    let (program, args) = tasks::command_for(exec, tasks::shell_from_setting(&shell_setting))?;
    let root = ws.roots().get(task.root).cloned().ok_or_else(|| AppError::NotFound("workspace folder".into()))?;
    // Re-validate the working directory at run time (it may have changed since listing).
    let rel = tasks::resolve_cwd(&root.path, Some(&task.cwd).filter(|c| !c.is_empty()).map(String::as_str))
        .map_err(|e| AppError::validation("task_cwd", e))?;
    let cwd = if rel.is_empty() { root.path.clone() } else { root.path.join(rel) };
    let profile = Profile {
        id: "task".into(),
        name: task.label.clone(),
        path: program.to_string_lossy().into_owned(),
        args,
        source: "task",
        icon: "terminal",
    };
    let (session, reader) = crate::terminal::spawn(&profile, &cwd, cols, rows, &label)?;
    let tid = state.terminal_next.fetch_add(1, Ordering::Relaxed);
    state.output.info("app", format!("task {}: started in terminal {tid}: {}", task.label, task.display()));
    state.terminals.lock().insert(tid, session);
    super::terminal::pump(app, label, tid, reader, on_data)?;
    Ok(tid)
}

/// Forget all task approvals of the current workspace.
#[tauri::command]
pub fn tasks_revoke_approvals(window: Window, state: State<'_, AppState>) -> AppResult<()> {
    let ws = service::current(&state, window.label())
        .ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let mut all = approvals(&state);
    if all.remove(&ws.record.id).is_some() {
        crate::app_state::set(&state.db.lock(), APPROVALS_KEY, &all)?;
    }
    state.output.info("workspace", "task approvals revoked for this workspace");
    Ok(())
}
