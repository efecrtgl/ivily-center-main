//! Workspace orchestration over [`AppState`], independent of Tauri (integration-tested below).
//!
//! Every function takes the calling window's label; the workspace is always resolved from it.
//! Lock order: `workspaces` is never held while `db` is locked (values are cloned out first).

use super::file::{self, WriteMode};
use super::paths::{has_workspace_ext, normalize_dir, normalize_new_workspace_file, NormalizedPath};
use super::trust::{self, Capability, Decision, WorkspaceTrust, ALL_CAPABILITIES};
use super::{session, Kind, OpenWorkspace, WorkspaceFolder, WorkspaceRecord};
use crate::error::{AppError, AppResult};
use crate::settings::{self, ResolvedSettings, Scope, WorkspaceLayer};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub record: WorkspaceRecord,
    pub folders: Vec<WorkspaceFolder>,
    /// Path of the workspace file, for file workspaces.
    pub file: Option<String>,
    pub trust: WorkspaceTrust,
}

pub fn current(state: &AppState, label: &str) -> Option<OpenWorkspace> {
    state.workspaces.lock().get(label).cloned()
}

fn require_current(state: &AppState, label: &str) -> AppResult<OpenWorkspace> {
    current(state, label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open in this window"))
}

pub fn trust_of(state: &AppState, ws: &OpenWorkspace) -> AppResult<WorkspaceTrust> {
    let stored = trust::list(&state.db.lock())?;
    let session = state.session_trust.lock().clone();
    Ok(trust::evaluate(&stored, &session, &ws.roots()))
}

/// Gate for future subsystems: fails with `workspace_untrusted` unless the window's workspace
/// grants `capability`. No workspace open → nothing to execute → refused as well.
pub fn require_capability(state: &AppState, label: &str, capability: Capability) -> AppResult<()> {
    let ws = require_current(state, label)?;
    trust::require(&trust_of(state, &ws)?, capability)
}

pub fn info(state: &AppState, ws: &OpenWorkspace) -> AppResult<WorkspaceInfo> {
    Ok(WorkspaceInfo {
        record: ws.record.clone(),
        folders: ws.folders.clone(),
        file: ws.file.as_ref().map(|f| f.path.display().to_string()),
        trust: trust_of(state, ws)?,
    })
}

/// Make `ws` the window's workspace (replacing any previous one) and remember it for restore.
fn activate(state: &AppState, label: &str, ws: OpenWorkspace) -> AppResult<WorkspaceInfo> {
    // One window per workspace: a second window would share files, terminals and sessions.
    if let Some((other, _)) =
        state.workspaces.lock().iter().find(|(l, w)| l.as_str() != label && w.record.id == ws.record.id)
    {
        return Err(AppError::validation("workspace_open_elsewhere", other.clone()));
    }
    // The main window's workspace is the one restored at the next start.
    if label == "main" {
        session::set_last_workspace(&state.db.lock(), Some(&ws.record.id))?;
    }
    let missing = ws.folders.iter().filter(|f| !f.available).count();
    state.output.info(
        "workspace",
        format!(
            "opened '{}' ({:?}, {} folder(s){})",
            ws.record.name,
            ws.record.kind,
            ws.folders.len(),
            if missing > 0 { format!(", {missing} unavailable") } else { String::new() }
        ),
    );
    let info = info(state, &ws)?;
    state.workspaces.lock().insert(label.to_string(), ws);
    state.workspace_changed(label);
    Ok(info)
}

pub fn open_path(state: &AppState, label: &str, path: &Path) -> AppResult<WorkspaceInfo> {
    let ws = {
        let db = state.db.lock();
        if path.is_file() || has_workspace_ext(path) {
            super::open_file(&db, path)?
        } else {
            super::open_folder(&db, path)?
        }
    };
    activate(state, label, ws)
}

pub fn open_record(state: &AppState, label: &str, id: &str) -> AppResult<WorkspaceInfo> {
    let ws = super::open_record(&state.db.lock(), id)?;
    activate(state, label, ws)
}

pub fn close(state: &AppState, label: &str) -> AppResult<()> {
    let closed = state.workspaces.lock().remove(label);
    if let Some(ws) = closed {
        state.output.info("workspace", format!("closed '{}'", ws.record.name));
        state.workspace_changed(label);
    }
    if label == "main" {
        session::set_last_workspace(&state.db.lock(), None)?;
    }
    Ok(())
}

/// A window was destroyed: release its workspace and stop its processes (no restore change).
pub fn window_destroyed(state: &AppState, label: &str) {
    if state.workspaces.lock().remove(label).is_some() || label != "main" {
        state.workspace_changed(label);
    }
    state.file_index.lock().remove(label);
}

pub fn remove(state: &AppState, id: &str) -> AppResult<()> {
    if state.workspaces.lock().values().any(|w| w.record.id == id) {
        return Err(AppError::Conflict("close the workspace before removing it from the list".into()));
    }
    super::remove(&mut state.db.lock(), id)?;
    let db = state.db.lock();
    if session::last_workspace(&db)?.as_deref() == Some(id) {
        session::set_last_workspace(&db, None)?;
    }
    Ok(())
}

pub fn relocate(state: &AppState, id: &str, new_location: &Path) -> AppResult<WorkspaceRecord> {
    if state.workspaces.lock().values().any(|w| w.record.id == id) {
        return Err(AppError::Conflict("close the workspace before changing its location".into()));
    }
    let db = state.db.lock();
    let record = super::get(&db, id)?;
    let n = match record.kind {
        Kind::Folder => normalize_dir(new_location)?,
        Kind::File => super::paths::normalize_workspace_file(new_location)?,
    };
    super::relocate(&db, id, &n)
}

// ── Settings ────────────────────────────────────────────────────────────────

fn with_layer<T>(
    state: &AppState,
    ws: Option<&OpenWorkspace>,
    f: impl FnOnce(&WorkspaceLayer<'_>) -> AppResult<T>,
) -> AppResult<T> {
    match ws {
        None => f(&WorkspaceLayer::None),
        Some(w) => match &w.file {
            Some(file) => f(&WorkspaceLayer::Values(&file.content.settings)),
            None => f(&WorkspaceLayer::Db(&w.record.id)),
        },
    }
    .map_err(|e| {
        if let AppError::Database(_) = e {
            state.output.error("settings", e.to_string());
        }
        e
    })
}

pub fn resolve_settings(state: &AppState, label: &str) -> AppResult<ResolvedSettings> {
    let ws = current(state, label);
    let r = with_layer(state, ws.as_ref(), |layer| settings::resolve(&state.db.lock(), layer))?;
    for inv in r.invalid.iter().filter(|i| i.scope == "workspace") {
        state.output.warn("settings", format!("ignored invalid workspace value for {}", inv.key));
    }
    Ok(r)
}

/// Workspace-layer values as a JSON object (only keys valid for workspace scope).
pub fn workspace_settings_map(state: &AppState, ws: &OpenWorkspace) -> AppResult<Map<String, Value>> {
    let raw = with_layer(state, Some(ws), |layer| settings::workspace_layer_raw(&state.db.lock(), layer))?;
    Ok(raw
        .into_iter()
        .filter_map(|(k, v)| {
            let v: Value = serde_json::from_str(&v).ok()?;
            settings::validate_workspace_value(&k, &v).ok().map(|v| (k, v))
        })
        .collect())
}

/// Write the settings of a file workspace (explicit user change). Fails with `conflict` if the
/// file changed on disk since it was read; nothing is written in that case.
fn write_file_settings(
    state: &AppState,
    label: &str,
    ws: &OpenWorkspace,
    settings_map: Map<String, Value>,
) -> AppResult<()> {
    let loaded = ws.file.as_ref().ok_or_else(|| AppError::Internal("not a file workspace".into()))?;
    let mut content = loaded.content.clone();
    content.settings = settings_map;
    let bytes = file::serialize(&content)?;
    let hash = file::write_atomic(&loaded.path, &bytes, WriteMode::Update { expected_hash: &loaded.hash })?;
    if let Some(w) = state.workspaces.lock().get_mut(label) {
        if let Some(f) = w.file.as_mut() {
            f.content = content;
            f.hash = hash;
        }
    }
    state.output.info("workspace", format!("saved workspace settings to {}", loaded.path.display()));
    Ok(())
}

pub fn set_workspace_setting(state: &AppState, label: &str, key: &str, value: &Value) -> AppResult<Value> {
    let ws = require_current(state, label)?;
    match &ws.file {
        None => settings::set(&state.db.lock(), &Scope::Workspace(ws.record.id.clone()), key, value),
        Some(f) => {
            let v = settings::validate_workspace_value(key, value)?;
            let mut map = f.content.settings.clone();
            map.insert(key.to_string(), v.clone());
            write_file_settings(state, label, &ws, map)?;
            Ok(v)
        }
    }
}

pub fn reset_workspace_setting(state: &AppState, label: &str, key: &str) -> AppResult<()> {
    let ws = require_current(state, label)?;
    settings::check_workspace_key(key)?;
    match &ws.file {
        None => settings::reset(&state.db.lock(), &Scope::Workspace(ws.record.id.clone()), key),
        Some(f) => {
            if !f.content.settings.contains_key(key) {
                return Ok(());
            }
            let mut map = f.content.settings.clone();
            map.remove(key);
            write_file_settings(state, label, &ws, map)
        }
    }
}

/// Re-read the workspace file from disk (after an external change or a write conflict).
pub fn reload_file(state: &AppState, label: &str) -> AppResult<WorkspaceInfo> {
    let ws = require_current(state, label)?;
    let path = ws
        .file
        .as_ref()
        .map(|f| f.path.clone())
        .ok_or_else(|| AppError::validation("not_a_file_workspace", "this workspace has no workspace file"))?;
    let reopened = super::open_file(&state.db.lock(), &path)?;
    if reopened.record.id != ws.record.id {
        return Err(AppError::Internal("workspace identity changed while reloading".into()));
    }
    activate(state, label, reopened)
}

// ── Workspace files ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SaveOutcome {
    Saved {
        workspace: WorkspaceInfo,
    },
    /// The target exists; the UI must ask before replacing it (token from `PathGrants`).
    ConfirmOverwrite {
        token: String,
        path: String,
    },
}

/// Save the open workspace as a `*.ivily-workspace` file at `target` and switch the window to it.
/// Never overwrites an existing file unless `overwrite_confirmed`.
pub fn save_as(state: &AppState, label: &str, target: &Path, overwrite_confirmed: bool) -> AppResult<SaveOutcome> {
    let ws = require_current(state, label)?;
    let target = normalize_new_workspace_file(target)?;
    if target.path.exists() && !overwrite_confirmed {
        let token = state.grants.insert(super::grants::GrantKind::SaveTarget, target.path.clone());
        return Ok(SaveOutcome::ConfirmOverwrite { token, path: target.display() });
    }
    if target.path.is_dir() {
        return Err(AppError::validation("not_a_file", "a folder exists at that location"));
    }
    let dir = target.path.parent().map(Path::to_path_buf).unwrap_or_default();
    let content = super::to_file_content(&ws, &dir, workspace_settings_map(state, &ws)?);
    let mode = if overwrite_confirmed { WriteMode::ReplaceConfirmed } else { WriteMode::CreateNew };
    file::write_atomic(&target.path, &file::serialize(&content)?, mode)?;
    state.output.info("workspace", format!("workspace file written: {}", target.display()));

    let opened = super::open_file(&state.db.lock(), &target.path)?;
    if opened.record.id != ws.record.id {
        session::copy(&state.db.lock(), &ws.record.id, &opened.record.id)?;
    }
    Ok(SaveOutcome::Saved { workspace: activate(state, label, opened)? })
}

// ── Trust ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrustScope {
    /// Exactly the workspace folder(s).
    Folder,
    /// The parent of each workspace folder, including everything below it.
    Parent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRequest {
    pub scope: TrustScope,
    /// `None` = all capabilities.
    #[serde(default)]
    pub capabilities: Option<Vec<Capability>>,
    /// `false` = this session only.
    pub remember: bool,
}

fn targets(ws: &OpenWorkspace, scope: TrustScope) -> AppResult<Vec<(NormalizedPath, bool)>> {
    let roots = ws.roots();
    if roots.is_empty() {
        return Err(AppError::validation("no_folders", "the workspace has no available folders"));
    }
    roots
        .into_iter()
        .map(|r| match scope {
            TrustScope::Folder => Ok((r, false)),
            TrustScope::Parent => {
                let parent = r.path.parent().ok_or_else(|| {
                    AppError::validation("trust_too_broad", "a drive root has no parent folder to trust")
                })?;
                Ok((normalize_dir(parent)?, true))
            }
        })
        .collect()
}

pub fn grant_trust(state: &AppState, label: &str, req: &GrantRequest) -> AppResult<WorkspaceTrust> {
    let ws = require_current(state, label)?;
    let caps: BTreeSet<Capability> = match &req.capabilities {
        Some(list) if list.is_empty() => {
            return Err(AppError::validation("no_capabilities", "choose at least one capability"))
        }
        Some(list) => list.iter().copied().collect(),
        None => ALL_CAPABILITIES.into_iter().collect(),
    };
    for (target, children) in targets(&ws, req.scope)? {
        if req.remember {
            trust::store(&state.db.lock(), &target, Decision::Trusted, children, &caps)?;
        } else {
            let rec = trust::session_record(&target, children, &caps)?;
            let mut session = state.session_trust.lock();
            session.retain(|r| r.path_key != rec.path_key);
            session.push(rec);
        }
        state.output.info(
            "workspace",
            format!(
                "trust granted ({}, {}) for {}: {}",
                if req.remember { "remembered" } else { "this session" },
                if children { "including subfolders" } else { "folder only" },
                target.display(),
                caps.iter().map(|c| c.id()).collect::<Vec<_>>().join(", ")
            ),
        );
    }
    trust_of(state, &ws)
}

/// "Stay restricted": remember a denial for the undecided folders, so the user is not asked again.
pub fn deny_trust(state: &AppState, label: &str) -> AppResult<WorkspaceTrust> {
    let ws = require_current(state, label)?;
    let current = trust_of(state, &ws)?;
    for f in current.folders.iter().filter(|f| f.decision.is_none()) {
        if let Some(root) = ws.roots().into_iter().find(|r| r.key == f.path_key) {
            trust::store(&state.db.lock(), &root, Decision::Denied, false, &BTreeSet::new())?;
            state.output.info("workspace", format!("{} will stay restricted", root.display()));
        }
    }
    trust_of(state, &ws)
}

pub fn list_trust(state: &AppState) -> AppResult<Vec<trust::TrustRecord>> {
    let mut all = trust::list(&state.db.lock())?;
    all.extend(state.session_trust.lock().iter().cloned());
    Ok(all)
}

/// Revoke a stored or session decision for a path key.
pub fn revoke_trust(state: &AppState, path_key: &str) -> AppResult<()> {
    if path_key.is_empty() || path_key.len() > 4096 {
        return Err(AppError::validation("invalid_path", "invalid path key"));
    }
    let stored = trust::revoke(&state.db.lock(), path_key)?;
    let mut session = state.session_trust.lock();
    let before = session.len();
    session.retain(|r| r.path_key != path_key);
    if !stored && session.len() == before {
        return Err(AppError::NotFound("no trust decision for that folder".into()));
    }
    state.output.info("workspace", format!("trust decision revoked for {path_key}"));
    Ok(())
}

// ── Sessions & startup ──────────────────────────────────────────────────────

pub fn save_session(state: &AppState, label: &str, value: &Value) -> AppResult<()> {
    let ws = require_current(state, label)?;
    session::save(&state.db.lock(), &ws.record.id, value)
}

pub fn load_session(state: &AppState, label: &str) -> AppResult<session::LoadedSession> {
    let ws = require_current(state, label)?;
    let loaded = session::load(&state.db.lock(), &ws.record.id)?;
    if loaded.recovered {
        state.output.warn("workspace", "the latest session state was unreadable; the previous one was restored");
    }
    Ok(loaded)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupResult {
    /// `workspace` (one was opened), `launcher` or `welcome`.
    pub show: &'static str,
    pub workspace: Option<WorkspaceInfo>,
    pub health: session::StartupHealth,
    /// Why a requested/remembered workspace could not be opened.
    pub problem: Option<String>,
}

/// Decide and perform the startup action. Runs once per process; later calls (e.g. a reloaded
/// webview) report the window's current workspace instead of re-running the plan.
pub fn startup(state: &AppState, label: &str, startup_setting: &str) -> AppResult<StartupResult> {
    let health = state.startup_health;
    {
        let mut done = state.startup_done.lock();
        if *done {
            let ws = current(state, label);
            return Ok(StartupResult {
                show: if ws.is_some() { "workspace" } else { "launcher" },
                workspace: ws.map(|w| info(state, &w)).transpose()?,
                health,
                problem: None,
            });
        }
        *done = true;
    }
    let cli = state.cli_path.lock().take();
    let last = session::last_workspace(&state.db.lock())?;
    let plan = session::plan(startup_setting, cli, last, health);
    let attempt = match &plan {
        session::StartupPlan::OpenPath(p) => Some(open_path(state, label, p)),
        session::StartupPlan::Restore(id) => Some(open_record(state, label, id)),
        _ => None,
    };
    Ok(match attempt {
        Some(Ok(ws)) => StartupResult { show: "workspace", workspace: Some(ws), health, problem: None },
        Some(Err(e)) => {
            state.output.warn("workspace", format!("startup workspace could not be opened: {e}"));
            StartupResult { show: "launcher", workspace: None, health, problem: Some(e.to_string()) }
        }
        None => StartupResult {
            show: if plan == session::StartupPlan::Welcome { "welcome" } else { "launcher" },
            workspace: None,
            health,
            problem: None,
        },
    })
}

/// First non-flag command-line argument that exists (folder or workspace file).
pub fn cli_path<I: IntoIterator<Item = String>>(args: I) -> Option<PathBuf> {
    args.into_iter().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from).find(|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const W: &str = "main";

    fn state() -> (tempfile::TempDir, AppState) {
        let data = tempfile::tempdir().unwrap();
        let s = AppState::init_in(data.path(), None);
        (data, s)
    }

    #[test]
    fn one_window_per_workspace_and_only_main_sets_the_restore_target() {
        let (_d, s) = state();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let wa = open_path(&s, W, a.path()).unwrap();
        let e = open_record(&s, "w-1", &wa.record.id).unwrap_err();
        assert_eq!(e.code(), "workspace_open_elsewhere");
        assert_eq!(e.to_string(), "main");
        let wb = open_path(&s, "w-1", b.path()).unwrap();
        assert_eq!(session::last_workspace(&s.db.lock()).unwrap().as_deref(), Some(wa.record.id.as_str()));
        window_destroyed(&s, "w-1");
        assert!(current(&s, "w-1").is_none());
        // Once released, the workspace can be opened in another window.
        open_record(&s, "w-2", &wb.record.id).unwrap();
        close(&s, "w-2").unwrap();
        assert_eq!(session::last_workspace(&s.db.lock()).unwrap().as_deref(), Some(wa.record.id.as_str()));
    }

    #[test]
    fn open_switch_and_close_without_leaking_state() {
        let (_d, s) = state();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let wa = open_path(&s, W, a.path()).unwrap();
        set_workspace_setting(&s, W, "appearance.theme", &json!("pixel-dark")).unwrap();
        save_session(&s, W, &json!({ "layout": { "panelVisible": true } })).unwrap();
        assert_eq!(resolve_settings(&s, W).unwrap().values["appearance.theme"].value, json!("pixel-dark"));

        let wb = open_path(&s, W, b.path()).unwrap();
        assert_ne!(wa.record.id, wb.record.id);
        assert_eq!(resolve_settings(&s, W).unwrap().values["appearance.theme"].value, json!("modern-dark"));
        assert_eq!(load_session(&s, W).unwrap().state, None, "B must not see A's session");

        open_record(&s, W, &wa.record.id).unwrap();
        assert_eq!(resolve_settings(&s, W).unwrap().values["appearance.theme"].value, json!("pixel-dark"));
        assert_eq!(load_session(&s, W).unwrap().state, Some(json!({ "layout": { "panelVisible": true } })));

        close(&s, W).unwrap();
        assert!(current(&s, W).is_none());
        assert!(set_workspace_setting(&s, W, "appearance.theme", &json!("glass")).is_err());
        assert!(save_session(&s, W, &json!({})).is_err());
        assert_eq!(resolve_settings(&s, W).unwrap().values["appearance.theme"].value, json!("modern-dark"));
    }

    #[test]
    fn workspaces_are_isolated_per_window() {
        let (_d, s) = state();
        let a = tempfile::tempdir().unwrap();
        open_path(&s, "main", a.path()).unwrap();
        assert!(current(&s, "other").is_none());
        assert!(save_session(&s, "other", &json!({})).is_err());
    }

    #[test]
    fn trust_flow_and_capability_gate() {
        let (_d, s) = state();
        let a = tempfile::tempdir().unwrap();
        let info = open_path(&s, W, a.path()).unwrap();
        assert!(info.trust.needs_decision);
        assert!(matches!(require_capability(&s, W, Capability::TaskExecution), Err(AppError::Untrusted(_))));

        // Session-only, granular grant.
        let t = grant_trust(
            &s,
            W,
            &GrantRequest {
                scope: TrustScope::Folder,
                capabilities: Some(vec![Capability::LanguageServers]),
                remember: false,
            },
        )
        .unwrap();
        assert_eq!(t.level, trust::Level::Partial);
        assert!(require_capability(&s, W, Capability::LanguageServers).is_ok());
        assert!(require_capability(&s, W, Capability::TaskExecution).is_err());
        assert!(trust::list(&s.db.lock()).unwrap().is_empty(), "session grants are not stored");

        // Remembered full grant, then revoke.
        grant_trust(&s, W, &GrantRequest { scope: TrustScope::Folder, capabilities: None, remember: true }).unwrap();
        let key = normalize_dir(a.path()).unwrap().key;
        revoke_trust(&s, &key).unwrap();
        assert!(require_capability(&s, W, Capability::TaskExecution).is_err());
        assert!(revoke_trust(&s, &key).is_err());

        // Denial is remembered and means "do not ask again".
        let t = deny_trust(&s, W).unwrap();
        assert!(!t.needs_decision);
        assert_eq!(t.level, trust::Level::Restricted);
        assert!(grant_trust(
            &s,
            W,
            &GrantRequest { scope: TrustScope::Folder, capabilities: Some(vec![]), remember: true }
        )
        .is_err());
    }

    #[test]
    fn parent_trust_covers_sibling_projects() {
        let (_d, s) = state();
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("one")).unwrap();
        std::fs::create_dir(root.path().join("two")).unwrap();
        open_path(&s, W, &root.path().join("one")).unwrap();
        grant_trust(&s, W, &GrantRequest { scope: TrustScope::Parent, capabilities: None, remember: true }).unwrap();
        let two = open_path(&s, W, &root.path().join("two")).unwrap();
        assert_eq!(two.trust.level, trust::Level::Trusted);
    }

    #[test]
    fn save_as_creates_never_overwrites_and_switches() {
        let (_d, s) = state();
        let a = tempfile::tempdir().unwrap();
        let folder_ws = open_path(&s, W, a.path()).unwrap();
        set_workspace_setting(&s, W, "appearance.theme", &json!("glass")).unwrap();
        save_session(&s, W, &json!({ "layout": { "sidebarWidth": 300 } })).unwrap();

        let target = a.path().join("app.ivily-workspace");
        let saved = match save_as(&s, W, &target, false).unwrap() {
            SaveOutcome::Saved { workspace } => workspace,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(saved.record.kind, Kind::File);
        assert_ne!(saved.record.id, folder_ws.record.id);
        let written = file::parse(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(written.folders[0].path, ".");
        assert_eq!(written.settings["appearance.theme"], "glass");
        assert_eq!(
            load_session(&s, W).unwrap().state,
            Some(json!({ "layout": { "sidebarWidth": 300 } })),
            "session carried over"
        );

        // Existing target → confirmation token, file untouched.
        std::fs::write(a.path().join("other.ivily-workspace"), "precious").unwrap();
        let token = match save_as(&s, W, &a.path().join("other.ivily-workspace"), false).unwrap() {
            SaveOutcome::ConfirmOverwrite { token, .. } => token,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(std::fs::read_to_string(a.path().join("other.ivily-workspace")).unwrap(), "precious");
        let confirmed = s.grants.take(&token, super::super::grants::GrantKind::SaveTarget).unwrap();
        assert!(matches!(save_as(&s, W, &confirmed, true).unwrap(), SaveOutcome::Saved { .. }));
    }

    #[test]
    fn file_settings_are_written_explicitly_and_conflicts_detected() {
        let (_d, s) = state();
        let a = tempfile::tempdir().unwrap();
        let f = a.path().join("w.ivily-workspace");
        std::fs::write(&f, r#"{ "ivilyWorkspace": 1, "folders": [{ "path": "." }], "custom": true }"#).unwrap();
        open_path(&s, W, &f).unwrap();
        set_workspace_setting(&s, W, "appearance.theme", &json!("retro-terminal")).unwrap();
        let content = file::parse(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(content.settings["appearance.theme"], "retro-terminal");
        assert_eq!(content.extra["custom"], true, "unknown fields preserved");

        // External edit → conflict, file untouched; reload picks up the new content.
        std::fs::write(
            &f,
            r#"{ "ivilyWorkspace": 1, "folders": [{ "path": "." }], "settings": { "appearance.theme": "glass" } }"#,
        )
        .unwrap();
        assert!(matches!(
            set_workspace_setting(&s, W, "appearance.theme", &json!("pixel-dark")),
            Err(AppError::Conflict(_))
        ));
        assert!(std::fs::read_to_string(&f).unwrap().contains("glass"));
        reload_file(&s, W).unwrap();
        assert_eq!(resolve_settings(&s, W).unwrap().values["appearance.theme"].value, json!("glass"));
        reset_workspace_setting(&s, W, "appearance.theme").unwrap();
        assert!(!file::parse(&std::fs::read(&f).unwrap()).unwrap().settings.contains_key("appearance.theme"));
        // User-only settings cannot be written into the workspace.
        assert!(set_workspace_setting(&s, W, "appearance.uiFontSize", &json!(14)).is_err());
    }

    #[test]
    fn startup_restores_last_workspace_or_falls_back() {
        let data = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let id = {
            let s = AppState::init_in(data.path(), None);
            let id = open_path(&s, W, a.path()).unwrap().record.id;
            session::mark_ready(&s.db.lock()).unwrap();
            session::mark_clean_exit(&s.db.lock()).unwrap();
            id
        };
        let s = AppState::init_in(data.path(), None);
        let r = startup(&s, W, "lastWorkspace").unwrap();
        assert_eq!(r.show, "workspace");
        assert_eq!(r.workspace.unwrap().record.id, id);
        // Second call (webview reload) does not re-run the plan.
        assert_eq!(startup(&s, W, "launcher").unwrap().show, "workspace");
        drop(s);

        // The folder disappeared: launcher with a problem, record kept for "Locate…".
        let path = a.path().to_path_buf();
        drop(a);
        assert!(!path.exists());
        let s = AppState::init_in(data.path(), None);
        let r = startup(&s, W, "lastWorkspace").unwrap();
        assert_eq!(r.show, "launcher");
        assert!(r.problem.is_some());
        assert_eq!(super::super::list(&s.db.lock()).unwrap().len(), 1);
    }

    #[test]
    fn startup_opens_cli_path_and_respects_launcher_setting() {
        let data = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let s = AppState::init_in(data.path(), Some(a.path().to_path_buf()));
        assert_eq!(startup(&s, W, "launcher").unwrap().show, "workspace");
        let data2 = tempfile::tempdir().unwrap();
        let s2 = AppState::init_in(data2.path(), None);
        assert_eq!(startup(&s2, W, "welcome").unwrap().show, "welcome");
        assert_eq!(
            cli_path(vec!["exe".into(), "--flag".into(), a.path().display().to_string()]),
            Some(a.path().to_path_buf())
        );
        assert_eq!(cli_path(vec!["exe".into(), r"C:\definitely\missing\dir".into()]), None);
    }

    #[test]
    fn removal_is_refused_while_open() {
        let (_d, s) = state();
        let a = tempfile::tempdir().unwrap();
        let id = open_path(&s, W, a.path()).unwrap().record.id;
        assert!(remove(&s, &id).is_err());
        assert!(relocate(&s, &id, a.path()).is_err());
        close(&s, W).unwrap();
        remove(&s, &id).unwrap();
    }
}
