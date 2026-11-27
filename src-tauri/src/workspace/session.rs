//! Session persistence and crash recovery.
//!
//! * Each workspace has one session document (UI state contributed by session participants in the
//!   UI: layout now; editors, explorer, terminals later). Saving keeps the previous version, so a
//!   document that cannot be parsed falls back to the last good one.
//! * Startup health: every start increments `attempts`; the UI resets it once the workbench has
//!   restored successfully. Two consecutive starts that never became ready trigger **safe mode**:
//!   the last workspace is not restored automatically. A missing clean-exit marker means the
//!   previous run crashed (reported to the user, session restored from the last save).

use crate::app_state;
use crate::core::now_ms;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_SESSION_BYTES: usize = 256 * 1024;
const HEALTH_KEY: &str = "session.health";
const LAST_WORKSPACE_KEY: &str = "session.lastWorkspace";
const SAFE_MODE_AFTER: u32 = 2;

pub fn save(conn: &Connection, workspace_id: &str, state: &Value) -> AppResult<()> {
    if !state.is_object() {
        return Err(AppError::validation("invalid_session", "session state must be an object"));
    }
    let json = serde_json::to_string(state).map_err(|e| AppError::Internal(e.to_string()))?;
    if json.len() > MAX_SESSION_BYTES {
        return Err(AppError::validation(
            "session_too_large",
            format!("session state exceeds {MAX_SESSION_BYTES} bytes"),
        ));
    }
    conn.execute(
        "INSERT INTO workspace_session (workspace_id, state, previous_state, updated_at) VALUES (?1, ?2, NULL, ?3)
         ON CONFLICT (workspace_id) DO UPDATE SET previous_state = workspace_session.state, state = excluded.state,
           updated_at = excluded.updated_at",
        params![workspace_id, json, now_ms()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSession {
    pub state: Option<Value>,
    /// The latest document was unreadable and the previous one was used.
    pub recovered: bool,
}

pub fn load(conn: &Connection, workspace_id: &str) -> AppResult<LoadedSession> {
    let row: Option<(String, Option<String>)> = conn
        .query_row("SELECT state, previous_state FROM workspace_session WHERE workspace_id = ?1", [workspace_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let parse = |s: &str| serde_json::from_str::<Value>(s).ok().filter(Value::is_object);
    Ok(match row {
        None => LoadedSession { state: None, recovered: false },
        Some((cur, prev)) => match parse(&cur) {
            Some(v) => LoadedSession { state: Some(v), recovered: false },
            None => LoadedSession { state: prev.as_deref().and_then(parse), recovered: true },
        },
    })
}

/// Copy a session to another workspace id (used when a folder is saved as a workspace file).
pub fn copy(conn: &Connection, from: &str, to: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO workspace_session (workspace_id, state, previous_state, updated_at)
         SELECT ?2, state, previous_state, ?3 FROM workspace_session WHERE workspace_id = ?1",
        params![from, to, now_ms()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Health {
    attempts: u32,
    clean_exit: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupHealth {
    /// The previous run ended without a clean shutdown.
    pub previous_crashed: bool,
    /// Several starts in a row failed before the workbench became ready.
    pub safe_mode: bool,
}

/// Record the start of a run. Call once per process start.
pub fn begin_run(conn: &Connection) -> AppResult<StartupHealth> {
    let prev: Option<Health> = app_state::get(conn, HEALTH_KEY)?;
    let result = match &prev {
        None => StartupHealth { previous_crashed: false, safe_mode: false },
        Some(h) => StartupHealth { previous_crashed: !h.clean_exit, safe_mode: h.attempts >= SAFE_MODE_AFTER },
    };
    let attempts = prev.map(|h| h.attempts).unwrap_or(0) + 1;
    app_state::set(conn, HEALTH_KEY, &Health { attempts, clean_exit: false })?;
    Ok(result)
}

/// The workbench restored successfully: reset the failed-start counter.
pub fn mark_ready(conn: &Connection) -> AppResult<()> {
    let h: Health = app_state::get(conn, HEALTH_KEY)?.unwrap_or_default();
    app_state::set(conn, HEALTH_KEY, &Health { attempts: 0, ..h })
}

/// Clean shutdown.
pub fn mark_clean_exit(conn: &Connection) -> AppResult<()> {
    let h: Health = app_state::get(conn, HEALTH_KEY)?.unwrap_or_default();
    app_state::set(conn, HEALTH_KEY, &Health { clean_exit: true, attempts: h.attempts })
}

pub fn last_workspace(conn: &Connection) -> AppResult<Option<String>> {
    app_state::get(conn, LAST_WORKSPACE_KEY)
}

pub fn set_last_workspace(conn: &Connection, id: Option<&str>) -> AppResult<()> {
    app_state::set(conn, LAST_WORKSPACE_KEY, &id)
}

/// What to show at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupPlan {
    /// A folder or workspace file passed on the command line.
    OpenPath(std::path::PathBuf),
    Restore(String),
    Launcher,
    Welcome,
}

/// Pure startup decision. `startup` is the `workbench.startup` setting.
pub fn plan(
    startup: &str,
    cli_path: Option<std::path::PathBuf>,
    last: Option<String>,
    health: StartupHealth,
) -> StartupPlan {
    if let Some(p) = cli_path {
        return StartupPlan::OpenPath(p);
    }
    match startup {
        "launcher" => StartupPlan::Launcher,
        "welcome" => StartupPlan::Welcome,
        _ => match last {
            Some(id) if !health.safe_mode => StartupPlan::Restore(id),
            _ => StartupPlan::Launcher,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrate, MIGRATIONS};
    use serde_json::json;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, MIGRATIONS, None).unwrap();
        c
    }

    #[test]
    fn save_load_and_fallback_to_previous() {
        let c = conn();
        assert_eq!(load(&c, "ws_a").unwrap().state, None);
        save(&c, "ws_a", &json!({ "v": 1 })).unwrap();
        save(&c, "ws_a", &json!({ "v": 2 })).unwrap();
        assert_eq!(load(&c, "ws_a").unwrap(), LoadedSession { state: Some(json!({ "v": 2 })), recovered: false });
        c.execute("UPDATE workspace_session SET state = '{broken' WHERE workspace_id = 'ws_a'", []).unwrap();
        assert_eq!(load(&c, "ws_a").unwrap(), LoadedSession { state: Some(json!({ "v": 1 })), recovered: true });
    }

    #[test]
    fn rejects_invalid_or_huge_sessions() {
        let c = conn();
        assert!(save(&c, "ws_a", &json!([1, 2])).is_err());
        assert!(save(&c, "ws_a", &json!({ "x": "y".repeat(MAX_SESSION_BYTES) })).is_err());
    }

    #[test]
    fn crash_and_safe_mode_detection() {
        let c = conn();
        let first = begin_run(&c).unwrap();
        assert_eq!(first, StartupHealth { previous_crashed: false, safe_mode: false });
        mark_ready(&c).unwrap();
        mark_clean_exit(&c).unwrap();
        assert_eq!(begin_run(&c).unwrap(), StartupHealth { previous_crashed: false, safe_mode: false });
        // Crash after becoming ready: reported, but no safe mode.
        mark_ready(&c).unwrap();
        assert_eq!(begin_run(&c).unwrap(), StartupHealth { previous_crashed: true, safe_mode: false });
        // Crash before ready twice in a row → safe mode.
        assert_eq!(begin_run(&c).unwrap(), StartupHealth { previous_crashed: true, safe_mode: false });
        assert_eq!(begin_run(&c).unwrap(), StartupHealth { previous_crashed: true, safe_mode: true });
        mark_ready(&c).unwrap();
        assert!(!begin_run(&c).unwrap().safe_mode);
    }

    #[test]
    fn startup_plan() {
        let ok = StartupHealth { previous_crashed: false, safe_mode: false };
        let safe = StartupHealth { previous_crashed: true, safe_mode: true };
        let ws = Some("ws_1".to_string());
        assert_eq!(plan("lastWorkspace", None, ws.clone(), ok), StartupPlan::Restore("ws_1".into()));
        assert_eq!(plan("lastWorkspace", None, None, ok), StartupPlan::Launcher);
        assert_eq!(plan("lastWorkspace", None, ws.clone(), safe), StartupPlan::Launcher);
        assert_eq!(plan("launcher", None, ws.clone(), ok), StartupPlan::Launcher);
        assert_eq!(plan("welcome", None, ws.clone(), ok), StartupPlan::Welcome);
        let p = std::path::PathBuf::from(r"C:\x");
        assert_eq!(plan("welcome", Some(p.clone()), ws, safe), StartupPlan::OpenPath(p));
    }

    #[test]
    fn last_workspace_round_trip() {
        let c = conn();
        assert_eq!(last_workspace(&c).unwrap(), None);
        set_last_workspace(&c, Some("ws_1")).unwrap();
        assert_eq!(last_workspace(&c).unwrap().as_deref(), Some("ws_1"));
        set_last_workspace(&c, None).unwrap();
        assert_eq!(last_workspace(&c).unwrap(), None);
    }
}
