//! Tasks: definitions from `.ivily/tasks.json`, `.vscode/tasks.json` (common subset), npm scripts
//! and Cargo, resolved **in the backend** so the command that is approved is exactly the command
//! that runs.
//!
//! Safety:
//! * Running any task requires the workspace trust capability `taskExecution`.
//! * Every task needs an explicit approval of its exact command line on first run (per workspace;
//!   a changed command needs a new approval). Approvals can be revoked.
//! * Working directories must stay inside the workspace folder. Unsupported `${…}` variables make
//!   a task unavailable instead of being passed through.
//! * Shell tasks run in PowerShell via `-EncodedCommand` (no quoting ambiguities) or in cmd.exe
//!   when configured (then double quotes are refused). npm script names are validated before they
//!   reach `npm.cmd`.

use crate::error::{AppError, AppResult};
use crate::workspace::paths::NormalizedPath;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub mod jsonc;

const MAX_TASKS: usize = 500;
const MAX_FILE: u64 = 1024 * 1024;

/// How a task is started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Exec {
    /// A command line for the task shell.
    Shell { line: String },
    /// A program started directly (resolved on PATH when not absolute).
    Process { program: String, args: Vec<String> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub label: String,
    /// `ivily`, `vscode`, `npm` or `cargo`.
    pub source: &'static str,
    pub root: usize,
    pub exec: Option<Exec>,
    /// Working directory relative to the workspace folder (`""` = the folder itself).
    pub cwd: String,
    pub group: Option<String>,
    pub depends_on: Vec<String>,
    /// `sequence` (default) or `parallel`.
    pub depends_order: String,
    pub problem_matchers: Vec<String>,
    pub detail: Option<String>,
    /// Why the task cannot run (unsupported variable, bad cwd, …).
    pub error: Option<String>,
}

impl Task {
    /// Human-readable command (shown in the approval dialog).
    pub fn display(&self) -> String {
        match &self.exec {
            Some(Exec::Shell { line }) => line.clone(),
            Some(Exec::Process { program, args }) => std::iter::once(program.clone())
                .chain(args.iter().map(|a| quote_display(a)))
                .collect::<Vec<_>>()
                .join(" "),
            None => String::new(),
        }
    }

    /// Fingerprint used for approvals: everything that determines what runs.
    pub fn fingerprint(&self, workspace_id: &str) -> String {
        let mut h = Sha256::new();
        h.update(workspace_id.as_bytes());
        h.update([0]);
        h.update(self.id.as_bytes());
        h.update([0]);
        h.update(serde_json::to_vec(&self.exec).unwrap_or_default());
        h.update([0]);
        h.update(self.cwd.as_bytes());
        hex(&h.finalize())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn quote_display(a: &str) -> String {
    if a.is_empty() || a.contains([' ', '\t', '"']) {
        format!("\"{}\"", a.replace('"', "\\\""))
    } else {
        a.to_string()
    }
}

/// Substitute the supported variables; any other `${…}` is an error.
pub fn substitute(s: &str, folder: &Path) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let end = after.find('}').ok_or_else(|| "unterminated ${".to_string())?;
        let name = &after[..end];
        match name {
            "workspaceFolder" | "workspaceRoot" => out.push_str(&folder.to_string_lossy()),
            "workspaceFolderBasename" => {
                out.push_str(&folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            }
            "pathSeparator" | "/" => out.push('\\'),
            other => return Err(format!("unsupported variable ${{{other}}}")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Resolve a task working directory inside `folder`. Returns the relative form.
pub fn resolve_cwd(folder: &Path, raw: Option<&str>) -> Result<String, String> {
    let Some(raw) = raw.filter(|r| !r.trim().is_empty()) else { return Ok(String::new()) };
    let sub = substitute(raw, folder)?;
    let p = PathBuf::from(&sub);
    let abs = if p.is_absolute() { p } else { folder.join(p) };
    let canon = dunce::canonicalize(&abs).map_err(|_| format!("working directory not found: {sub}"))?;
    let root = dunce::canonicalize(folder).map_err(|e| e.to_string())?;
    let rel = canon.strip_prefix(&root).map_err(|_| "working directory is outside the workspace folder".to_string())?;
    if !canon.is_dir() {
        return Err("working directory is not a folder".into());
    }
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec![],
    }
}

fn matcher_names(v: Option<&Value>) -> Vec<String> {
    str_list(v)
        .into_iter()
        .map(|m| m.trim_start_matches('$').to_string())
        .filter(|m| KNOWN_MATCHERS.contains(&m.as_str()))
        .collect()
}

/// Problem matchers implemented by the UI.
pub const KNOWN_MATCHERS: [&str; 6] = ["rustc", "tsc", "eslint-compact", "eslint-stylish", "gcc", "msCompile"];

fn valid_label(l: &str) -> bool {
    !l.trim().is_empty() && l.len() <= 120 && !l.chars().any(char::is_control)
}

/// npm script names that can be passed to `npm.cmd run` without cmd.exe interpreting anything.
pub fn safe_script_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 100
        && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.' | '@' | '/' | '+'))
}

/// Parse one task object (`.ivily/tasks.json` or `.vscode/tasks.json` format).
fn parse_task(obj: &Value, source: &'static str, root: usize, folder: &Path) -> Option<Task> {
    let o = obj.as_object()?;
    // VS Code: `windows` overrides command/args/options.
    let win = o.get("windows").and_then(Value::as_object);
    let pick = |k: &str| win.and_then(|w| w.get(k)).or_else(|| o.get(k));
    let ty = o.get("type").and_then(Value::as_str).unwrap_or("shell");
    let label = o
        .get("label")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| match ty {
            "npm" => o.get("script").and_then(Value::as_str).map(|s| format!("npm: {s}")),
            "cargo" => o.get("command").and_then(Value::as_str).map(|s| format!("cargo {s}")),
            _ => None,
        })
        .filter(|l| valid_label(l))?;
    let options = pick("options").and_then(Value::as_object);
    let mut error = None;
    let cwd = match resolve_cwd(folder, options.and_then(|x| x.get("cwd")).and_then(Value::as_str)) {
        Ok(c) => c,
        Err(e) => {
            error = Some(e);
            String::new()
        }
    };
    let sub = |s: &str, error: &mut Option<String>| match substitute(s, folder) {
        Ok(v) => v,
        Err(e) => {
            error.get_or_insert(e);
            String::new()
        }
    };
    let command = pick("command").and_then(Value::as_str);
    let args: Vec<String> = pick("args").map(|a| str_list(Some(a))).unwrap_or_default();
    let exec = match ty {
        "shell" => match command {
            Some(c) => {
                let mut line = sub(c, &mut error);
                for a in &args {
                    line.push(' ');
                    line.push_str(&quote_display(&sub(a, &mut error)));
                }
                Some(Exec::Shell { line })
            }
            None => None, // composite task (dependsOn only)
        },
        "process" => command.map(|c| Exec::Process {
            program: sub(c, &mut error),
            args: args.iter().map(|a| sub(a, &mut error)).collect(),
        }),
        "npm" => match o.get("script").and_then(Value::as_str) {
            Some(s) if safe_script_name(s) => {
                Some(Exec::Process { program: "npm".into(), args: vec!["run".into(), s.into()] })
            }
            _ => {
                error = Some("unsupported npm script name".into());
                None
            }
        },
        "cargo" => {
            let mut a = vec![command.unwrap_or("build").to_string()];
            a.extend(args.iter().map(|x| sub(x, &mut error)));
            Some(Exec::Process { program: "cargo".into(), args: a })
        }
        other => {
            error = Some(format!("task type '{other}' is not supported"));
            None
        }
    };
    let depends_on = str_list(o.get("dependsOn"));
    if exec.is_none() && depends_on.is_empty() && error.is_none() {
        error = Some("the task has no command".into());
    }
    let group = match o.get("group") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(g)) => g.get("kind").and_then(Value::as_str).map(String::from),
        _ => None,
    };
    let mut matchers = matcher_names(o.get("problemMatcher"));
    if matchers.is_empty() && ty == "cargo" {
        matchers.push("rustc".into());
    }
    Some(Task {
        id: format!("{source}:{root}:{label}"),
        label,
        source,
        root,
        exec,
        cwd,
        group,
        depends_on,
        depends_order: o
            .get("dependsOrder")
            .and_then(Value::as_str)
            .filter(|v| *v == "parallel")
            .unwrap_or("sequence")
            .into(),
        problem_matchers: matchers,
        detail: o.get("detail").and_then(Value::as_str).map(|d| d.chars().take(200).collect()),
        error,
    })
}

fn read_small(p: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(p).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read_to_string(p).ok()
}

/// Problems found while reading task files (shown in the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadIssue {
    pub root: usize,
    pub file: String,
    pub message: String,
}

/// All tasks of the workspace folders.
pub fn discover(roots: &[NormalizedPath]) -> (Vec<Task>, Vec<LoadIssue>) {
    let mut tasks = Vec::new();
    let mut issues = Vec::new();
    for (root, r) in roots.iter().enumerate() {
        let folder = r.path.as_path();
        for (file, source) in [(".ivily/tasks.json", "ivily"), (".vscode/tasks.json", "vscode")] {
            let Some(text) = read_small(&folder.join(file)) else { continue };
            match jsonc::parse(&text) {
                Ok(v) => {
                    for t in v.get("tasks").and_then(Value::as_array).into_iter().flatten() {
                        match parse_task(t, source, root, folder) {
                            Some(task) => tasks.push(task),
                            None => issues.push(LoadIssue {
                                root,
                                file: file.into(),
                                message: "a task without a valid label was ignored".into(),
                            }),
                        }
                    }
                }
                Err(e) => issues.push(LoadIssue { root, file: file.into(), message: e }),
            }
        }
        if let Some(text) = read_small(&folder.join("package.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                for (name, cmd) in v.get("scripts").and_then(Value::as_object).into_iter().flatten() {
                    if !safe_script_name(name) {
                        continue;
                    }
                    tasks.push(Task {
                        id: format!("npm:{root}:{name}"),
                        label: format!("npm: {name}"),
                        source: "npm",
                        root,
                        exec: Some(Exec::Process { program: "npm".into(), args: vec!["run".into(), name.clone()] }),
                        cwd: String::new(),
                        group: match name.as_str() {
                            "build" => Some("build".into()),
                            "test" => Some("test".into()),
                            _ => None,
                        },
                        depends_on: vec![],
                        depends_order: "sequence".into(),
                        problem_matchers: vec![],
                        detail: cmd.as_str().map(|c| c.chars().take(200).collect()),
                        error: None,
                    });
                }
            }
        }
        if folder.join("Cargo.toml").is_file() {
            for (sub, group) in [
                ("build", Some("build")),
                ("check", Some("build")),
                ("test", Some("test")),
                ("run", None),
                ("clippy", None),
            ] {
                tasks.push(Task {
                    id: format!("cargo:{root}:{sub}"),
                    label: format!("cargo {sub}"),
                    source: "cargo",
                    root,
                    exec: Some(Exec::Process { program: "cargo".into(), args: vec![sub.into()] }),
                    cwd: String::new(),
                    group: group.map(String::from),
                    depends_on: vec![],
                    depends_order: "sequence".into(),
                    problem_matchers: vec!["rustc".into()],
                    detail: None,
                    error: None,
                });
            }
        }
    }
    // Workspace-defined tasks win over detected ones with the same label in the same folder.
    let mut seen = std::collections::HashSet::new();
    tasks.retain(|t| seen.insert((t.root, t.label.clone())));
    tasks.truncate(MAX_TASKS);
    (tasks, issues)
}

/// Resolve dependencies of `id` into a run order (dependencies first). Detects cycles and
/// unknown tasks. Dependencies are looked up by label in the same folder first, then anywhere.
pub fn plan<'a>(tasks: &'a [Task], id: &str) -> AppResult<Vec<&'a Task>> {
    fn visit<'a>(tasks: &'a [Task], t: &'a Task, stack: &mut Vec<String>, out: &mut Vec<&'a Task>) -> AppResult<()> {
        if out.iter().any(|x| x.id == t.id) {
            return Ok(());
        }
        if stack.contains(&t.id) {
            return Err(AppError::validation("task_cycle", format!("tasks depend on each other: {}", t.label)));
        }
        if stack.len() > 32 {
            return Err(AppError::validation("task_depth", "task dependencies are nested too deeply"));
        }
        stack.push(t.id.clone());
        for d in &t.depends_on {
            let dep = tasks
                .iter()
                .find(|x| x.root == t.root && &x.label == d)
                .or_else(|| tasks.iter().find(|x| &x.label == d))
                .ok_or_else(|| AppError::NotFound(format!("task '{d}' (needed by '{}')", t.label)))?;
            visit(tasks, dep, stack, out)?;
        }
        stack.pop();
        out.push(t);
        Ok(())
    }
    let t = tasks.iter().find(|t| t.id == id).ok_or_else(|| AppError::NotFound(format!("task {id}")))?;
    let mut out = Vec::new();
    visit(tasks, t, &mut Vec::new(), &mut out)?;
    Ok(out)
}

/// The shell used for shell tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Pwsh,
    PowerShell,
    Cmd,
}

fn system32() -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32")
}

/// Program and arguments for a task.
pub fn command_for(exec: &Exec, shell: Shell) -> AppResult<(PathBuf, Vec<String>)> {
    match exec {
        Exec::Process { program, args } => {
            let p = PathBuf::from(program);
            let resolved = if p.is_absolute() {
                p
            } else {
                crate::toolchains::which(program)
                    .ok_or_else(|| AppError::NotFound(format!("'{program}' was not found on PATH")))?
            };
            Ok((resolved, args.clone()))
        }
        Exec::Shell { line } => match shell {
            Shell::Cmd => {
                if line.contains('"') {
                    return Err(AppError::validation(
                        "cmd_quotes",
                        "commands with double quotes cannot run with the cmd task shell; use PowerShell (setting tasks.shell) or a process task",
                    ));
                }
                let mut args = vec!["/d".to_string(), "/c".to_string()];
                args.extend(line.split_whitespace().map(String::from));
                Ok((system32().join("cmd.exe"), args))
            }
            Shell::Pwsh | Shell::PowerShell => {
                let exe = if shell == Shell::Pwsh {
                    crate::toolchains::which("pwsh")
                        .ok_or_else(|| AppError::NotFound("PowerShell 7 (pwsh) was not found".into()))?
                } else {
                    system32().join(r"WindowsPowerShell\v1.0\powershell.exe")
                };
                Ok((exe, vec!["-NoLogo".into(), "-NoProfile".into(), "-EncodedCommand".into(), encode_ps(line)]))
            }
        },
    }
}

/// PowerShell `-EncodedCommand` payload: the line plus exit-code propagation.
pub fn encode_ps(line: &str) -> String {
    let script =
        format!("{line}\n$__ok = $?\nif ($LASTEXITCODE) {{ exit $LASTEXITCODE }} elseif (-not $__ok) {{ exit 1 }}\n");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Pick the shell from the `tasks.shell` setting.
pub fn shell_from_setting(v: &str) -> Shell {
    match v {
        "cmd" => Shell::Cmd,
        "powershell" => Shell::PowerShell,
        "pwsh" => Shell::Pwsh,
        _ => {
            if crate::toolchains::which("pwsh").is_some() {
                Shell::Pwsh
            } else {
                Shell::PowerShell
            }
        }
    }
}

#[cfg(test)]
mod tests;
