//! Application updates (tauri-plugin-updater).
//!
//! * Update manifests are only accepted from this repository's GitHub Releases
//!   (`…/releases/latest/download/latest.json`).
//! * The installer is verified against the minisign public key **embedded in the app** (shared by
//!   all Ivily apps) before it is run; a package whose signature does not match is never installed.
//! * Nothing is downloaded or installed without an explicit user action. On Windows the verified
//!   NSIS installer runs in passive mode and the app closes; if the installer fails, the current
//!   installation stays in place.
//! * Checks and installs are recorded in a small history (app database).

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

pub const MANIFEST_URL: &str = "https://github.com/efecrtgl/ivily-center-main/releases/latest/download/latest.json";
const HISTORY_KEY: &str = "update.history";
const LAST_CHECK_KEY: &str = "update.lastCheck";
const MAX_HISTORY: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at: i64,
    /// `check`, `install`.
    pub kind: String,
    /// `upToDate`, `available`, `failed`, `started`.
    pub outcome: String,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub current_version: String,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub checked_at: i64,
}

fn record(state: &AppState, e: HistoryEntry) {
    let db = state.db.lock();
    let mut h: Vec<HistoryEntry> = crate::app_state::get(&db, HISTORY_KEY).ok().flatten().unwrap_or_default();
    h.insert(0, e);
    h.truncate(MAX_HISTORY);
    let _ = crate::app_state::set(&db, HISTORY_KEY, &h);
}

fn map_err(e: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::SignatureUtf8(_) | E::Base64(_) => {
            AppError::PermissionDenied("the update's signature could not be verified; nothing was installed".into())
        }
        E::Reqwest(_) | E::Network(_) => {
            AppError::Io("the update server could not be reached; check the internet connection".into())
        }
        E::ReleaseNotFound => AppError::NotFound("no release has been published yet".into()),
        other => AppError::Io(format!("update failed: {other}")),
    }
}

fn updater(app: &AppHandle) -> AppResult<tauri_plugin_updater::Updater> {
    let url = tauri::Url::parse(MANIFEST_URL).map_err(|e| AppError::Internal(e.to_string()))?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(map_err)?
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(map_err)
}

/// Ask GitHub Releases whether a newer version exists (no download).
#[tauri::command]
pub async fn update_check(app: AppHandle) -> AppResult<CheckResult> {
    let state = app.state::<AppState>();
    let current = app.package_info().version.to_string();
    let now = crate::core::now_ms();
    let res = updater(&app)?.check().await.map_err(map_err);
    let result = match res {
        Ok(Some(u)) => CheckResult {
            current_version: current,
            available: true,
            version: Some(u.version.clone()),
            notes: u.body.clone().map(|b| b.chars().take(20_000).collect()),
            date: u.date.map(|d| d.to_string()),
            checked_at: now,
        },
        Ok(None) => CheckResult {
            current_version: current,
            available: false,
            version: None,
            notes: None,
            date: None,
            checked_at: now,
        },
        Err(e) => {
            record(
                &state,
                HistoryEntry {
                    at: now,
                    kind: "check".into(),
                    outcome: "failed".into(),
                    version: None,
                    message: Some(e.to_string()),
                },
            );
            return Err(e);
        }
    };
    record(
        &state,
        HistoryEntry {
            at: now,
            kind: "check".into(),
            outcome: if result.available { "available" } else { "upToDate" }.into(),
            version: result.version.clone(),
            message: None,
        },
    );
    let _ = crate::app_state::set(&state.db.lock(), LAST_CHECK_KEY, &result);
    Ok(result)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    stage: &'static str,
    downloaded: u64,
    total: u64,
}

/// Download, verify and install `expected_version` (explicit user action). On success the
/// installer starts and the app exits.
#[tauri::command]
pub async fn update_install(app: AppHandle, expected_version: String) -> AppResult<()> {
    let state = app.state::<AppState>();
    let update = updater(&app)?
        .check()
        .await
        .map_err(map_err)?
        .ok_or_else(|| AppError::NotFound("no newer version is available".into()))?;
    if update.version.trim_start_matches('v') != expected_version.trim_start_matches('v') {
        return Err(AppError::Conflict("the available version changed; check again".into()));
    }
    let _ = app.emit("update://progress", Progress { stage: "downloading", downloaded: 0, total: 0 });
    let mut downloaded = 0u64;
    let a = app.clone();
    let bytes = update
        .download(
            move |n, total| {
                downloaded += n as u64;
                let _ = a.emit(
                    "update://progress",
                    Progress { stage: "downloading", downloaded, total: total.unwrap_or(0) },
                );
            },
            || {},
        )
        .await
        .map_err(|e| {
            let err = map_err(e);
            record(
                &app.state::<AppState>(),
                HistoryEntry {
                    at: crate::core::now_ms(),
                    kind: "install".into(),
                    outcome: "failed".into(),
                    version: Some(expected_version.clone()),
                    message: Some(err.to_string()),
                },
            );
            err
        })?;
    // download() verified the signature against the embedded public key.
    record(
        &state,
        HistoryEntry {
            at: crate::core::now_ms(),
            kind: "install".into(),
            outcome: "started".into(),
            version: Some(update.version.clone()),
            message: None,
        },
    );
    state.output.info("app", format!("installing update {}", update.version));
    let _ = app.emit(
        "update://progress",
        Progress { stage: "installing", downloaded: bytes.len() as u64, total: bytes.len() as u64 },
    );
    {
        // The installer closes the app: record a clean exit and flush the database first.
        let db = state.db.lock();
        let _ = crate::workspace::session::mark_clean_exit(&db);
        let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    update.install(&bytes).map_err(map_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    last_check: Option<CheckResult>,
    history: Vec<HistoryEntry>,
    manifest_url: &'static str,
}

#[tauri::command]
pub fn update_info(app: AppHandle, state: State<'_, AppState>) -> AppResult<UpdateInfo> {
    let db = state.db.lock();
    Ok(UpdateInfo {
        current_version: app.package_info().version.to_string(),
        last_check: crate::app_state::get(&db, LAST_CHECK_KEY).ok().flatten(),
        history: crate::app_state::get(&db, HISTORY_KEY).ok().flatten().unwrap_or_default(),
        manifest_url: MANIFEST_URL,
    })
}
