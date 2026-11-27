//! Process-wide application state managed by Tauri.

use crate::core::{data_dir, Severity, StartupIssue};
use crate::db::{self, DbHealth};
use crate::output::OutputHub;
use crate::settings::{self, WorkspaceLayer};
use crate::workspace::grants::PathGrants;
use crate::workspace::session::{self, StartupHealth};
use crate::workspace::trust::TrustRecord;
use crate::workspace::OpenWorkspace;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Callback receiving a window label.
pub type WorkspaceHook = Box<dyn Fn(&str) + Send + Sync>;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub db_health: DbHealth,
    pub output: Arc<OutputHub>,
    pub startup_issues: Vec<StartupIssue>,
    pub data_dir: PathBuf,
    /// Last normal (not maximized/minimized) bounds of the main window.
    pub window_normal: Mutex<Option<crate::window::Bounds>>,
    /// The workspace open in each window, keyed by window label. All workspace-scoped commands
    /// resolve their workspace from the *calling* window, never from a UI-supplied id.
    pub workspaces: Mutex<HashMap<String, OpenWorkspace>>,
    /// Trust granted "for this session only" (never written to disk).
    pub session_trust: Mutex<Vec<TrustRecord>>,
    pub grants: PathGrants,
    pub startup_health: StartupHealth,
    /// Folder or workspace file passed on the command line (consumed by the first startup call).
    pub cli_path: Mutex<Option<PathBuf>>,
    pub startup_done: Mutex<bool>,
    /// File watchers per window (replaced whenever the window's workspace changes).
    pub watchers: Mutex<HashMap<String, crate::fs::watch::WatchHandle>>,
    /// Called with a window label whenever that window's workspace changes (opened, switched,
    /// closed, reloaded). Set once by the Tauri layer to restart per-workspace services.
    pub workspace_hook: std::sync::OnceLock<WorkspaceHook>,
    /// Last toolchain detection (tools, timestamp).
    pub toolchain_cache: Mutex<Option<(Vec<crate::toolchains::Tool>, i64)>>,
    /// Running language servers by instance id.
    pub lsp: Mutex<HashMap<u64, crate::lsp::ServerProcess>>,
    pub lsp_next: std::sync::atomic::AtomicU64,
    pub terminals: Mutex<HashMap<u64, crate::terminal::Session>>,
    pub terminal_next: std::sync::atomic::AtomicU64,
    pub terminal_profiles: Mutex<Option<Vec<crate::terminal::Profile>>>,
}

impl AppState {
    pub fn workspace_changed(&self, label: &str) {
        if let Some(hook) = self.workspace_hook.get() {
            hook(label);
        }
    }
}

impl AppState {
    pub fn init(cli_path: Option<PathBuf>) -> Self {
        Self::init_in(&data_dir(), cli_path)
    }

    pub fn init_in(dir: &Path, cli_path: Option<PathBuf>) -> Self {
        let output = Arc::new(OutputHub::new());
        output.register("workspace", "Workspace").expect("valid channel id");
        output.register("lsp", "Language Servers").expect("valid channel id");
        output.register("git", "Git").expect("valid channel id");
        output.info("app", format!("{} {} starting", crate::APP_NAME, crate::APP_VERSION));

        let opened = db::open_app_db(dir);
        let mut issues = opened.issues;
        for i in &issues {
            output.log("database", level_of(i), &i.message);
        }
        output.info("database", format!("schema {} ({:?})", opened.health.schema_version, opened.health.mode));

        match settings::migrate_keys(&opened.conn, settings::schema::RENAMED) {
            Ok(n) if n > 0 => output.info("settings", format!("migrated {n} renamed setting(s)")),
            Ok(_) => {}
            Err(e) => output.error("settings", format!("setting key migration failed: {e}")),
        }
        match settings::resolve(&opened.conn, &WorkspaceLayer::None) {
            Ok(r) => {
                for inv in &r.invalid {
                    output.warn(
                        "settings",
                        format!("ignored invalid stored value for {} ({} scope)", inv.key, inv.scope),
                    );
                }
                if let Some(cap) = r.values.get("output.maxLinesPerChannel").and_then(|v| v.value.as_u64()) {
                    output.set_capacity(cap as usize);
                }
            }
            Err(e) => {
                output.error("settings", format!("could not load settings: {e}"));
                issues.push(StartupIssue::new(
                    Severity::Error,
                    "settings_unavailable",
                    "Settings could not be loaded; defaults are used.",
                ));
            }
        }

        let startup_health = session::begin_run(&opened.conn).unwrap_or_else(|e| {
            output.error("workspace", format!("could not record startup: {e}"));
            StartupHealth { previous_crashed: false, safe_mode: false }
        });
        if startup_health.safe_mode {
            output.warn("workspace", "previous starts did not complete; safe mode: the last workspace is not restored");
        } else if startup_health.previous_crashed {
            output.warn("workspace", "the previous session did not shut down cleanly");
        }

        Self {
            db: Mutex::new(opened.conn),
            db_health: opened.health,
            output,
            startup_issues: issues,
            data_dir: dir.to_path_buf(),
            window_normal: Mutex::new(None),
            workspaces: Mutex::new(HashMap::new()),
            session_trust: Mutex::new(Vec::new()),
            grants: PathGrants::default(),
            startup_health,
            cli_path: Mutex::new(cli_path),
            startup_done: Mutex::new(false),
            watchers: Mutex::new(HashMap::new()),
            workspace_hook: std::sync::OnceLock::new(),
            toolchain_cache: Mutex::new(None),
            lsp: Mutex::new(HashMap::new()),
            lsp_next: std::sync::atomic::AtomicU64::new(1),
            terminals: Mutex::new(HashMap::new()),
            terminal_next: std::sync::atomic::AtomicU64::new(1),
            terminal_profiles: Mutex::new(None),
        }
    }
}

fn level_of(i: &StartupIssue) -> crate::output::Level {
    match i.severity {
        Severity::Info => crate::output::Level::Info,
        Severity::Warning => crate::output::Level::Warn,
        Severity::Error => crate::output::Level::Error,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn initializes_in_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = super::AppState::init_in(dir.path(), None);
        assert!(s.startup_issues.is_empty());
        assert!(!s.output.read("database", 0).unwrap().is_empty());
        assert!(dir.path().join(crate::db::DB_FILE).exists());
        assert!(!s.startup_health.safe_mode);
    }
}
