//! Process-wide application state managed by Tauri.

use crate::core::{data_dir, StartupIssue};
use crate::db::{self, DbHealth};
use crate::output::OutputHub;
use crate::settings;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub db_health: DbHealth,
    pub output: Arc<OutputHub>,
    pub startup_issues: Vec<StartupIssue>,
    pub data_dir: PathBuf,
    /// Last normal (not maximized/minimized) bounds of the main window.
    pub window_normal: Mutex<Option<crate::window::Bounds>>,
}

impl AppState {
    pub fn init() -> Self {
        Self::init_in(&data_dir())
    }

    pub fn init_in(dir: &Path) -> Self {
        let output = Arc::new(OutputHub::new());
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
        match settings::resolve(&opened.conn, None) {
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
                    crate::core::Severity::Error,
                    "settings_unavailable",
                    "Settings could not be loaded; defaults are used.",
                ));
            }
        }

        Self {
            db: Mutex::new(opened.conn),
            db_health: opened.health,
            output,
            startup_issues: issues,
            data_dir: dir.to_path_buf(),
            window_normal: Mutex::new(None),
        }
    }
}

fn level_of(i: &StartupIssue) -> crate::output::Level {
    match i.severity {
        crate::core::Severity::Info => crate::output::Level::Info,
        crate::core::Severity::Warning => crate::output::Level::Warn,
        crate::core::Severity::Error => crate::output::Level::Error,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn initializes_in_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let s = super::AppState::init_in(dir.path());
        assert!(s.startup_issues.is_empty());
        assert!(!s.output.read("database", 0).unwrap().is_empty());
        assert!(dir.path().join(crate::db::DB_FILE).exists());
    }
}
