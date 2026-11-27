//! Backups of Ivily Center's own data (never project source code).
//!
//! A backup is a zip archive in `<data dir>/app-backups/` with `manifest.json` (format version,
//! app version, creation time, kind, and SHA-256 + size of every file) and:
//! * `center.db` — a consistent copy made with SQLite's online backup API,
//! * `notes/**`, `extensions/**`, `drafts/**` — workspace notes, installed extensions, unsaved
//!   editor drafts.
//!
//! Restoring is staged: the archive is verified (paths, hashes, database integrity), extracted to
//! `pending-restore/`, and applied at the next start **before** the database is opened. A safety
//! backup of the current state is taken first. Retention only ever removes *automatic* backups.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const DIR: &str = "app-backups";
pub const PENDING: &str = "pending-restore";
const FORMAT: u32 = 1;
const INCLUDED_DIRS: [&str; 3] = ["notes", "extensions", "drafts"];
const MAX_ENTRY: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub app: String,
    pub app_version: String,
    pub created_at: i64,
    /// `manual`, `automatic`, `safety` (before a restore) or `imported`.
    pub kind: String,
    pub schema_version: u32,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
    pub manifest: Option<Manifest>,
    pub error: Option<String>,
}

fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_file(p: &Path) -> AppResult<(u64, String)> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut n = 0u64;
    loop {
        let r = f.read(&mut buf)?;
        if r == 0 {
            break;
        }
        n += r as u64;
        h.update(&buf[..r]);
    }
    Ok((n, hex(&h.finalize())))
}

/// A safe relative archive path: `a/b.txt` (no absolute paths, drive letters, `..`, backslashes).
pub fn safe_entry(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 400
        && !name.contains(['\\', ':', '\0'])
        && Path::new(name).components().all(|c| matches!(c, Component::Normal(_)))
}

fn backup_name(kind: &str) -> String {
    let secs = crate::core::now_ms() / 1000;
    let (y, mo, d, h, mi, s) = civil(secs);
    format!("ivily-center-{kind}-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}.zip")
}

/// Unix seconds → UTC calendar (Howard Hinnant's civil_from_days).
fn civil(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

fn collect(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) -> AppResult<()> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(()) };
    for e in rd.flatten() {
        let ft = e.file_type()?;
        let name = e.file_name().to_string_lossy().into_owned();
        let r = format!("{rel}/{name}");
        if ft.is_dir() {
            collect(&e.path(), &r, out)?;
        } else if ft.is_file() && safe_entry(&r) {
            out.push((r, e.path()));
        }
        if out.len() > MAX_ENTRIES {
            return Err(AppError::validation("too_many_files", "too many files to back up"));
        }
    }
    Ok(())
}

/// Create a backup archive. `conn` is the live database.
pub fn create(conn: &Connection, data_dir: &Path, kind: &str) -> AppResult<PathBuf> {
    let dir = data_dir.join(DIR);
    std::fs::create_dir_all(&dir)?;
    let tmp_dir = tempfile::Builder::new().prefix(".backup-").tempdir_in(&dir)?;
    // Consistent database snapshot.
    let db_copy = tmp_dir.path().join("center.db");
    {
        let mut dst = Connection::open(&db_copy)?;
        let b = rusqlite::backup::Backup::new(conn, &mut dst)?;
        b.run_to_completion(256, std::time::Duration::from_millis(5), None)?;
    }
    let mut files = vec![("center.db".to_string(), db_copy.clone())];
    for d in INCLUDED_DIRS {
        collect(&data_dir.join(d), d, &mut files)?;
    }
    let mut entries = Vec::new();
    for (rel, p) in &files {
        let (size, sha256) = sha256_file(p)?;
        entries.push(FileEntry { path: rel.clone(), size, sha256 });
    }
    let manifest = Manifest {
        format: FORMAT,
        app: "ivily-center".into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at: crate::core::now_ms(),
        kind: kind.into(),
        schema_version: crate::db::user_version(conn)?,
        files: entries,
    };
    let name = backup_name(kind);
    let partial = dir.join(format!(".{name}.partial"));
    {
        let f = std::fs::File::create(&partial)?;
        let mut zip = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        zip.start_file("manifest.json", opts).map_err(zip_err)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| AppError::Internal(e.to_string()))?)?;
        for (rel, p) in &files {
            zip.start_file(rel.as_str(), opts).map_err(zip_err)?;
            std::io::copy(&mut std::fs::File::open(p)?, &mut zip)?;
        }
        zip.finish().map_err(zip_err)?.sync_all()?;
    }
    let target = dir.join(&name);
    std::fs::rename(&partial, &target)?;
    Ok(target)
}

fn zip_err(e: zip::result::ZipError) -> AppError {
    AppError::Io(format!("backup archive: {e}"))
}

/// Read the manifest of an archive.
pub fn read_manifest(path: &Path) -> AppResult<Manifest> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(zip_err)?;
    let mut f = zip
        .by_name("manifest.json")
        .map_err(|_| AppError::validation("invalid_backup", "the archive has no manifest"))?;
    if f.size() > 4 * 1024 * 1024 {
        return Err(AppError::validation("invalid_backup", "manifest too large"));
    }
    let mut text = String::new();
    f.read_to_string(&mut text)?;
    let m: Manifest = serde_json::from_str(&text)
        .map_err(|e| AppError::validation("invalid_backup", format!("invalid manifest: {e}")))?;
    if m.app != "ivily-center" || m.format != FORMAT {
        return Err(AppError::validation("invalid_backup", "not an Ivily Center backup of a supported format"));
    }
    Ok(m)
}

/// Verify an archive completely: safe paths, every listed file present with the right size and
/// hash, nothing unlisted, and the database passes `PRAGMA integrity_check`. Returns the manifest.
pub fn verify(path: &Path) -> AppResult<Manifest> {
    let m = read_manifest(path)?;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(zip_err)?;
    if zip.len() != m.files.len() + 1 || m.files.len() > MAX_ENTRIES {
        return Err(AppError::validation("invalid_backup", "the archive contents do not match its manifest"));
    }
    if !m.files.iter().any(|f| f.path == "center.db") {
        return Err(AppError::validation("invalid_backup", "the archive has no database"));
    }
    let tmp = tempfile::tempdir()?;
    for f in &m.files {
        if !safe_entry(&f.path) || f.size > MAX_ENTRY {
            return Err(AppError::validation("invalid_backup", format!("unsafe entry {}", f.path)));
        }
        let mut e =
            zip.by_name(&f.path).map_err(|_| AppError::validation("invalid_backup", format!("missing {}", f.path)))?;
        let mut h = Sha256::new();
        let mut n = 0u64;
        let mut buf = vec![0u8; 64 * 1024];
        let mut db_out =
            if f.path == "center.db" { Some(std::fs::File::create(tmp.path().join("check.db"))?) } else { None };
        loop {
            let r = e.read(&mut buf)?;
            if r == 0 {
                break;
            }
            n += r as u64;
            if n > f.size {
                return Err(AppError::validation(
                    "invalid_backup",
                    format!("{} is damaged (larger than recorded)", f.path),
                ));
            }
            h.update(&buf[..r]);
            if let Some(o) = db_out.as_mut() {
                o.write_all(&buf[..r])?;
            }
        }
        if n != f.size || hex(&h.finalize()) != f.sha256 {
            return Err(AppError::validation("invalid_backup", format!("{} is damaged (checksum mismatch)", f.path)));
        }
    }
    let conn = Connection::open_with_flags(tmp.path().join("check.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if ok != "ok" {
        return Err(AppError::validation("invalid_backup", "the database in the backup is damaged"));
    }
    let v: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v > crate::db::latest_version(crate::db::MIGRATIONS) {
        return Err(AppError::validation("invalid_backup", "the backup comes from a newer Ivily Center; update first"));
    }
    Ok(m)
}

/// List backups (newest first).
pub fn list(data_dir: &Path) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = std::fs::read_dir(data_dir.join(DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with("ivily-center-") && n.ends_with(".zip")
        })
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            match read_manifest(&e.path()) {
                Ok(m) => BackupInfo { name, size, manifest: Some(m), error: None },
                Err(err) => BackupInfo { name, size, manifest: None, error: Some(err.to_string()) },
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.manifest
            .as_ref()
            .map(|m| m.created_at)
            .cmp(&a.manifest.as_ref().map(|m| m.created_at))
            .then(b.name.cmp(&a.name))
    });
    out
}

/// A backup file name from the UI → its path (only plain names inside the backup folder).
pub fn resolve(data_dir: &Path, name: &str) -> AppResult<PathBuf> {
    let ok = name.starts_with("ivily-center-")
        && name.ends_with(".zip")
        && !name.contains(['/', '\\', ':'])
        && name.len() <= 120;
    if !ok {
        return Err(AppError::validation("invalid_backup", "invalid backup name"));
    }
    let p = data_dir.join(DIR).join(name);
    if !p.is_file() {
        return Err(AppError::NotFound(format!("backup {name}")));
    }
    Ok(p)
}

/// Keep the newest `keep` automatic backups; manual, safety and imported backups are never removed.
pub fn apply_retention(data_dir: &Path, keep: usize) -> Vec<String> {
    let mut removed = Vec::new();
    let autos: Vec<BackupInfo> =
        list(data_dir).into_iter().filter(|b| b.manifest.as_ref().is_some_and(|m| m.kind == "automatic")).collect();
    for b in autos.into_iter().skip(keep.max(1)) {
        if std::fs::remove_file(data_dir.join(DIR).join(&b.name)).is_ok() {
            removed.push(b.name);
        }
    }
    removed
}

/// Copy an external archive into the backup folder after verifying it.
pub fn import(data_dir: &Path, src: &Path) -> AppResult<String> {
    let m = verify(src)?;
    let dir = data_dir.join(DIR);
    std::fs::create_dir_all(&dir)?;
    let secs = m.created_at / 1000;
    let (y, mo, d, h, mi, s) = civil(secs);
    let mut name = format!("ivily-center-imported-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}.zip");
    let mut i = 2;
    while dir.join(&name).exists() {
        name = format!("ivily-center-imported-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{i}.zip");
        i += 1;
    }
    let partial = dir.join(format!(".{name}.partial"));
    std::fs::copy(src, &partial)?;
    std::fs::rename(&partial, dir.join(&name))?;
    Ok(name)
}

/// Verify and extract an archive into `pending-restore/` (applied at the next start).
pub fn stage_restore(data_dir: &Path, archive: &Path) -> AppResult<Manifest> {
    let m = verify(archive)?;
    let pending = data_dir.join(PENDING);
    if pending.exists() {
        std::fs::remove_dir_all(&pending)?;
    }
    let staging = data_dir.join(format!(".{PENDING}-{}", crate::core::now_ms()));
    std::fs::create_dir_all(&staging)?;
    let res = (|| -> AppResult<()> {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?).map_err(zip_err)?;
        for f in &m.files {
            let mut e = zip.by_name(&f.path).map_err(zip_err)?;
            let out = staging.join(&f.path);
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::io::copy(&mut e, &mut std::fs::File::create(&out)?)?;
        }
        std::fs::write(
            staging.join("restore.json"),
            serde_json::to_vec(&m).map_err(|e| AppError::Internal(e.to_string()))?,
        )?;
        Ok(())
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    std::fs::rename(&staging, &pending)?;
    Ok(m)
}

/// Cancel a staged restore.
pub fn cancel_restore(data_dir: &Path) -> AppResult<bool> {
    let p = data_dir.join(PENDING);
    if p.exists() {
        std::fs::remove_dir_all(p)?;
        return Ok(true);
    }
    Ok(false)
}

/// Apply a staged restore. Called at startup **before** the database is opened. The replaced
/// data is moved to `restored-from-<ts>/` (kept, not deleted). Returns a message for the UI.
pub fn apply_pending(data_dir: &Path) -> Option<Result<String, String>> {
    let pending = data_dir.join(PENDING);
    let manifest_path = pending.join("restore.json");
    if !manifest_path.is_file() {
        return None;
    }
    let run = || -> AppResult<String> {
        let m: Manifest =
            serde_json::from_slice(&std::fs::read(&manifest_path)?).map_err(|e| AppError::Internal(e.to_string()))?;
        let aside = data_dir.join(format!("replaced-by-restore-{}", crate::core::now_ms()));
        std::fs::create_dir_all(&aside)?;
        // Move the current database (with WAL/SHM) and included folders aside.
        for name in ["center.db", "center.db-wal", "center.db-shm"] {
            let p = data_dir.join(name);
            if p.exists() {
                std::fs::rename(&p, aside.join(name))?;
            }
        }
        for d in INCLUDED_DIRS {
            let p = data_dir.join(d);
            if p.exists() {
                std::fs::rename(&p, aside.join(d))?;
            }
        }
        for f in &m.files {
            if !safe_entry(&f.path) {
                continue;
            }
            let dst = data_dir.join(&f.path);
            if let Some(dir) = dst.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::rename(pending.join(&f.path), &dst)?;
        }
        std::fs::remove_dir_all(&pending)?;
        Ok(format!("Restored the backup from {} (previous data kept in {}).", m.created_at, aside.display()))
    };
    Some(run().map_err(|e| e.to_string()))
}

#[cfg(test)]
mod tests;
