//! Debug Adapter Protocol: adapter discovery, launch configurations and adapter processes.
//!
//! * Adapters are found on the machine (debugpy, lldb-dap, netcoredbg) or configured by the user
//!   (`debug.adapters`: `type|C:\absolute\adapter.exe|args`). Nothing is installed.
//! * Launch configurations come from `.ivily/launch.json` or `.vscode/launch.json` (JSON with
//!   comments). Starting one requires the `debugging` trust capability and an approval of the
//!   exact (substituted) configuration on first use, like tasks.
//! * Adapters run with piped stdio inside a Job Object; messages use the same Content-Length
//!   framing as LSP.

use crate::core::process::ProcessJob;
use crate::error::{AppError, AppResult};
use crate::lsp::framing;
use crate::tasks::jsonc;
use crate::workspace::paths::NormalizedPath;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub id: String,
    pub name: String,
    /// Debug `type` values served by this adapter.
    pub types: Vec<String>,
    pub program: String,
    pub args: Vec<String>,
    /// `detected` or `user`.
    pub source: &'static str,
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::core::process::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Is `module` importable by this Python (isolated from the current directory)?
fn python_has(python: &Path, module: &str, cwd: &Path) -> bool {
    let mut cmd = Command::new(python);
    cmd.args(["-P", "-c", &format!("import {module}")])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    let Ok(mut child) = cmd.spawn() else { return false };
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return s.success(),
            Ok(None) if start.elapsed() < std::time::Duration::from_secs(5) => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                return false;
            }
        }
    }
}

/// Adapters found on this machine. `neutral_dir` is used as working directory for probes.
pub fn detect(neutral_dir: &Path) -> Vec<Adapter> {
    let mut out = Vec::new();
    let which = |n: &str| crate::toolchains::which(n).filter(|p| !crate::toolchains::is_store_alias(p));
    if let Some(py) = which("python").or_else(|| which("py")) {
        if python_has(&py, "debugpy", neutral_dir) {
            out.push(Adapter {
                id: "debugpy".into(),
                name: "Python (debugpy)".into(),
                types: vec!["python".into(), "debugpy".into()],
                program: py.display().to_string(),
                args: vec!["-P".into(), "-m".into(), "debugpy.adapter".into()],
                source: "detected",
            });
        }
    }
    for exe in ["lldb-dap", "lldb-vscode"] {
        if let Some(p) = which(exe) {
            out.push(Adapter {
                id: "lldb-dap".into(),
                name: "LLDB (lldb-dap)".into(),
                types: vec!["lldb".into(), "lldb-dap".into()],
                program: p.display().to_string(),
                args: vec![],
                source: "detected",
            });
            break;
        }
    }
    if let Some(p) = which("netcoredbg") {
        out.push(Adapter {
            id: "netcoredbg".into(),
            name: ".NET (netcoredbg)".into(),
            types: vec!["coreclr".into(), "netcoredbg".into()],
            program: p.display().to_string(),
            args: vec!["--interpreter=vscode".into()],
            source: "detected",
        });
    }
    out
}

/// User adapters from `debug.adapters` entries `type|C:\path\adapter.exe|args` (absolute paths
/// to existing files only).
pub fn user_adapters(entries: &[String]) -> Vec<Adapter> {
    entries
        .iter()
        .filter_map(|e| {
            let mut parts = e.splitn(3, '|');
            let ty = parts.next()?.trim();
            let path = PathBuf::from(parts.next()?.trim());
            let args = parts.next().unwrap_or("").split_whitespace().map(String::from).collect();
            let ok_type = !ty.is_empty()
                && ty.len() <= 40
                && ty.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
            (ok_type && path.is_absolute() && path.is_file()).then(|| Adapter {
                id: format!("user-{ty}"),
                name: format!("{ty} (user)"),
                types: vec![ty.to_string()],
                program: path.display().to_string(),
                args,
                source: "user",
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub id: String,
    pub name: String,
    pub root: usize,
    pub file: &'static str,
    #[serde(rename = "type")]
    pub ty: String,
    pub request: String,
    /// The configuration as written (variables not yet substituted).
    pub raw: Value,
}

/// Launch configurations of the workspace folders.
pub fn discover(roots: &[NormalizedPath]) -> (Vec<LaunchConfig>, Vec<String>) {
    let mut out = Vec::new();
    let mut issues = Vec::new();
    for (root, r) in roots.iter().enumerate() {
        for file in [".ivily/launch.json", ".vscode/launch.json"] {
            let p = r.path.join(file);
            let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
            if !meta.is_file() || meta.len() > 1024 * 1024 {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            match jsonc::parse(&text) {
                Ok(v) => {
                    for c in v.get("configurations").and_then(Value::as_array).into_iter().flatten().take(200) {
                        let name = c.get("name").and_then(Value::as_str).unwrap_or("").trim();
                        let ty = c.get("type").and_then(Value::as_str).unwrap_or("");
                        let request = c.get("request").and_then(Value::as_str).unwrap_or("launch");
                        if name.is_empty()
                            || name.len() > 120
                            || ty.is_empty()
                            || !matches!(request, "launch" | "attach")
                        {
                            issues.push(format!("{file}: a configuration without name/type/request was ignored"));
                            continue;
                        }
                        out.push(LaunchConfig {
                            id: format!("{root}:{file}:{name}"),
                            name: name.into(),
                            root,
                            file,
                            ty: ty.into(),
                            request: request.into(),
                            raw: c.clone(),
                        });
                    }
                }
                Err(e) => issues.push(format!("{file}: {e}")),
            }
        }
    }
    (out, issues)
}

/// Values for `${file}`-style variables (from the active editor, resolved by the backend).
#[derive(Debug, Default, Clone)]
pub struct FileVars {
    pub file: Option<PathBuf>,
    pub relative: Option<String>,
}

fn substitute_str(s: &str, folder: &Path, f: &FileVars) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let end = after.find('}').ok_or("unterminated ${")?;
        let name = &after[..end];
        let need_file = || f.file.clone().ok_or_else(|| format!("${{{name}}} needs an open file"));
        match name {
            "workspaceFolder" | "workspaceRoot" => out.push_str(&folder.to_string_lossy()),
            "workspaceFolderBasename" => {
                out.push_str(&folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            }
            "pathSeparator" | "/" => out.push('\\'),
            "file" => out.push_str(&need_file()?.to_string_lossy()),
            "fileBasename" => {
                out.push_str(&need_file()?.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            }
            "fileBasenameNoExtension" => {
                out.push_str(&need_file()?.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            }
            "fileDirname" => {
                out.push_str(&need_file()?.parent().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            }
            "fileExtname" => {
                out.push_str(&need_file()?.extension().map(|n| format!(".{}", n.to_string_lossy())).unwrap_or_default())
            }
            "relativeFile" => out.push_str(
                &f.relative.clone().ok_or_else(|| format!("${{{name}}} needs an open file"))?.replace('/', "\\"),
            ),
            other => return Err(format!("unsupported variable ${{{other}}}")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Substitute variables in every string of a configuration.
pub fn substitute(v: &Value, folder: &Path, f: &FileVars) -> Result<Value, String> {
    Ok(match v {
        Value::String(s) => Value::String(substitute_str(s, folder, f)?),
        Value::Array(a) => Value::Array(a.iter().map(|x| substitute(x, folder, f)).collect::<Result<_, _>>()?),
        Value::Object(o) => Value::Object(
            o.iter().map(|(k, x)| Ok((k.clone(), substitute(x, folder, f)?))).collect::<Result<_, String>>()?,
        ),
        other => other.clone(),
    })
}

/// Approval fingerprint of a substituted configuration.
pub fn fingerprint(workspace_id: &str, config_id: &str, resolved: &Value) -> String {
    let mut h = Sha256::new();
    h.update(workspace_id.as_bytes());
    h.update([0]);
    h.update(config_id.as_bytes());
    h.update([0]);
    h.update(serde_json::to_vec(resolved).unwrap_or_default());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A running adapter.
pub struct DapProcess {
    pub window: String,
    pub adapter: String,
    stdin: ChildStdin,
    pub child: std::process::Child,
    _job: ProcessJob,
}

impl DapProcess {
    pub fn send(&mut self, body: &str) -> AppResult<()> {
        framing::write_message(&mut self.stdin, body.as_bytes())?;
        self.stdin.flush()?;
        Ok(())
    }
}

/// Spawn an adapter with piped stdio.
pub fn spawn(
    adapter: &Adapter,
    cwd: &Path,
    window: &str,
) -> AppResult<(DapProcess, std::process::ChildStdout, std::process::ChildStderr)> {
    let job = ProcessJob::new()?;
    let mut cmd = Command::new(&adapter.program);
    cmd.args(&adapter.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| AppError::Io(format!("could not start {}: {e}", adapter.name)))?;
    if let Err(e) = job.assign(&child) {
        let _ = child.kill();
        return Err(e);
    }
    let stdin = child.stdin.take().ok_or_else(|| AppError::Internal("no stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::Internal("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::Internal("no stderr".into()))?;
    Ok((DapProcess { window: window.into(), adapter: adapter.id.clone(), stdin, child, _job: job }, stdout, stderr))
}

#[cfg(test)]
mod tests;
