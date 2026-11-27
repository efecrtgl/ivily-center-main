//! Workspace filesystem: scoped path resolution, lazy listing, safe operations and watching.
//! Every entry point resolves paths against the calling window's workspace roots.

pub mod list;
pub mod ops;
pub mod scope;
pub mod watch;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::workspace::service;
use scope::Target;

/// Resolve a `(root, rel)` pair in the window's workspace.
pub fn target(state: &AppState, label: &str, root: usize, rel: &str) -> AppResult<Target> {
    let ws =
        service::current(state, label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    scope::resolve(&ws.roots(), root, rel)
}

pub fn list_options(state: &AppState, label: &str) -> AppResult<list::ListOptions> {
    Ok(list::ListOptions::from_settings(&service::resolve_settings(state, label)?))
}
