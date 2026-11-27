//! Git integration through the system `git` executable.
//!
//! * `git` is located by absolute path (never a bare name) and run without a shell, with
//!   `GIT_TERMINAL_PROMPT=0` (credential helpers such as Git Credential Manager may still show
//!   their own windows), `core.quotepath=false`, no colour and no pager.
//! * Output is parsed from machine formats only (`status --porcelain=v2 -z`, NUL-separated
//!   `log`/`for-each-ref` formats).
//! * Repository configuration can execute programs (hooks, fsmonitor, filters, external diff), so
//!   every operation requires the `workspaceExecutables` trust capability (checked by the commands).
//! * There is no force push anywhere. Destructive operations (discard, hard reset, branch force
//!   delete, stash drop) exist only as explicit functions the UI calls after a confirmation.

pub mod parse;

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub use parse::{Branch, Commit, FileStatus, Stash, Status};

/// A located git executable.
#[derive(Debug, Clone)]
pub struct Git {
    pub exe: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

const MAX_OUTPUT: usize = 32 * 1024 * 1024;

impl Git {
    pub fn locate() -> Option<Self> {
        crate::toolchains::which("git").map(|exe| Self { exe })
    }

    fn command(&self, cwd: &Path, args: &[&str]) -> Command {
        let mut cmd = Command::new(&self.exe);
        cmd.current_dir(cwd)
            .args(["-c", "core.quotepath=false", "-c", "color.ui=never", "-c", "core.pager=cat", "--no-pager"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::core::process::CREATE_NO_WINDOW);
        }
        cmd
    }

    /// Run git and capture output (no stdin).
    pub fn run(&self, cwd: &Path, args: &[&str]) -> AppResult<Output> {
        self.run_with_input(cwd, args, None)
    }

    pub fn run_with_input(&self, cwd: &Path, args: &[&str], input: Option<&[u8]>) -> AppResult<Output> {
        let mut cmd = self.command(cwd, args);
        cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
        let mut child = cmd.spawn().map_err(|e| AppError::Io(format!("could not run git: {e}")))?;
        if let Some(data) = input {
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(data)?;
            }
        }
        let out = child.wait_with_output()?;
        if out.stdout.len() > MAX_OUTPUT {
            return Err(AppError::validation("too_large", "git output is too large"));
        }
        Ok(Output {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    /// Run and fail with git's message on a non-zero exit code.
    pub fn ok(&self, cwd: &Path, args: &[&str]) -> AppResult<String> {
        let o = self.run(cwd, args)?;
        if o.code != 0 {
            return Err(git_error(&o));
        }
        Ok(o.stdout)
    }

    pub fn version(&self) -> Option<String> {
        let o = self.run(&std::env::temp_dir(), &["--version"]).ok()?;
        crate::toolchains::parse_version(&o.stdout)
    }
}

pub fn git_error(o: &Output) -> AppError {
    let msg = if o.stderr.trim().is_empty() { o.stdout.trim() } else { o.stderr.trim() };
    let msg: String = crate::output::redact::redact(msg).chars().take(4000).collect();
    if msg.contains("CONFLICT") || msg.contains("Merge conflict") || msg.contains("would be overwritten") {
        AppError::Conflict(msg)
    } else {
        AppError::Io(if msg.is_empty() { format!("git exited with code {}", o.code) } else { msg })
    }
}

/// The repository containing `dir`, if any: `(top-level, git-dir)`.
pub fn discover(git: &Git, dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let o = git.run(dir, &["rev-parse", "--show-toplevel", "--absolute-git-dir"]).ok()?;
    if o.code != 0 {
        return None;
    }
    let mut lines = o.stdout.lines();
    let top = PathBuf::from(lines.next()?.trim());
    let gitdir = PathBuf::from(lines.next()?.trim());
    Some((dunce::canonicalize(&top).unwrap_or(top), gitdir))
}

/// Validate a branch / tag name with git's own rules (no option-like names).
pub fn check_ref_name(git: &Git, cwd: &Path, name: &str, branch: bool) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') || name.len() > 250 {
        return Err(AppError::validation("invalid_ref", "invalid name"));
    }
    let o = if branch {
        git.run(cwd, &["check-ref-format", "--branch", name])?
    } else {
        git.run(cwd, &["check-ref-format", &format!("refs/tags/{name}")])?
    };
    if o.code != 0 {
        return Err(AppError::validation("invalid_ref", format!("'{name}' is not a valid name")));
    }
    Ok(())
}

/// Paths given to git are always relative to the repository and placed after `--`.
pub fn validate_paths(paths: &[String]) -> AppResult<()> {
    if paths.is_empty() || paths.len() > 10_000 {
        return Err(AppError::validation("invalid_paths", "no paths or too many paths"));
    }
    for p in paths {
        crate::fs::scope::normalize_rel(p)?;
    }
    Ok(())
}

pub fn status(git: &Git, repo: &Path) -> AppResult<Status> {
    let out = git.ok(
        repo,
        &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"],
    )?;
    let mut st = parse::parse_status(&out);
    // Operation in progress?
    let gitdir = PathBuf::from(git.ok(repo, &["rev-parse", "--absolute-git-dir"])?.trim());
    st.operation = if gitdir.join("MERGE_HEAD").exists() {
        Some("merge")
    } else if gitdir.join("rebase-merge").exists() || gitdir.join("rebase-apply").exists() {
        Some("rebase")
    } else if gitdir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick")
    } else if gitdir.join("REVERT_HEAD").exists() {
        Some("revert")
    } else {
        None
    };
    Ok(st)
}

pub fn stage(git: &Git, repo: &Path, paths: &[String]) -> AppResult<()> {
    validate_paths(paths)?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git.ok(repo, &args).map(|_| ())
}

pub fn unstage(git: &Git, repo: &Path, paths: &[String]) -> AppResult<()> {
    validate_paths(paths)?;
    // Works before the first commit too (restore --staged needs HEAD).
    let has_head = git.run(repo, &["rev-parse", "--verify", "-q", "HEAD"])?.code == 0;
    let mut args: Vec<&str> =
        if has_head { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "-q", "--"] };
    args.extend(paths.iter().map(String::as_str));
    git.ok(repo, &args).map(|_| ())
}

/// Discard working-tree changes of tracked files (the UI confirms first). Untracked files are
/// not deleted here — the UI moves them to the Recycle Bin through the file operations.
pub fn discard(git: &Git, repo: &Path, paths: &[String]) -> AppResult<()> {
    validate_paths(paths)?;
    let mut args = vec!["restore", "--worktree", "--"];
    args.extend(paths.iter().map(String::as_str));
    git.ok(repo, &args).map(|_| ())
}

pub fn commit(git: &Git, repo: &Path, message: &str, amend: bool, all: bool) -> AppResult<String> {
    let message = message.trim();
    if message.is_empty() && !amend {
        return Err(AppError::validation("empty_message", "enter a commit message"));
    }
    if message.len() > 100_000 {
        return Err(AppError::validation("too_large", "the commit message is too long"));
    }
    let mut args = vec!["commit", "--file", "-", "--cleanup=strip"];
    if amend {
        args.push("--amend");
        if message.is_empty() {
            args = vec!["commit", "--amend", "--no-edit"];
        }
    }
    if all {
        args.push("--all");
    }
    let o = git.run_with_input(repo, &args, Some(message.as_bytes()))?;
    if o.code != 0 {
        return Err(git_error(&o));
    }
    Ok(git.ok(repo, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

pub fn branches(git: &Git, repo: &Path) -> AppResult<Vec<Branch>> {
    let out = git.ok(
        repo,
        &["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(HEAD)%00%(objectname:short)%00%(committerdate:unix)%00%(upstream:track)%00", "refs/heads", "refs/remotes"],
    )?;
    Ok(parse::parse_branches(&out))
}

pub fn log(
    git: &Git,
    repo: &Path,
    rev: Option<&str>,
    path: Option<&str>,
    skip: usize,
    limit: usize,
) -> AppResult<Vec<Commit>> {
    let skip = format!("--skip={skip}");
    let limit = format!("--max-count={}", limit.clamp(1, 1000));
    let mut args = vec!["log", "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%D%x00%s%x00%x1e", &skip, &limit];
    if let Some(r) = rev {
        if r.starts_with('-') {
            return Err(AppError::validation("invalid_ref", "invalid revision"));
        }
        args.push(r);
    }
    args.push("--");
    if let Some(p) = path {
        crate::fs::scope::normalize_rel(p)?;
        args.push(p);
    }
    Ok(parse::parse_log(&git.ok(repo, &args)?))
}

/// Files changed by a commit: `(status letter, path, original path for renames)`.
pub fn commit_files(git: &Git, repo: &Path, sha: &str) -> AppResult<Vec<(String, String, Option<String>)>> {
    check_sha(sha)?;
    let out = git.ok(repo, &["diff-tree", "--no-commit-id", "-r", "-z", "--name-status", "-M", "--root", sha])?;
    Ok(parse::parse_name_status(&out))
}

pub fn check_sha(sha: &str) -> AppResult<()> {
    if (4..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::validation("invalid_sha", "invalid commit id"))
    }
}

/// Content of `path` at a revision: `HEAD`, `:0`/`:1`/`:2`/`:3` (index stages) or a commit id.
/// Returns `None` if the file does not exist there.
pub fn show(git: &Git, repo: &Path, rev: &str, path: &str) -> AppResult<Option<String>> {
    crate::fs::scope::normalize_rel(path)?;
    let spec = match rev {
        "HEAD" => format!("HEAD:{path}"),
        ":0" | ":1" | ":2" | ":3" => format!("{rev}:{path}"),
        sha => {
            let (base, parent) = sha.strip_suffix('^').map(|b| (b, true)).unwrap_or((sha, false));
            check_sha(base)?;
            format!("{base}{}:{path}", if parent { "^" } else { "" })
        }
    };
    let o = git.run(repo, &["show", &spec])?;
    if o.code != 0 {
        return Ok(None);
    }
    if o.stdout.len() > 16 * 1024 * 1024 || o.stdout.contains('\0') {
        return Err(AppError::validation("binary", "binary or very large file"));
    }
    Ok(Some(o.stdout))
}

pub fn stashes(git: &Git, repo: &Path) -> AppResult<Vec<Stash>> {
    Ok(parse::parse_stashes(&git.ok(repo, &["stash", "list", "--format=%gd%x00%s%x00%ct%x00"])?))
}

pub fn check_stash(name: &str) -> AppResult<()> {
    let ok = name
        .strip_prefix("stash@{")
        .and_then(|r| r.strip_suffix('}'))
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    if ok {
        Ok(())
    } else {
        Err(AppError::validation("invalid_stash", "invalid stash"))
    }
}

/// Validate a remote URL / name for clone, remote add, push targets.
pub fn check_remote_url(url: &str) -> AppResult<()> {
    let ok = !url.starts_with('-')
        && url.len() < 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && (url.starts_with("https://")
            || url.starts_with("http://")
            || url.starts_with("ssh://")
            || url.starts_with("git://")
            || (url.contains('@') && url.contains(':') && !url.contains("::")))
        && !url.to_ascii_lowercase().starts_with("ext::");
    if ok {
        Ok(())
    } else {
        Err(AppError::validation("invalid_url", "use an https://, ssh:// or user@host:path repository URL"))
    }
}

pub fn check_remote_name(name: &str) -> AppResult<()> {
    if !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        Ok(())
    } else {
        Err(AppError::validation("invalid_remote", "invalid remote name"))
    }
}

#[cfg(test)]
mod tests;
