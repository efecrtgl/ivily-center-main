//! Integrated terminal: shell profiles and ConPTY sessions.
//!
//! * Profiles are detected (PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL
//!   distributions) or defined by the **user** (`terminal.profiles`). Workspaces cannot define
//!   profiles, so opening a folder never decides what program a terminal runs.
//! * A terminal starts only on explicit user action. It runs in a real pseudo console (ConPTY via
//!   `portable-pty`), inside a Job Object: closing the terminal, switching workspace or exiting
//!   Ivily Center terminates the shell and everything started from it.

use crate::core::process::ProcessJob;
use crate::error::{AppError, AppResult};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    /// `detected` or `user`.
    pub source: &'static str,
    pub icon: &'static str,
}

fn system32() -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32")
}

/// Decode `wsl.exe -l -q` output (UTF-16LE on most systems, sometimes UTF-8).
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).take(16).all(|b| *b == 0) {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|l| !l.is_empty() && l.chars().all(|c| c.is_alphanumeric() || "-_. ".contains(c)) && l.len() < 64)
        .collect()
}

fn wsl_distros(wsl: &Path, cwd: &Path) -> Vec<String> {
    let mut cmd = std::process::Command::new(wsl);
    cmd.args(["-l", "-q"]).current_dir(cwd).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::core::process::CREATE_NO_WINDOW);
    }
    cmd.output().map(|o| parse_wsl_list(&o.stdout)).unwrap_or_default()
}

/// Detect shells. `cwd` is a neutral directory for the WSL probe.
pub fn detect_profiles(cwd: &Path) -> Vec<Profile> {
    let mut out = Vec::new();
    let mut push = |id: &str, name: &str, path: PathBuf, args: Vec<String>, icon: &'static str| {
        if path.is_file() && !out.iter().any(|p: &Profile| p.id == id) {
            out.push(Profile {
                id: id.into(),
                name: name.into(),
                path: path.display().to_string(),
                args,
                source: "detected",
                icon,
            });
        }
    };
    if let Some(p) = crate::toolchains::which("pwsh") {
        push("pwsh", "PowerShell 7", p, vec!["-NoLogo".into()], "terminal");
    }
    push(
        "powershell",
        "Windows PowerShell",
        system32().join("WindowsPowerShell").join("v1.0").join("powershell.exe"),
        vec!["-NoLogo".into()],
        "terminal",
    );
    let comspec = std::env::var_os("ComSpec").map(PathBuf::from).unwrap_or_else(|| system32().join("cmd.exe"));
    push("cmd", "Command Prompt", comspec, vec![], "terminal");
    // Git Bash — never System32\bash.exe (that is the WSL launcher).
    let mut git_bash = None;
    for var in ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
            for rel in [r"Git\bin\bash.exe", r"Programs\Git\bin\bash.exe"] {
                let p = base.join(rel);
                if p.is_file() {
                    git_bash.get_or_insert(p);
                }
            }
        }
    }
    if git_bash.is_none() {
        if let Some(git) = crate::toolchains::which("git") {
            // …\Git\cmd\git.exe → …\Git\bin\bash.exe
            if let Some(root) = git.parent().and_then(Path::parent) {
                let p = root.join("bin").join("bash.exe");
                if p.is_file() {
                    git_bash = Some(p);
                }
            }
        }
    }
    if let Some(p) = git_bash {
        push("git-bash", "Git Bash", p, vec!["--login".into(), "-i".into()], "terminal");
    }
    let wsl = system32().join("wsl.exe");
    if wsl.is_file() {
        for d in wsl_distros(&wsl, cwd) {
            let id = format!("wsl-{}", d.to_lowercase().replace(' ', "-"));
            push(&id, &format!("WSL: {d}"), wsl.clone(), vec!["-d".into(), d.clone()], "terminal");
        }
    }
    out
}

/// User profiles from the `terminal.profiles` setting: `Name|C:\path\to\shell.exe|arg1 arg2`.
pub fn user_profiles(entries: &[String]) -> Vec<Profile> {
    entries
        .iter()
        .filter_map(|e| {
            let mut parts = e.splitn(3, '|');
            let name = parts.next()?.trim();
            let path = PathBuf::from(parts.next()?.trim().trim_matches('"'));
            let args = parts.next().map(|a| a.split_whitespace().map(String::from).collect()).unwrap_or_default();
            if name.is_empty() || name.len() > 64 || !path.is_absolute() || !path.is_file() {
                return None;
            }
            Some(Profile {
                id: format!("user-{}", name.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-")),
                name: name.to_string(),
                path: path.display().to_string(),
                args,
                source: "user",
                icon: "terminal",
            })
        })
        .collect()
}

/// A running terminal.
pub struct Session {
    pub window: String,
    pub profile: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _job: ProcessJob,
}

impl Session {
    pub fn write(&mut self, data: &[u8]) -> AppResult<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.master
            .resize(PtySize { rows: rows.clamp(2, 1000), cols: cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Internal(format!("resize failed: {e}")))
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }

    pub fn try_exit_code(&mut self) -> Option<u32> {
        self.child.try_wait().ok().flatten().map(|s| s.exit_code())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Start `profile` in `cwd`. Returns the session and a reader for its output.
pub fn spawn(
    profile: &Profile,
    cwd: &Path,
    cols: u16,
    rows: u16,
    window: &str,
) -> AppResult<(Session, Box<dyn std::io::Read + Send>)> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: rows.clamp(2, 1000), cols: cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| AppError::Internal(format!("could not create a pseudo console: {e}")))?;
    let mut cmd = CommandBuilder::new(&profile.path);
    cmd.args(&profile.args);
    cmd.cwd(cwd);
    cmd.env("TERM_PROGRAM", "ivily-center");
    cmd.env("COLORTERM", "truecolor");
    let job = ProcessJob::new()?;
    let child =
        pair.slave.spawn_command(cmd).map_err(|e| AppError::Io(format!("could not start {}: {e}", profile.name)))?;
    #[cfg(windows)]
    if let Some(h) = child.as_raw_handle() {
        // SAFETY: the handle belongs to the child we just spawned and is valid while `child` lives.
        unsafe { job.assign_raw(h)? };
    }
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| AppError::Internal(e.to_string()))?;
    let writer = pair.master.take_writer().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok((
        Session {
            window: window.to_string(),
            profile: profile.id.clone(),
            master: pair.master,
            writer,
            child,
            _job: job,
        },
        reader,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::time::{Duration, Instant};

    #[test]
    fn parses_wsl_output() {
        let utf16: Vec<u8> = "Ubuntu-22.04\r\nDebian\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&utf16), vec!["Ubuntu-22.04", "Debian"]);
        assert_eq!(parse_wsl_list(b"Ubuntu\n"), vec!["Ubuntu"]);
        assert!(parse_wsl_list(b"Windows Subsystem for Linux has no installed distributions.\n<html>").len() <= 1);
    }

    #[test]
    fn user_profiles_require_absolute_existing_executables() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("nu.exe");
        std::fs::write(&exe, "x").unwrap();
        let p = user_profiles(&[
            format!("Nushell|{}|--login -i", exe.display()),
            "Bad|relative.exe|".into(),
            "|C:\\x.exe|".into(),
        ]);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].args, vec!["--login", "-i"]);
        assert_eq!(p[0].id, "user-nushell");
    }

    #[test]
    fn detects_cmd_and_powershell() {
        let d = tempfile::tempdir().unwrap();
        let p = detect_profiles(d.path());
        assert!(p.iter().any(|x| x.id == "cmd"), "{p:?}");
        assert!(!p.iter().any(|x| x.path.to_lowercase().ends_with(r"system32\bash.exe")));
    }

    #[test]
    fn runs_a_real_shell_in_a_pseudo_console() {
        let d = tempfile::tempdir().unwrap();
        let cmd = detect_profiles(d.path()).into_iter().find(|p| p.id == "cmd").unwrap();
        let (mut session, mut reader) = spawn(&cmd, d.path(), 80, 24, "main").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        // ConPTY asks for the cursor position (DSR, ESC[6n) and waits for the terminal's answer;
        // xterm.js answers in the app, the test plays the terminal here.
        let mut seen = String::new();
        let mut answered = false;
        let mut sent = false;
        let start = Instant::now();
        while !seen.contains("ivily-pty-ok\r\n") && start.elapsed() < Duration::from_secs(10) {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.push_str(&String::from_utf8_lossy(&chunk));
            }
            if !answered && seen.contains("\u{1b}[6n") {
                session.write(b"\x1b[1;1R").unwrap();
                answered = true;
            }
            if !sent && (answered || start.elapsed() > Duration::from_secs(2)) {
                session.write(b"echo ivily-pty-ok\r").unwrap();
                session.resize(100, 30).unwrap();
                sent = true;
            }
        }
        assert!(seen.contains("ivily-pty-ok"), "output: {seen:?}");
        session.write(b"exit\r").unwrap();
        let start = Instant::now();
        while session.try_exit_code().is_none() {
            assert!(start.elapsed() < Duration::from_secs(10), "shell did not exit");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
