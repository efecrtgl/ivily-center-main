//! Workspace manager: the registry of known workspaces, opening (folder or workspace file),
//! metadata, relocation and removal.
//!
//! A *workspace* is the context every IDE subsystem works in: its folders are the roots the user
//! has opened (the only places future file, search, Git, terminal and LSP operations may act on),
//! its id keys sessions and workspace-scoped data, and its trust state gates execution.
//!
//! Data separation:
//! * **User data** — user-scope settings, theme, keybindings: `settings` (scope `user`).
//! * **Workspace data** — the registry, sessions and (for folder workspaces) workspace-scope
//!   settings: app database, keyed by workspace id. Removing a workspace from the list deletes this.
//! * **Trust** — the user's decision about folders: app database, keyed by folder path.
//! * **Project-local data** — only a `*.ivily-workspace` file the user explicitly saved. Center
//!   never creates other files in project folders.

pub mod discover;
pub mod file;
pub mod grants;
pub mod paths;
pub mod service;
pub mod session;
pub mod trust;

use crate::core::now_ms;
use crate::error::{AppError, AppResult};
use paths::{folder_name, normalize_dir, normalize_workspace_file, NormalizedPath};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A single folder; workspace data lives in the app database only.
    Folder,
    /// A `*.ivily-workspace` file (one or more folders, portable settings).
    File,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Folder => "folder",
            Kind::File => "file",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub kind: Kind,
    /// Folder path, or workspace file path.
    pub path: String,
    pub name: String,
    pub favorite: bool,
    pub group: String,
    pub created_at: i64,
    pub last_opened_at: i64,
    pub open_count: i64,
}

const COLUMNS: &str = "id, kind, path, name, favorite, group_name, created_at, last_opened_at, open_count";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    Ok(WorkspaceRecord {
        id: r.get(0)?,
        kind: if r.get::<_, String>(1)? == "file" { Kind::File } else { Kind::Folder },
        path: r.get(2)?,
        name: r.get(3)?,
        favorite: r.get::<_, i64>(4)? != 0,
        group: r.get(5)?,
        created_at: r.get(6)?,
        last_opened_at: r.get(7)?,
        open_count: r.get(8)?,
    })
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 19 && id.starts_with("ws_") && id[3..].chars().all(|c| c.is_ascii_hexdigit())
}

fn check_id(id: &str) -> AppResult<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(AppError::validation("invalid_workspace_id", "malformed workspace id"))
    }
}

pub fn list(conn: &Connection) -> AppResult<Vec<WorkspaceRecord>> {
    let mut stmt =
        conn.prepare_cached(&format!("SELECT {COLUMNS} FROM workspace ORDER BY last_opened_at DESC LIMIT 500"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<WorkspaceRecord> {
    check_id(id)?;
    conn.query_row(&format!("SELECT {COLUMNS} FROM workspace WHERE id = ?1"), [id], row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("workspace {id}")))
}

fn find_by_key(conn: &Connection, key: &str) -> AppResult<Option<WorkspaceRecord>> {
    Ok(conn.query_row(&format!("SELECT {COLUMNS} FROM workspace WHERE path_key = ?1"), [key], row).optional()?)
}

/// Insert a workspace or, if the same location is already known, bump its recency.
/// Duplicate spellings of one path resolve to one record (path keys are canonical).
pub fn record_opened(
    conn: &Connection,
    kind: Kind,
    location: &NormalizedPath,
    name: &str,
) -> AppResult<WorkspaceRecord> {
    let now = now_ms();
    if let Some(existing) = find_by_key(conn, &location.key)? {
        conn.execute(
            "UPDATE workspace SET last_opened_at = ?2, open_count = open_count + 1, path = ?3 WHERE id = ?1",
            params![existing.id, now, location.display()],
        )?;
        return get(conn, &existing.id);
    }
    let id: String = conn.query_row("SELECT 'ws_' || lower(hex(randomblob(8)))", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO workspace (id, kind, path, path_key, name, created_at, last_opened_at, open_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1)",
        params![id, kind.as_str(), location.display(), location.key, name, now],
    )?;
    get(conn, &id)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetaPatch {
    pub name: Option<String>,
    pub favorite: Option<bool>,
    pub group: Option<String>,
}

pub fn update_meta(conn: &Connection, id: &str, patch: &MetaPatch) -> AppResult<WorkspaceRecord> {
    let current = get(conn, id)?;
    let clean = |s: &str, max: usize, field: &'static str| -> AppResult<String> {
        let t = s.trim();
        if t.chars().count() > max || t.chars().any(char::is_control) {
            return Err(AppError::validation(
                "invalid_workspace_meta",
                format!("{field} is too long or contains control characters"),
            ));
        }
        Ok(t.to_string())
    };
    let name = match &patch.name {
        Some(n) => {
            let n = clean(n, 128, "name")?;
            if n.is_empty() {
                return Err(AppError::validation("invalid_workspace_meta", "name cannot be empty"));
            }
            n
        }
        None => current.name,
    };
    let group = match &patch.group {
        Some(g) => clean(g, 64, "group")?,
        None => current.group,
    };
    let favorite = patch.favorite.unwrap_or(current.favorite);
    conn.execute(
        "UPDATE workspace SET name = ?2, group_name = ?3, favorite = ?4 WHERE id = ?1",
        params![id, name, group, favorite as i64],
    )?;
    get(conn, id)
}

/// Forget a workspace: registry entry, session and DB-stored workspace settings.
/// Nothing on disk is touched; trust decisions (keyed by folder) are kept.
pub fn remove(conn: &mut Connection, id: &str) -> AppResult<()> {
    check_id(id)?;
    let tx = conn.transaction()?;
    let n = tx.execute("DELETE FROM workspace WHERE id = ?1", [id])?;
    tx.execute("DELETE FROM workspace_session WHERE workspace_id = ?1", [id])?;
    tx.execute("DELETE FROM settings WHERE scope = 'workspace' AND scope_id = ?1", [id])?;
    tx.commit()?;
    if n == 0 {
        return Err(AppError::NotFound(format!("workspace {id}")));
    }
    Ok(())
}

/// Point a record at a new location (e.g. the project folder was moved). Trust is not carried
/// over: it belongs to the old location.
pub fn relocate(conn: &Connection, id: &str, location: &NormalizedPath) -> AppResult<WorkspaceRecord> {
    let current = get(conn, id)?;
    if let Some(other) = find_by_key(conn, &location.key)? {
        if other.id != current.id {
            return Err(AppError::Conflict(format!(
                "{} is already in the list as '{}'",
                location.display(),
                other.name
            )));
        }
    }
    conn.execute(
        "UPDATE workspace SET path = ?2, path_key = ?3 WHERE id = ?1",
        params![id, location.display(), location.key],
    )?;
    get(conn, id)
}

// ── Runtime context ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolder {
    pub name: String,
    pub path: String,
    #[serde(skip)]
    pub normalized: Option<NormalizedPath>,
    /// `false` when a folder listed in a workspace file is missing or inaccessible.
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// A loaded `*.ivily-workspace` file.
#[derive(Debug, Clone)]
pub struct LoadedFile {
    pub path: PathBuf,
    pub content: file::WorkspaceFile,
    pub hash: String,
}

/// The workspace open in a window.
#[derive(Debug, Clone)]
pub struct OpenWorkspace {
    pub record: WorkspaceRecord,
    pub folders: Vec<WorkspaceFolder>,
    pub file: Option<LoadedFile>,
}

impl OpenWorkspace {
    /// Roots that subsystems may operate on (available folders only).
    pub fn roots(&self) -> Vec<NormalizedPath> {
        self.folders.iter().filter_map(|f| f.normalized.clone()).collect()
    }
}

/// Open a folder as a workspace.
pub fn open_folder(conn: &Connection, folder: &Path) -> AppResult<OpenWorkspace> {
    let n = normalize_dir(folder)?;
    let name = folder_name(&n.path);
    let record = record_opened(conn, Kind::Folder, &n, &name)?;
    Ok(OpenWorkspace {
        folders: vec![WorkspaceFolder {
            name: record.name.clone(),
            path: n.display(),
            normalized: Some(n),
            available: true,
            problem: None,
        }],
        record,
        file: None,
    })
}

/// Open a `*.ivily-workspace` file. Missing folders are reported; at least one must be available.
pub fn open_file(conn: &Connection, path: &Path) -> AppResult<OpenWorkspace> {
    let n = normalize_workspace_file(path)?;
    let (content, hash) = file::read(&n.path)?;
    let base = n.path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut folders = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in &content.folders {
        let resolved = file::resolve_folder(&base, entry);
        match normalize_dir(&resolved) {
            Ok(fp) => {
                if !seen.insert(fp.key.clone()) {
                    continue; // the same folder listed twice
                }
                let name = entry.name.clone().unwrap_or_else(|| folder_name(&fp.path));
                folders.push(WorkspaceFolder {
                    name,
                    path: fp.display(),
                    normalized: Some(fp),
                    available: true,
                    problem: None,
                });
            }
            Err(e) => folders.push(WorkspaceFolder {
                name: entry.name.clone().unwrap_or_else(|| folder_name(&resolved)),
                path: resolved.display().to_string(),
                normalized: None,
                available: false,
                problem: Some(e.to_string()),
            }),
        }
    }
    if !folders.iter().any(|f| f.available) {
        return Err(AppError::NotFound("none of the folders in this workspace file are available".into()));
    }
    let default_name =
        n.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Workspace".into());
    let name = content.name.clone().filter(|s| !s.trim().is_empty()).unwrap_or(default_name);
    let record = record_opened(conn, Kind::File, &n, &name)?;
    Ok(OpenWorkspace { record, folders, file: Some(LoadedFile { path: n.path, content, hash }) })
}

/// Re-open a known workspace from its record (validates the location again).
pub fn open_record(conn: &Connection, id: &str) -> AppResult<OpenWorkspace> {
    let r = get(conn, id)?;
    match r.kind {
        Kind::Folder => open_folder(conn, Path::new(&r.path)),
        Kind::File => open_file(conn, Path::new(&r.path)),
    }
}

/// Build the content of a new workspace file for the open workspace, including its
/// workspace-scoped settings (taken from `settings_layer`).
pub fn to_file_content(
    ws: &OpenWorkspace,
    target_dir: &Path,
    settings_layer: Map<String, Value>,
) -> file::WorkspaceFile {
    let mut content = ws.file.as_ref().map(|f| f.content.clone()).unwrap_or(file::WorkspaceFile {
        version: file::FORMAT_VERSION,
        name: None,
        folders: Vec::new(),
        settings: Map::new(),
        extra: Map::new(),
    });
    content.version = file::FORMAT_VERSION;
    content.name = Some(ws.record.name.clone());
    content.folders = ws
        .folders
        .iter()
        .map(|f| {
            let p = f.normalized.as_ref().map(|n| n.path.clone()).unwrap_or_else(|| PathBuf::from(&f.path));
            let default_name = folder_name(&p);
            file::FolderEntry {
                path: file::portable_folder_path(target_dir, &p),
                name: if f.name != default_name { Some(f.name.clone()) } else { None },
                extra: Map::new(),
            }
        })
        .collect();
    content.settings = settings_layer;
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrate, MIGRATIONS};

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, MIGRATIONS, None).unwrap();
        c
    }

    #[test]
    fn opening_the_same_folder_twice_reuses_the_record() {
        let c = conn();
        let dir = tempfile::tempdir().unwrap();
        let a = open_folder(&c, dir.path()).unwrap();
        let alt = PathBuf::from(format!("{}\\", dir.path().display()));
        let b = open_folder(&c, &alt).unwrap();
        assert_eq!(a.record.id, b.record.id);
        assert_eq!(b.record.open_count, 2);
        assert_eq!(list(&c).unwrap().len(), 1);
        assert!(valid_id(&a.record.id));
    }

    #[test]
    fn rejects_missing_and_non_directories() {
        let c = conn();
        let dir = tempfile::tempdir().unwrap();
        assert!(open_folder(&c, &dir.path().join("missing")).is_err());
        std::fs::write(dir.path().join("f"), "x").unwrap();
        assert!(open_folder(&c, &dir.path().join("f")).is_err());
        assert!(list(&c).unwrap().is_empty(), "failed opens must not create records");
    }

    #[test]
    fn metadata_updates_are_validated() {
        let c = conn();
        let dir = tempfile::tempdir().unwrap();
        let ws = open_folder(&c, dir.path()).unwrap();
        let r = update_meta(
            &c,
            &ws.record.id,
            &MetaPatch { name: Some(" Shop ".into()), favorite: Some(true), group: Some("Work".into()) },
        )
        .unwrap();
        assert_eq!((r.name.as_str(), r.favorite, r.group.as_str()), ("Shop", true, "Work"));
        assert!(update_meta(&c, &ws.record.id, &MetaPatch { name: Some("".into()), ..Default::default() }).is_err());
        assert!(
            update_meta(&c, &ws.record.id, &MetaPatch { name: Some("a\u{7}".into()), ..Default::default() }).is_err()
        );
        assert!(get(&c, "ws_nothexnothexnot").is_err());
        assert!(get(&c, "../../etc").is_err());
    }

    #[test]
    fn removal_deletes_workspace_data_but_not_files() {
        let mut c = conn();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.txt"), "x").unwrap();
        let ws = open_folder(&c, dir.path()).unwrap();
        let id = ws.record.id.clone();
        c.execute("INSERT INTO workspace_session VALUES (?1, '{}', NULL, 0)", [&id]).unwrap();
        c.execute("INSERT INTO settings VALUES ('workspace', ?1, 'appearance.theme', '\"glass\"', 0)", [&id]).unwrap();
        remove(&mut c, &id).unwrap();
        for table in ["workspace", "workspace_session", "settings"] {
            let n: i64 = c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table}");
        }
        assert!(dir.path().join("keep.txt").exists());
        assert!(remove(&mut c, &id).is_err());
    }

    #[test]
    fn relocation_rejects_duplicates() {
        let c = conn();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c2 = tempfile::tempdir().unwrap();
        let wa = open_folder(&c, a.path()).unwrap();
        open_folder(&c, b.path()).unwrap();
        assert!(matches!(relocate(&c, &wa.record.id, &normalize_dir(b.path()).unwrap()), Err(AppError::Conflict(_))));
        let moved = relocate(&c, &wa.record.id, &normalize_dir(c2.path()).unwrap()).unwrap();
        assert_eq!(moved.path, normalize_dir(c2.path()).unwrap().display());
    }

    #[test]
    fn workspace_files_with_relative_and_missing_folders() {
        let c = conn();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("web")).unwrap();
        let f = dir.path().join("shop.ivily-workspace");
        std::fs::write(
            &f,
            r#"{ "ivilyWorkspace": 1, "folders": [ { "path": "." }, { "path": "web", "name": "Frontend" }, { "path": "gone" }, { "path": "web" } ] }"#,
        )
        .unwrap();
        let ws = open_file(&c, &f).unwrap();
        assert_eq!(ws.record.kind, Kind::File);
        assert_eq!(ws.record.name, "shop");
        assert_eq!(ws.folders.len(), 3, "duplicate folder entries are collapsed");
        assert_eq!(ws.folders[1].name, "Frontend");
        assert!(!ws.folders[2].available);
        assert_eq!(ws.roots().len(), 2);

        let none = dir.path().join("none.ivily-workspace");
        std::fs::write(&none, r#"{ "ivilyWorkspace": 1, "folders": [ { "path": "gone" } ] }"#).unwrap();
        assert!(open_file(&c, &none).is_err());
    }

    #[test]
    fn file_content_is_portable() {
        let c = conn();
        let dir = tempfile::tempdir().unwrap();
        let ws = open_folder(&c, dir.path()).unwrap();
        let mut settings = Map::new();
        settings.insert("appearance.theme".into(), Value::from("glass"));
        let content = to_file_content(&ws, &normalize_dir(dir.path()).unwrap().path, settings);
        assert_eq!(content.folders[0].path, ".");
        assert_eq!(content.settings["appearance.theme"], "glass");
        assert!(file::parse(&file::serialize(&content).unwrap()).is_ok());
    }
}
