//! SQLite persistence: opening, integrity checking, recovery and versioned migrations.
//!
//! Data-ownership rule: every subsystem owns its own tables, named with a subsystem prefix
//! (`settings`, `app_state`, later `workspace_*`, `session_*`, `ext_*`, `module_*`, ...), and only
//! that subsystem's module issues SQL against them. Cross-subsystem references use stable string
//! ids rather than foreign keys, so subsystems can evolve independently. See `docs/DATABASE.md`.

pub mod migrations;

use crate::core::{now_ms, Severity, StartupIssue};
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub use migrations::{Migration, MIGRATIONS};

pub const DB_FILE: &str = "center.db";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StorageMode {
    /// Normal operation: data is written to `center.db`.
    Persistent,
    /// The database could not be used safely; data lives in memory for this session only.
    Memory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHealth {
    pub mode: StorageMode,
    pub path: Option<String>,
    pub schema_version: u32,
    pub expected_schema_version: u32,
}

/// Result of opening the application database.
pub struct Opened {
    pub conn: Connection,
    pub health: DbHealth,
    pub issues: Vec<StartupIssue>,
}

pub fn latest_version(migrations: &[Migration]) -> u32 {
    migrations.iter().map(|m| m.version).max().unwrap_or(0)
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

pub fn user_version(conn: &Connection) -> AppResult<u32> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))?)
}

fn quick_check(conn: &Connection) -> AppResult<bool> {
    let result: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    Ok(result == "ok")
}

/// Copy the live database to `backup_dir` using SQLite's online backup API.
pub fn backup_to(conn: &Connection, backup_dir: &Path, label: &str) -> AppResult<PathBuf> {
    std::fs::create_dir_all(backup_dir)?;
    let dest = backup_dir.join(format!("center-{label}-{}.db", now_ms()));
    if dest.exists() {
        return Err(AppError::Conflict(format!("backup file already exists: {}", dest.display())));
    }
    let mut out = Connection::open(&dest)?;
    let backup = rusqlite::backup::Backup::new(conn, &mut out)?;
    backup.run_to_completion(256, std::time::Duration::from_millis(0), None)?;
    Ok(dest)
}

/// Apply pending migrations inside one transaction. A database newer than `migrations` is
/// rejected (never downgraded). When `backup_dir` is given and the database already has data,
/// a backup is taken before the first migration runs.
pub fn migrate(conn: &mut Connection, migrations: &[Migration], backup_dir: Option<&Path>) -> AppResult<u32> {
    let current = user_version(conn)?;
    let latest = latest_version(migrations);
    if current > latest {
        return Err(AppError::Unsupported(format!(
            "database schema {current} is newer than this version of Ivily Center supports ({latest})"
        )));
    }
    if current == latest {
        return Ok(current);
    }
    if current > 0 {
        if let Some(dir) = backup_dir {
            backup_to(conn, dir, &format!("pre-v{latest}"))?;
        }
    }
    let tx = conn.transaction()?;
    let mut pending: Vec<&Migration> = migrations.iter().filter(|m| m.version > current).collect();
    pending.sort_by_key(|m| m.version);
    for m in pending {
        tx.execute_batch(m.sql)
            .map_err(|e| AppError::Database(format!("migration {} ({}): {e}", m.version, m.name)))?;
        tx.pragma_update(None, "user_version", m.version)?;
    }
    tx.commit()?;
    Ok(latest)
}

fn memory_db(issues: Vec<StartupIssue>) -> AppResult<Opened> {
    let mut conn = Connection::open_in_memory()?;
    migrate(&mut conn, MIGRATIONS, None)?;
    let v = user_version(&conn)?;
    Ok(Opened {
        conn,
        health: DbHealth {
            mode: StorageMode::Memory,
            path: None,
            schema_version: v,
            expected_schema_version: latest_version(MIGRATIONS),
        },
        issues,
    })
}

/// Open (or create) `<data_dir>/center.db`.
///
/// * Corrupt file → renamed to `center.db.corrupt-<ts>` (kept, never deleted) and a new one is created.
/// * Newer schema → the file is left untouched and the session runs on an in-memory database.
/// * Any other failure → in-memory database with an error issue, so the IDE still starts.
pub fn open_app_db(data_dir: &Path) -> Opened {
    match try_open(data_dir) {
        Ok(o) => o,
        Err(e) => {
            let issue = StartupIssue::new(
                Severity::Error,
                "db_unavailable",
                format!("Settings and state cannot be saved this session: {e}"),
            );
            memory_db(vec![issue]).expect("in-memory SQLite must open")
        }
    }
}

fn try_open(data_dir: &Path) -> AppResult<Opened> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(DB_FILE);
    let backups = data_dir.join("backups");
    let mut issues = Vec::new();

    if path.exists() {
        let healthy = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(AppError::from)
            .and_then(|c| quick_check(&c));
        if !matches!(healthy, Ok(true)) {
            let aside = data_dir.join(format!("{DB_FILE}.corrupt-{}", now_ms()));
            std::fs::rename(&path, &aside)?;
            for suffix in ["-wal", "-shm"] {
                let side = data_dir.join(format!("{DB_FILE}{suffix}"));
                if side.exists() {
                    let _ = std::fs::rename(&side, data_dir.join(format!("{}{suffix}", aside.display())));
                }
            }
            issues.push(StartupIssue::new(
                Severity::Warning,
                "db_recovered",
                format!(
                    "The database failed its integrity check and was moved to {}. A new database was created.",
                    aside.display()
                ),
            ));
        }
    }

    let mut conn = Connection::open(&path)?;
    configure(&conn)?;
    let latest = latest_version(MIGRATIONS);
    let current = user_version(&conn)?;
    if current > latest {
        drop(conn);
        issues.push(StartupIssue::new(
            Severity::Error,
            "db_newer_schema",
            format!(
                "The database was created by a newer Ivily Center (schema {current}, supported {latest}). \
                 It was left untouched; changes this session are not saved."
            ),
        ));
        return memory_db(issues);
    }
    let version = migrate(&mut conn, MIGRATIONS, Some(&backups))?;
    Ok(Opened {
        conn,
        health: DbHealth {
            mode: StorageMode::Persistent,
            path: Some(path.display().to_string()),
            schema_version: version,
            expected_schema_version: latest,
        },
        issues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_MIGRATIONS: &[Migration] = &[
        Migration { version: 1, name: "a", sql: "CREATE TABLE a (x INTEGER);" },
        Migration { version: 2, name: "b", sql: "CREATE TABLE b (y INTEGER);" },
    ];

    #[test]
    fn migrates_fresh_database_to_latest() {
        let mut c = Connection::open_in_memory().unwrap();
        assert_eq!(migrate(&mut c, TEST_MIGRATIONS, None).unwrap(), 2);
        c.execute("INSERT INTO b (y) VALUES (1)", []).unwrap();
        // Idempotent.
        assert_eq!(migrate(&mut c, TEST_MIGRATIONS, None).unwrap(), 2);
    }

    #[test]
    fn failed_migration_rolls_back_everything() {
        let bad = &[
            Migration { version: 1, name: "ok", sql: "CREATE TABLE ok (x);" },
            Migration { version: 2, name: "broken", sql: "THIS IS NOT SQL;" },
        ];
        let mut c = Connection::open_in_memory().unwrap();
        assert!(migrate(&mut c, bad, None).is_err());
        assert_eq!(user_version(&c).unwrap(), 0);
        let tables: i64 =
            c.query_row("SELECT count(*) FROM sqlite_master WHERE name = 'ok'", [], |r| r.get(0)).unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn rejects_newer_schema() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "user_version", 99).unwrap();
        assert!(matches!(migrate(&mut c, TEST_MIGRATIONS, None), Err(AppError::Unsupported(_))));
    }

    #[test]
    fn backs_up_existing_data_before_migrating() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = Connection::open(dir.path().join("t.db")).unwrap();
        migrate(&mut c, &TEST_MIGRATIONS[..1], None).unwrap();
        c.execute("INSERT INTO a (x) VALUES (7)", []).unwrap();
        let backups = dir.path().join("backups");
        migrate(&mut c, TEST_MIGRATIONS, Some(&backups)).unwrap();
        let files: Vec<_> = std::fs::read_dir(&backups).unwrap().collect();
        assert_eq!(files.len(), 1);
        let b = Connection::open(files[0].as_ref().unwrap().path()).unwrap();
        let x: i64 = b.query_row("SELECT x FROM a", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 7);
    }

    #[test]
    fn creates_persistent_database() {
        let dir = tempfile::tempdir().unwrap();
        let o = open_app_db(dir.path());
        assert_eq!(o.health.mode, StorageMode::Persistent);
        assert!(o.issues.is_empty());
        assert_eq!(o.health.schema_version, latest_version(MIGRATIONS));
    }

    #[test]
    fn corrupt_database_is_moved_aside_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(DB_FILE), b"definitely not sqlite, just some bytes padding padding").unwrap();
        let o = open_app_db(dir.path());
        assert_eq!(o.health.mode, StorageMode::Persistent);
        assert_eq!(o.issues[0].code, "db_recovered");
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("center.db.corrupt-"));
        assert!(kept, "corrupt file must be preserved");
    }

    #[test]
    fn newer_schema_runs_in_memory_and_leaves_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        {
            let c = Connection::open(&path).unwrap();
            c.pragma_update(None, "user_version", 999).unwrap();
        }
        let o = open_app_db(dir.path());
        assert_eq!(o.health.mode, StorageMode::Memory);
        assert_eq!(o.issues[0].code, "db_newer_schema");
        drop(o);
        let c = Connection::open(&path).unwrap();
        assert_eq!(user_version(&c).unwrap(), 999);
    }
}
