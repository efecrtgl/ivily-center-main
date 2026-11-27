//! Workspace Trust.
//!
//! Trust is a **user decision about a folder on this machine**, stored only in the application
//! database (never in the workspace, so a cloned repository cannot declare itself trusted).
//!
//! * Granular: trust is granted per [`Capability`]; e.g. a user may allow language servers but not
//!   task execution.
//! * Scoped: a decision applies to one folder, or to a folder *and everything below it*
//!   (`include_children`; refused for drive roots).
//! * Time-bounded: a grant can be for this session only (kept in memory) or remembered.
//! * Explicit denial: "Stay restricted" is remembered so the user is not asked again, and is as
//!   revocable as a grant.
//! * Resolution: the most specific decision wins (exact folder over nearest parent). A session
//!   grant overrides a stored decision for the current run. A multi-folder workspace has a
//!   capability only if **every** folder grants it.
//!
//! Subsystems that would execute workspace-controlled content call [`require`] before doing so.

use super::paths::{is_volume_root, key_is_within, NormalizedPath};
use crate::core::now_ms;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// Run tasks defined by the workspace (Phase 11).
    TaskExecution,
    /// Start terminal profiles, launch configurations or other processes defined by the workspace.
    ProcessLaunch,
    /// Start language servers whose command or arguments come from workspace configuration.
    LanguageServers,
    /// Activate extensions recommended or configured by the workspace.
    Extensions,
    /// Start debug sessions from workspace launch configurations.
    Debugging,
    /// Honour workspace settings that point to executables or scripts.
    WorkspaceExecutables,
}

pub const ALL_CAPABILITIES: [Capability; 6] = [
    Capability::TaskExecution,
    Capability::ProcessLaunch,
    Capability::LanguageServers,
    Capability::Extensions,
    Capability::Debugging,
    Capability::WorkspaceExecutables,
];

impl Capability {
    pub fn id(self) -> &'static str {
        match self {
            Capability::TaskExecution => "taskExecution",
            Capability::ProcessLaunch => "processLaunch",
            Capability::LanguageServers => "languageServers",
            Capability::Extensions => "extensions",
            Capability::Debugging => "debugging",
            Capability::WorkspaceExecutables => "workspaceExecutables",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Trusted,
    Denied,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    pub path: String,
    pub path_key: String,
    pub decision: Decision,
    pub include_children: bool,
    pub capabilities: BTreeSet<Capability>,
    /// `false` for session-only grants.
    pub persistent: bool,
    pub updated_at: i64,
}

/// How one folder's trust was determined.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Source {
    None,
    Folder,
    Parent { path: String },
    Session,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderTrust {
    pub path: String,
    pub path_key: String,
    /// `None` = the user has not decided yet.
    pub decision: Option<Decision>,
    pub capabilities: BTreeSet<Capability>,
    pub source: Source,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// Every capability granted for every folder.
    Trusted,
    /// Some capabilities granted.
    Partial,
    /// No capability granted (undecided or denied).
    Restricted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTrust {
    pub level: Level,
    pub capabilities: BTreeSet<Capability>,
    pub folders: Vec<FolderTrust>,
    /// At least one folder has no decision: the UI should ask (unless the user disabled prompts).
    pub needs_decision: bool,
}

fn row_to_record(r: &rusqlite::Row<'_>) -> rusqlite::Result<TrustRecord> {
    let decision: String = r.get(2)?;
    let caps: String = r.get(4)?;
    Ok(TrustRecord {
        path: r.get(0)?,
        path_key: r.get(1)?,
        decision: if decision == "trusted" { Decision::Trusted } else { Decision::Denied },
        include_children: r.get::<_, i64>(3)? != 0,
        capabilities: serde_json::from_str(&caps).unwrap_or_default(),
        persistent: true,
        updated_at: r.get(5)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<TrustRecord>> {
    let mut stmt = conn.prepare_cached(
        "SELECT path, path_key, decision, include_children, capabilities, updated_at FROM workspace_trust ORDER BY path_key",
    )?;
    let rows = stmt.query_map([], row_to_record)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn validate_scope(target: &NormalizedPath, include_children: bool) -> AppResult<()> {
    if include_children && is_volume_root(&target.path) {
        return Err(AppError::validation(
            "trust_too_broad",
            "a whole drive cannot be trusted including all of its folders",
        ));
    }
    Ok(())
}

/// Store a decision (replaces any previous decision for exactly this path).
pub fn store(
    conn: &Connection,
    target: &NormalizedPath,
    decision: Decision,
    include_children: bool,
    capabilities: &BTreeSet<Capability>,
) -> AppResult<()> {
    validate_scope(target, include_children)?;
    let caps = if decision == Decision::Denied { BTreeSet::new() } else { capabilities.clone() };
    let now = now_ms();
    conn.execute(
        "INSERT INTO workspace_trust (path_key, path, decision, include_children, capabilities, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (path_key) DO UPDATE SET path = excluded.path, decision = excluded.decision,
           include_children = excluded.include_children, capabilities = excluded.capabilities, updated_at = excluded.updated_at",
        params![
            target.key,
            target.display(),
            if decision == Decision::Trusted { "trusted" } else { "denied" },
            include_children as i64,
            serde_json::to_string(&caps).unwrap_or_else(|_| "[]".into()),
            now
        ],
    )?;
    Ok(())
}

/// Remove a stored decision. Returns whether one existed.
pub fn revoke(conn: &Connection, path_key: &str) -> AppResult<bool> {
    Ok(conn.execute("DELETE FROM workspace_trust WHERE path_key = ?1", [path_key])? > 0)
}

/// A session-only grant (kept in `AppState`, gone on restart).
pub fn session_record(
    target: &NormalizedPath,
    include_children: bool,
    caps: &BTreeSet<Capability>,
) -> AppResult<TrustRecord> {
    validate_scope(target, include_children)?;
    Ok(TrustRecord {
        path: target.display(),
        path_key: target.key.clone(),
        decision: Decision::Trusted,
        include_children,
        capabilities: caps.clone(),
        persistent: false,
        updated_at: now_ms(),
    })
}

/// Most specific applicable record: exact path first, then the nearest parent that includes children.
fn best<'a>(records: &'a [TrustRecord], key: &str) -> Option<&'a TrustRecord> {
    records
        .iter()
        .filter(|r| r.path_key == key || (r.include_children && key_is_within(key, &r.path_key)))
        .max_by_key(|r| (r.path_key == key, r.path_key.len()))
}

pub fn evaluate_folder(stored: &[TrustRecord], session: &[TrustRecord], folder: &NormalizedPath) -> FolderTrust {
    let pick = best(session, &folder.key).map(|r| (r, Source::Session)).or_else(|| {
        best(stored, &folder.key).map(|r| {
            let src = if r.path_key == folder.key { Source::Folder } else { Source::Parent { path: r.path.clone() } };
            (r, src)
        })
    });
    match pick {
        Some((r, source)) => FolderTrust {
            path: folder.display(),
            path_key: folder.key.clone(),
            decision: Some(r.decision),
            capabilities: if r.decision == Decision::Trusted { r.capabilities.clone() } else { BTreeSet::new() },
            source,
        },
        None => FolderTrust {
            path: folder.display(),
            path_key: folder.key.clone(),
            decision: None,
            capabilities: BTreeSet::new(),
            source: Source::None,
        },
    }
}

pub fn evaluate(stored: &[TrustRecord], session: &[TrustRecord], folders: &[NormalizedPath]) -> WorkspaceTrust {
    let folders: Vec<FolderTrust> = folders.iter().map(|f| evaluate_folder(stored, session, f)).collect();
    let capabilities: BTreeSet<Capability> = if folders.is_empty() {
        BTreeSet::new()
    } else {
        ALL_CAPABILITIES.iter().copied().filter(|c| folders.iter().all(|f| f.capabilities.contains(c))).collect()
    };
    let level = if capabilities.len() == ALL_CAPABILITIES.len() {
        Level::Trusted
    } else if capabilities.is_empty() {
        Level::Restricted
    } else {
        Level::Partial
    };
    WorkspaceTrust { level, capabilities, needs_decision: folders.iter().any(|f| f.decision.is_none()), folders }
}

/// Gate for anything that would execute workspace-controlled content.
pub fn require(trust: &WorkspaceTrust, capability: Capability) -> AppResult<()> {
    if trust.capabilities.contains(&capability) {
        Ok(())
    } else {
        Err(AppError::Untrusted(capability.id()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrate, MIGRATIONS};
    use std::path::PathBuf;

    fn np(p: &str) -> NormalizedPath {
        NormalizedPath { path: PathBuf::from(p), key: crate::workspace::paths::path_key(std::path::Path::new(p)) }
    }
    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, MIGRATIONS, None).unwrap();
        c
    }
    fn all() -> BTreeSet<Capability> {
        ALL_CAPABILITIES.into_iter().collect()
    }

    #[test]
    fn untrusted_by_default() {
        let t = evaluate(&[], &[], &[np(r"C:\code\app")]);
        assert_eq!(t.level, Level::Restricted);
        assert!(t.needs_decision);
        assert!(matches!(require(&t, Capability::TaskExecution), Err(AppError::Untrusted("taskExecution"))));
    }

    #[test]
    fn folder_and_parent_grants() {
        let c = conn();
        store(&c, &np(r"C:\code"), Decision::Trusted, true, &all()).unwrap();
        let stored = list(&c).unwrap();
        let t = evaluate(&stored, &[], &[np(r"C:\code\app")]);
        assert_eq!(t.level, Level::Trusted);
        assert_eq!(t.folders[0].source, Source::Parent { path: r"C:\code".into() });
        // Sibling with a common prefix is not covered.
        assert_eq!(evaluate(&stored, &[], &[np(r"C:\codebase")]).level, Level::Restricted);
        // A folder-only grant does not cover children.
        store(&c, &np(r"D:\work"), Decision::Trusted, false, &all()).unwrap();
        let stored = list(&c).unwrap();
        assert_eq!(evaluate(&stored, &[], &[np(r"D:\work\x")]).level, Level::Restricted);
    }

    #[test]
    fn most_specific_decision_wins() {
        let c = conn();
        store(&c, &np(r"C:\code"), Decision::Trusted, true, &all()).unwrap();
        store(&c, &np(r"C:\code\downloaded"), Decision::Denied, false, &BTreeSet::new()).unwrap();
        let stored = list(&c).unwrap();
        let t = evaluate(&stored, &[], &[np(r"C:\code\downloaded")]);
        assert_eq!(t.level, Level::Restricted);
        assert_eq!(t.folders[0].decision, Some(Decision::Denied));
        assert!(!t.needs_decision, "denial is a decision: do not ask again");
    }

    #[test]
    fn granular_capabilities_and_multi_root_intersection() {
        let c = conn();
        let lsp: BTreeSet<_> = [Capability::LanguageServers].into();
        store(&c, &np(r"C:\a"), Decision::Trusted, false, &all()).unwrap();
        store(&c, &np(r"C:\b"), Decision::Trusted, false, &lsp).unwrap();
        let stored = list(&c).unwrap();
        let t = evaluate(&stored, &[], &[np(r"C:\a"), np(r"C:\b")]);
        assert_eq!(t.level, Level::Partial);
        assert!(require(&t, Capability::LanguageServers).is_ok());
        assert!(require(&t, Capability::TaskExecution).is_err());
    }

    #[test]
    fn session_grants_override_and_are_not_stored() {
        let c = conn();
        store(&c, &np(r"C:\x"), Decision::Denied, false, &BTreeSet::new()).unwrap();
        let session = vec![session_record(&np(r"C:\x"), false, &all()).unwrap()];
        let t = evaluate(&list(&c).unwrap(), &session, &[np(r"C:\x")]);
        assert_eq!(t.level, Level::Trusted);
        assert_eq!(t.folders[0].source, Source::Session);
        assert_eq!(list(&c).unwrap().len(), 1);
    }

    #[test]
    fn revocation_and_drive_root_rules() {
        let c = conn();
        store(&c, &np(r"C:\x"), Decision::Trusted, false, &all()).unwrap();
        assert!(revoke(&c, &np(r"C:\x").key).unwrap());
        assert!(evaluate(&list(&c).unwrap(), &[], &[np(r"C:\x")]).needs_decision);
        assert!(!revoke(&c, &np(r"C:\x").key).unwrap());
        if cfg!(windows) {
            assert!(store(&c, &np(r"C:\"), Decision::Trusted, true, &all()).is_err());
            assert!(
                store(&c, &np(r"C:\"), Decision::Trusted, false, &all()).is_ok(),
                "the root folder itself may be trusted"
            );
        }
    }

    #[test]
    fn denial_never_carries_capabilities() {
        let c = conn();
        store(&c, &np(r"C:\x"), Decision::Denied, false, &all()).unwrap();
        assert!(list(&c).unwrap()[0].capabilities.is_empty());
    }
}
