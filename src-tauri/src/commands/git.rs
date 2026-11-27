//! Git commands. Every command requires the `workspaceExecutables` trust capability (repository
//! configuration can run programs) and operates on the repository containing a workspace folder.

use crate::error::{AppError, AppResult};
use crate::git::{self, Branch, Commit, Git, Stash, Status};
use crate::state::AppState;
use crate::workspace::service;
use crate::workspace::trust::Capability;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

struct Repo {
    git: Git,
    top: PathBuf,
}

fn locate() -> AppResult<Git> {
    Git::locate().ok_or_else(|| {
        AppError::NotFound("Git is not installed. Install Git for Windows from https://git-scm.com/download/win".into())
    })
}

fn repo(state: &AppState, label: &str, root: usize) -> AppResult<Repo> {
    service::require_capability(state, label, Capability::WorkspaceExecutables)?;
    let ws =
        service::current(state, label).ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let folder = ws
        .roots()
        .get(root)
        .cloned()
        .ok_or_else(|| AppError::validation("invalid_root", "unknown workspace folder"))?;
    let git = locate()?;
    let (top, _) =
        git::discover(&git, &folder.path).ok_or_else(|| AppError::NotFound("not a Git repository".into()))?;
    Ok(Repo { git, top })
}

fn log_op(state: &AppState, args: &[&str]) {
    state.output.info("git", format!("git {}", args.join(" ")));
}

fn run_logged(state: &AppState, r: &Repo, args: &[&str]) -> AppResult<String> {
    log_op(state, args);
    let o = r.git.run(&r.top, args)?;
    let text = format!("{}{}", o.stdout, o.stderr);
    if !text.trim().is_empty() {
        state.output.info("git", text.trim_end().chars().take(8000).collect::<String>());
    }
    if o.code != 0 {
        return Err(git::git_error(&o));
    }
    Ok(o.stdout)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: usize,
    /// Repository top level, or null when the folder is not in a repository.
    pub top: Option<String>,
    /// Workspace folder relative to the repository top (`""` when they are the same).
    pub prefix: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repos {
    pub git_version: Option<String>,
    pub repos: Vec<RepoInfo>,
}

#[tauri::command]
pub fn git_repos(window: Window, state: State<'_, AppState>) -> AppResult<Repos> {
    service::require_capability(&state, window.label(), Capability::WorkspaceExecutables)?;
    let ws = service::current(&state, window.label())
        .ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let git = locate()?;
    let repos = ws
        .roots()
        .iter()
        .enumerate()
        .map(|(i, f)| match git::discover(&git, &f.path) {
            Some((top, _)) => RepoInfo {
                root: i,
                prefix: crate::fs::scope::rel_of(&top, &f.path).unwrap_or_default(),
                top: Some(top.display().to_string()),
            },
            None => RepoInfo { root: i, top: None, prefix: String::new() },
        })
        .collect();
    Ok(Repos { git_version: git.version(), repos })
}

#[tauri::command]
pub async fn git_status(app: AppHandle, window: Window, root: usize) -> AppResult<Status> {
    let state = app.state::<AppState>();
    let r = repo(&state, window.label(), root)?;
    tauri::async_runtime::spawn_blocking(move || git::status(&r.git, &r.top))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub fn git_stage(window: Window, state: State<'_, AppState>, root: usize, paths: Vec<String>) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    git::stage(&r.git, &r.top, &paths)
}

#[tauri::command]
pub fn git_unstage(window: Window, state: State<'_, AppState>, root: usize, paths: Vec<String>) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    git::unstage(&r.git, &r.top, &paths)
}

/// Discard working-tree changes of tracked files (the UI asks first).
#[tauri::command]
pub fn git_discard(window: Window, state: State<'_, AppState>, root: usize, paths: Vec<String>) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    log_op(&state, &["restore", "--worktree", "--", &format!("({} file(s))", paths.len())]);
    git::discard(&r.git, &r.top, &paths)
}

#[tauri::command]
pub fn git_commit(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    message: String,
    amend: bool,
    all: bool,
) -> AppResult<String> {
    let r = repo(&state, window.label(), root)?;
    let sha = git::commit(&r.git, &r.top, &message, amend, all)?;
    state.output.info("git", format!("committed {sha}{}", if amend { " (amend)" } else { "" }));
    Ok(sha)
}

#[tauri::command]
pub fn git_branches(window: Window, state: State<'_, AppState>, root: usize) -> AppResult<Vec<Branch>> {
    let r = repo(&state, window.label(), root)?;
    git::branches(&r.git, &r.top)
}

#[tauri::command]
pub fn git_branch_create(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    name: String,
    start: Option<String>,
    checkout: bool,
) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    git::check_ref_name(&r.git, &r.top, &name, true)?;
    let mut args = if checkout { vec!["switch", "-c", name.as_str()] } else { vec!["branch", name.as_str()] };
    if let Some(s) = start.as_deref() {
        if s.starts_with('-') {
            return Err(AppError::validation("invalid_ref", "invalid start point"));
        }
        args.push(s);
    }
    run_logged(&state, &r, &args).map(|_| ())
}

/// Switch branches. Git refuses when local changes would be overwritten (never forced).
#[tauri::command]
pub fn git_switch(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    name: String,
    remote: bool,
) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    if name.starts_with('-') {
        return Err(AppError::validation("invalid_ref", "invalid branch"));
    }
    if remote {
        // origin/feature → local tracking branch "feature"
        run_logged(&state, &r, &["switch", "--track", &name]).map(|_| ())
    } else {
        run_logged(&state, &r, &["switch", &name]).map(|_| ())
    }
}

/// Delete a branch. `force` (unmerged branches) is only sent after an explicit confirmation.
#[tauri::command]
pub fn git_branch_delete(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    name: String,
    force: bool,
) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    git::check_ref_name(&r.git, &r.top, &name, true)?;
    run_logged(&state, &r, &["branch", if force { "-D" } else { "-d" }, &name]).map(|_| ())
}

#[tauri::command]
pub async fn git_log(
    app: AppHandle,
    window: Window,
    root: usize,
    rev: Option<String>,
    path: Option<String>,
    skip: usize,
    limit: usize,
) -> AppResult<Vec<Commit>> {
    let state = app.state::<AppState>();
    let r = repo(&state, window.label(), root)?;
    tauri::async_runtime::spawn_blocking(move || git::log(&r.git, &r.top, rev.as_deref(), path.as_deref(), skip, limit))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    status: String,
    path: String,
    orig: Option<String>,
}

#[tauri::command]
pub fn git_commit_files(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    sha: String,
) -> AppResult<Vec<ChangedFile>> {
    let r = repo(&state, window.label(), root)?;
    Ok(git::commit_files(&r.git, &r.top, &sha)?
        .into_iter()
        .map(|(status, path, orig)| ChangedFile { status, path, orig })
        .collect())
}

/// File content at a revision (`HEAD`, `:0`..`:3`, a commit id, or `<sha>^` for its parent).
#[tauri::command]
pub fn git_show(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    rev: String,
    path: String,
) -> AppResult<Option<String>> {
    let r = repo(&state, window.label(), root)?;
    git::show(&r.git, &r.top, &rev, &path)
}

/// Network operations (fetch, pull, push). Never `--force`.
#[tauri::command]
pub async fn git_sync(
    app: AppHandle,
    window: Window,
    root: usize,
    action: String,
    set_upstream: Option<bool>,
) -> AppResult<String> {
    let state = app.state::<AppState>();
    let r = repo(&state, window.label(), root)?;
    let branch = git::status(&r.git, &r.top)?.branch;
    let args: Vec<String> = match action.as_str() {
        "fetch" => vec!["fetch".into(), "--prune".into()],
        "pull" => vec!["pull".into(), "--ff-only".into()],
        "pullRebase" => vec!["pull".into(), "--rebase".into()],
        "push" => {
            let mut a = vec!["push".into()];
            if set_upstream.unwrap_or(false) {
                let b = branch.ok_or_else(|| AppError::validation("detached", "cannot publish a detached HEAD"))?;
                a.extend(["--set-upstream".into(), "origin".into(), b]);
            }
            a
        }
        _ => return Err(AppError::validation("invalid_action", "unknown sync action")),
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app2.state::<AppState>();
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_logged(&st, &r, &refs)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub fn git_stashes(window: Window, state: State<'_, AppState>, root: usize) -> AppResult<Vec<Stash>> {
    let r = repo(&state, window.label(), root)?;
    git::stashes(&r.git, &r.top)
}

/// `action`: push | apply | pop | drop (drop is confirmed in the UI).
#[tauri::command]
pub fn git_stash(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    action: String,
    name: Option<String>,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    match action.as_str() {
        "push" => {
            let msg = message.unwrap_or_default();
            let mut args = vec!["stash", "push"];
            if include_untracked.unwrap_or(false) {
                args.push("--include-untracked");
            }
            if !msg.trim().is_empty() {
                args.extend(["-m", msg.trim()]);
            }
            run_logged(&state, &r, &args).map(|_| ())
        }
        "apply" | "pop" | "drop" => {
            let n = name.ok_or_else(|| AppError::validation("invalid_stash", "missing stash"))?;
            git::check_stash(&n)?;
            run_logged(&state, &r, &["stash", action.as_str(), &n]).map(|_| ())
        }
        _ => Err(AppError::validation("invalid_action", "unknown stash action")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    name: String,
    fetch: String,
    push: String,
}

#[tauri::command]
pub fn git_remotes(window: Window, state: State<'_, AppState>, root: usize) -> AppResult<Vec<Remote>> {
    let r = repo(&state, window.label(), root)?;
    let out = r.git.ok(&r.top, &["remote", "-v"])?;
    let mut remotes: Vec<Remote> = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let url = crate::output::redact::redact(f[1]);
        match remotes.iter_mut().find(|x| x.name == f[0]) {
            Some(x) if f[2] == "(push)" => x.push = url,
            Some(_) => {}
            None => remotes.push(Remote { name: f[0].into(), fetch: url.clone(), push: url }),
        }
    }
    Ok(remotes)
}

#[tauri::command]
pub fn git_remote(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    action: String,
    name: String,
    url: Option<String>,
) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    git::check_remote_name(&name)?;
    match action.as_str() {
        "add" => {
            let u = url.ok_or_else(|| AppError::validation("invalid_url", "missing URL"))?;
            git::check_remote_url(&u)?;
            run_logged(&state, &r, &["remote", "add", "--", &name, &u]).map(|_| ())
        }
        "remove" => run_logged(&state, &r, &["remote", "remove", &name]).map(|_| ()),
        _ => Err(AppError::validation("invalid_action", "unknown remote action")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    name: String,
    commit: String,
    subject: String,
}

#[tauri::command]
pub fn git_tags(window: Window, state: State<'_, AppState>, root: usize) -> AppResult<Vec<Tag>> {
    let r = repo(&state, window.label(), root)?;
    let out = r.git.ok(
        &r.top,
        &["tag", "--list", "--sort=-creatordate", "--format=%(refname:short)%00%(objectname:short)%00%(subject)"],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            (f.len() >= 3).then(|| Tag { name: f[0].into(), commit: f[1].into(), subject: f[2].into() })
        })
        .collect())
}

#[tauri::command]
pub fn git_tag(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    action: String,
    name: String,
    message: Option<String>,
    sha: Option<String>,
) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    git::check_ref_name(&r.git, &r.top, &name, false)?;
    match action.as_str() {
        "create" => {
            let msg = message.unwrap_or_default();
            let mut args = vec!["tag"];
            if !msg.trim().is_empty() {
                args.extend(["-a", "-m", msg.trim()]);
            }
            args.push(&name);
            if let Some(s) = sha.as_deref() {
                git::check_sha(s)?;
                args.push(s);
            }
            run_logged(&state, &r, &args).map(|_| ())
        }
        "delete" => run_logged(&state, &r, &["tag", "-d", &name]).map(|_| ()),
        _ => Err(AppError::validation("invalid_action", "unknown tag action")),
    }
}

/// History operations. `reset` with mode `hard` discards changes and is confirmed in the UI.
#[tauri::command]
pub fn git_operation(
    window: Window,
    state: State<'_, AppState>,
    root: usize,
    action: String,
    target: Option<String>,
    mode: Option<String>,
) -> AppResult<()> {
    let r = repo(&state, window.label(), root)?;
    let tgt = || -> AppResult<String> {
        let t = target.clone().ok_or_else(|| AppError::validation("invalid_ref", "missing target"))?;
        if t.starts_with('-') || t.len() > 250 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(AppError::validation("invalid_ref", "invalid target"));
        }
        Ok(t)
    };
    let args: Vec<String> = match action.as_str() {
        "merge" => vec!["merge".into(), "--no-edit".into(), tgt()?],
        "mergeAbort" => vec!["merge".into(), "--abort".into()],
        "rebase" => vec!["rebase".into(), tgt()?],
        "rebaseAbort" => vec!["rebase".into(), "--abort".into()],
        "rebaseContinue" => vec!["-c".into(), "core.editor=true".into(), "rebase".into(), "--continue".into()],
        "cherryPick" => {
            git::check_sha(&tgt()?)?;
            vec!["cherry-pick".into(), tgt()?]
        }
        "cherryPickAbort" => vec!["cherry-pick".into(), "--abort".into()],
        "revert" => {
            git::check_sha(&tgt()?)?;
            vec!["revert".into(), "--no-edit".into(), tgt()?]
        }
        "reset" => {
            let m = match mode.as_deref() {
                Some("soft") => "--soft",
                Some("mixed") | None => "--mixed",
                Some("hard") => "--hard",
                _ => return Err(AppError::validation("invalid_mode", "invalid reset mode")),
            };
            vec!["reset".into(), m.into(), tgt()?]
        }
        "init" => return Err(AppError::validation("invalid_action", "use git_init")),
        _ => return Err(AppError::validation("invalid_action", "unknown operation")),
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_logged(&state, &r, &refs).map(|_| ())
}

/// Initialise a repository in a workspace folder (explicit user action).
#[tauri::command]
pub fn git_init(window: Window, state: State<'_, AppState>, root: usize) -> AppResult<()> {
    service::require_capability(&state, window.label(), Capability::WorkspaceExecutables)?;
    let ws = service::current(&state, window.label())
        .ok_or_else(|| AppError::validation("no_workspace", "no workspace is open"))?;
    let folder = ws
        .roots()
        .get(root)
        .cloned()
        .ok_or_else(|| AppError::validation("invalid_root", "unknown workspace folder"))?;
    let git = locate()?;
    state.output.info("git", format!("git init in {}", folder.display()));
    git.ok(&folder.path, &["init"]).map(|_| ())
}

/// Append a pattern to the workspace folder's `.gitignore` (explicit user action).
#[tauri::command]
pub fn git_ignore(window: Window, state: State<'_, AppState>, root: usize, pattern: String) -> AppResult<()> {
    let p = pattern.trim();
    if p.is_empty() || p.len() > 1024 || p.contains('\n') || p.contains('\r') {
        return Err(AppError::validation("invalid_pattern", "invalid pattern"));
    }
    let target = crate::fs::target(&state, window.label(), root, ".gitignore")?;
    let existing = std::fs::read_to_string(&target.abs).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == p) {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(p);
    text.push('\n');
    std::fs::write(&target.abs, text)?;
    Ok(())
}

/// Clone a repository into a folder the user picks, then open it as the window's workspace.
#[tauri::command]
pub async fn git_clone(app: AppHandle, window: Window, url: String) -> AppResult<Option<service::WorkspaceInfo>> {
    git::check_remote_url(&url)?;
    let git = locate()?;
    let Some(parent) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a folder to clone into")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let name =
        url.trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or("repo").trim_end_matches(".git").to_string();
    crate::fs::scope::validate_name(&name)?;
    let target = parent.join(&name);
    if target.exists() {
        return Err(AppError::Conflict(format!("{} already exists", target.display())));
    }
    let state = app.state::<AppState>();
    state.output.info("git", format!("git clone {} {}", crate::output::redact::redact(&url), target.display()));
    let target2 = target.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        git.run(&parent, &["clone", "--", &url, &target2.display().to_string()])
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;
    if out.code != 0 {
        return Err(git::git_error(&out));
    }
    service::open_path(&state, window.label(), &target).map(Some)
}
