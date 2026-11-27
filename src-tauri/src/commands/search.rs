//! Search, replace and Quick Open commands (scoped to the calling window's workspace).

use crate::error::{AppError, AppResult};
use crate::search::{self, fuzzy, FileMatches, Query, SearchSummary};
use crate::state::AppState;
use crate::workspace::service;
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window};

fn exclude_setting(state: &AppState, label: &str) -> AppResult<Vec<String>> {
    let values = service::resolve_settings(state, label)?;
    Ok(values
        .values
        .get("files.exclude")
        .and_then(|v| v.value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect())
}

/// Run a search; batches of results stream over `on_results`. `id` is chosen by the UI and used
/// to cancel. Resolves to the summary when the search finished or was cancelled.
#[tauri::command]
pub async fn search_run(
    app: AppHandle,
    window: Window,
    id: u64,
    query: Query,
    on_results: Channel<Vec<FileMatches>>,
) -> AppResult<SearchSummary> {
    let state = app.state::<AppState>();
    let ws = service::current(&state, window.label())
        .ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let roots = ws.roots();
    let exclude = exclude_setting(&state, window.label())?;
    search::build_matcher(&query)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.searches.lock().insert(id, cancel.clone());
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        search::run(&roots, &exclude, &query, cancel, |batch| {
            let _ = on_results.send(batch);
        })
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()));
    app2.state::<AppState>().searches.lock().remove(&id);
    result?
}

#[tauri::command]
pub fn search_cancel(state: State<'_, AppState>, id: u64) {
    if let Some(flag) = state.searches.lock().get(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceTarget {
    pub root: usize,
    pub path: String,
    /// Hash of the file when the preview was computed (from the editor/explorer), optional.
    #[serde(default)]
    pub expected_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub root: usize,
    pub path: String,
    pub replacements: usize,
    pub error: Option<String>,
}

/// Replace in the files the user confirmed. Each file keeps its encoding and line endings and is
/// only written if it did not change since it was read here.
#[tauri::command]
pub async fn search_replace(
    app: AppHandle,
    window: Window,
    query: Query,
    replacement: String,
    files: Vec<ReplaceTarget>,
) -> AppResult<Vec<ReplaceResult>> {
    if files.len() > 10_000 {
        return Err(AppError::validation("too_many", "too many files"));
    }
    let state = app.state::<AppState>();
    let targets: Vec<_> = files
        .iter()
        .map(|f| crate::fs::target(&state, window.label(), f.root, &f.path).map(|t| (f, t)))
        .collect::<AppResult<_>>()?;
    let mut out = Vec::new();
    let mut total = 0;
    for (f, t) in targets {
        let r = (|| -> AppResult<usize> {
            let doc = crate::editor_io::read(&t.abs)?;
            if let Some(h) = &f.expected_hash {
                if h != &doc.hash {
                    return Err(AppError::Conflict("changed since the search".into()));
                }
            }
            let (content, n) = search::replace_in(&doc.content, &query, &replacement)?;
            if n > 0 {
                crate::editor_io::write(&t.abs, &content, doc.encoding, doc.eol, Some(&doc.hash), false)?;
            }
            Ok(n)
        })();
        match r {
            Ok(n) => {
                total += n;
                out.push(ReplaceResult { root: f.root, path: f.path.clone(), replacements: n, error: None });
            }
            Err(e) => out.push(ReplaceResult {
                root: f.root,
                path: f.path.clone(),
                replacements: 0,
                error: Some(e.to_string()),
            }),
        }
    }
    state.output.info(
        "app",
        format!("replace: {total} replacement(s) in {} file(s)", out.iter().filter(|r| r.replacements > 0).count()),
    );
    Ok(out)
}

/// Cached list of workspace files for Quick Open (rebuilt after file changes).
#[derive(Default)]
pub struct FileIndex {
    pub workspace: String,
    pub files: Vec<(usize, String)>,
    pub dirty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenItem {
    root: usize,
    path: String,
}

const MAX_INDEXED: usize = 300_000;

#[tauri::command]
pub async fn quick_open(
    app: AppHandle,
    window: Window,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<QuickOpenItem>> {
    let state = app.state::<AppState>();
    let label = window.label().to_string();
    let ws =
        service::current(&state, &label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let needs_build = state.file_index.lock().get(&label).is_none_or(|i| i.dirty || i.workspace != ws.record.id);
    if needs_build {
        let roots = ws.roots();
        let exclude = exclude_setting(&state, &label)?;
        let files = tauri::async_runtime::spawn_blocking(move || {
            let q = Query {
                pattern: "x".into(),
                is_regex: false,
                case_sensitive: false,
                whole_word: false,
                include: vec![],
                exclude: vec![],
                use_ignore: true,
                max_results: 1,
            };
            let cancel = AtomicBool::new(false);
            let mut files = Vec::new();
            for (i, r) in roots.iter().enumerate() {
                search::walk(r, &exclude, &q, &cancel, |rel, _| {
                    files.push((i, rel));
                    files.len() < MAX_INDEXED
                });
            }
            files
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
        state
            .file_index
            .lock()
            .insert(label.clone(), FileIndex { workspace: ws.record.id.clone(), files, dirty: false });
    }
    let index = state.file_index.lock();
    let idx = index.get(&label).ok_or_else(|| AppError::Internal("index missing".into()))?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let items = if query.trim().is_empty() {
        idx.files.iter().take(limit).map(|(r, p)| QuickOpenItem { root: *r, path: p.clone() }).collect()
    } else {
        fuzzy::best(&query, idx.files.iter().map(|(r, p)| (*r, p.as_str())), limit)
            .into_iter()
            .map(|(root, path, _)| QuickOpenItem { root, path })
            .collect()
    };
    Ok(items)
}

/// Invalidate the Quick Open index of a window (file watcher / workspace change).
pub fn invalidate_index(state: &AppState, label: &str) {
    if let Some(i) = state.file_index.lock().get_mut(label) {
        i.dirty = true;
    }
}
