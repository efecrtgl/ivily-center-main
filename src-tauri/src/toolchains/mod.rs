//! Development tool discovery.
//!
//! Tools are located by searching `PATH` (with `PATHEXT`) and a few well-known install folders
//! ourselves, then probed with a version flag by **absolute path** from a neutral working directory
//! (the app data folder), with a timeout and bounded output. This matters on Windows:
//! * `CreateProcess` searches the current directory first for bare names, so a workspace could
//!   otherwise plant `node.exe`; we never run bare names and never use the workspace as cwd.
//! * Some tools read project files from the current directory (`rust-toolchain.toml` makes rustup
//!   download a toolchain); a neutral cwd prevents that.
//! * Windows Store "app execution aliases" (`…\WindowsApps\python.exe`) open the Store when run;
//!   they are reported but never executed.
//!
//! Nothing is installed or modified here; the UI only shows guidance (official download pages and
//! the exact `winget` command), and installation happens only in a visible terminal on request.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct ToolSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    /// Executable base names, tried in order.
    pub exes: &'static [&'static str],
    pub version_args: &'static [&'static str],
    pub homepage: &'static str,
    pub winget: Option<&'static str>,
}

const fn t(
    id: &'static str,
    name: &'static str,
    category: &'static str,
    exes: &'static [&'static str],
    version_args: &'static [&'static str],
    homepage: &'static str,
    winget: Option<&'static str>,
) -> ToolSpec {
    ToolSpec { id, name, category, exes, version_args, homepage, winget }
}

pub const TOOLS: &[ToolSpec] = &[
    t("git", "Git", "Version control", &["git"], &["--version"], "https://git-scm.com/download/win", Some("Git.Git")),
    t("node", "Node.js", "JavaScript", &["node"], &["--version"], "https://nodejs.org/", Some("OpenJS.NodeJS.LTS")),
    t("npm", "npm", "JavaScript", &["npm"], &["--version"], "https://docs.npmjs.com/", None),
    t("pnpm", "pnpm", "JavaScript", &["pnpm"], &["--version"], "https://pnpm.io/installation", Some("pnpm.pnpm")),
    t("yarn", "Yarn", "JavaScript", &["yarn"], &["--version"], "https://yarnpkg.com/getting-started/install", None),
    t("bun", "Bun", "JavaScript", &["bun"], &["--version"], "https://bun.sh/", Some("Oven-sh.Bun")),
    t("deno", "Deno", "JavaScript", &["deno"], &["--version"], "https://deno.com/", Some("DenoLand.Deno")),
    t("rustc", "Rust compiler", "Rust", &["rustc"], &["--version"], "https://rustup.rs/", Some("Rustlang.Rustup")),
    t("cargo", "Cargo", "Rust", &["cargo"], &["--version"], "https://rustup.rs/", Some("Rustlang.Rustup")),
    t("rustup", "rustup", "Rust", &["rustup"], &["--version"], "https://rustup.rs/", Some("Rustlang.Rustup")),
    t(
        "python",
        "Python",
        "Python",
        &["python", "python3", "py"],
        &["--version"],
        "https://www.python.org/downloads/windows/",
        Some("Python.Python.3.13"),
    ),
    t("pip", "pip", "Python", &["pip", "pip3"], &["--version"], "https://pip.pypa.io/", None),
    t("uv", "uv", "Python", &["uv"], &["--version"], "https://docs.astral.sh/uv/", Some("astral-sh.uv")),
    t("java", "Java", "JVM", &["java"], &["-version"], "https://adoptium.net/", Some("EclipseAdoptium.Temurin.21.JDK")),
    t("mvn", "Maven", "JVM", &["mvn"], &["--version"], "https://maven.apache.org/download.cgi", None),
    t("gradle", "Gradle", "JVM", &["gradle"], &["--version"], "https://gradle.org/install/", None),
    t("kotlinc", "Kotlin", "JVM", &["kotlinc"], &["-version"], "https://kotlinlang.org/docs/command-line.html", None),
    t("go", "Go", "Go", &["go"], &["version"], "https://go.dev/dl/", Some("GoLang.Go")),
    t(
        "dotnet",
        ".NET SDK",
        ".NET",
        &["dotnet"],
        &["--version"],
        "https://dotnet.microsoft.com/download",
        Some("Microsoft.DotNet.SDK.9"),
    ),
    t("php", "PHP", "PHP", &["php"], &["--version"], "https://windows.php.net/download/", None),
    t("composer", "Composer", "PHP", &["composer"], &["--version"], "https://getcomposer.org/download/", None),
    t(
        "ruby",
        "Ruby",
        "Ruby",
        &["ruby"],
        &["--version"],
        "https://rubyinstaller.org/",
        Some("RubyInstallerTeam.Ruby.3.3"),
    ),
    t("gem", "RubyGems", "Ruby", &["gem"], &["--version"], "https://rubygems.org/", None),
    t("gcc", "GCC", "C/C++", &["gcc"], &["--version"], "https://www.msys2.org/", None),
    t("clang", "Clang", "C/C++", &["clang"], &["--version"], "https://releases.llvm.org/", Some("LLVM.LLVM")),
    t("cmake", "CMake", "C/C++", &["cmake"], &["--version"], "https://cmake.org/download/", Some("Kitware.CMake")),
    t("make", "Make", "C/C++", &["make", "mingw32-make"], &["--version"], "https://www.gnu.org/software/make/", None),
    t("zig", "Zig", "Zig", &["zig"], &["version"], "https://ziglang.org/download/", Some("zig.zig")),
    t("lua", "Lua", "Lua", &["lua", "lua54"], &["-v"], "https://www.lua.org/download.html", None),
    t(
        "perl",
        "Perl",
        "Perl",
        &["perl"],
        &["--version"],
        "https://strawberryperl.com/",
        Some("StrawberryPerl.StrawberryPerl"),
    ),
    t(
        "docker",
        "Docker",
        "Containers",
        &["docker"],
        &["--version"],
        "https://docs.docker.com/desktop/setup/install/windows-install/",
        Some("Docker.DockerDesktop"),
    ),
    t(
        "pwsh",
        "PowerShell 7",
        "Shells",
        &["pwsh"],
        &["--version"],
        "https://aka.ms/powershell",
        Some("Microsoft.PowerShell"),
    ),
    t(
        "powershell",
        "Windows PowerShell",
        "Shells",
        &["powershell"],
        &["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
        "https://learn.microsoft.com/powershell/",
        None,
    ),
    t(
        "bash",
        "Bash (Git Bash)",
        "Shells",
        &["bash"],
        &["--version"],
        "https://git-scm.com/download/win",
        Some("Git.Git"),
    ),
    t("wsl", "WSL", "Shells", &["wsl"], &[], "https://learn.microsoft.com/windows/wsl/install", None),
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Available,
    NotFound,
    /// A Windows Store app execution alias (not a real installation).
    StoreAlias,
    /// Found, but the version probe failed or timed out.
    Unverified,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub status: Status,
    pub version: Option<String>,
    pub path: Option<String>,
    pub homepage: &'static str,
    pub winget: Option<&'static str>,
}

fn path_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    // Common user-level locations that may not be on PATH yet for an already-running process.
    if let Some(home) = dirs::home_dir() {
        for sub in [".cargo/bin", ".bun/bin", ".deno/bin", "go/bin", "scoop/shims", ".local/bin"] {
            dirs.push(home.join(sub));
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(var).map(PathBuf::from) {
            for sub in [
                "nodejs",
                "Git/cmd",
                "Git/bin",
                "Go/bin",
                "dotnet",
                "CMake/bin",
                "PowerShell/7",
                "Docker/Docker/resources/bin",
            ] {
                dirs.push(pf.join(sub));
            }
        }
    }
    dirs.retain(|d| d.is_absolute());
    dirs
}

fn pathext() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| matches!(e.to_ascii_lowercase().as_str(), ".com" | ".exe" | ".bat" | ".cmd"))
        .map(|e| e.to_ascii_lowercase())
        .collect()
}

/// Locate an executable by name in the given directories (absolute paths only).
pub fn which_in(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let exts = if cfg!(windows) { pathext() } else { vec![String::new()] };
    for d in dirs {
        for e in &exts {
            let p = d.join(format!("{name}{e}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub fn which(name: &str) -> Option<PathBuf> {
    which_in(name, &path_dirs())
}

/// `…\Microsoft\WindowsApps\python.exe` style aliases (0-byte reparse points that open the Store).
pub fn is_store_alias(p: &Path) -> bool {
    let s = p.to_string_lossy().to_lowercase();
    s.contains("\\microsoft\\windowsapps\\") && std::fs::metadata(p).map(|m| m.len() == 0).unwrap_or(true)
}

/// Run `exe args…` with a neutral cwd, no stdin, a timeout and at most 64 KB of output.
pub fn probe(exe: &Path, args: &[&str], cwd: &Path, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&out.stderr).into_owned();
    }
    text.truncate(64 * 1024);
    Some(text)
}

/// First line that looks like a version, trimmed of tool-name noise.
pub fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().map(str::trim).find(|l| l.chars().any(|c| c.is_ascii_digit()))?;
    let re = regex::Regex::new(r"\d+(\.\d+)+([\-+.][0-9A-Za-z.\-]+)?").ok()?;
    re.find(line).map(|m| m.as_str().to_string()).or_else(|| Some(line.chars().take(80).collect()))
}

pub fn detect_one(spec: &ToolSpec, dirs: &[PathBuf], cwd: &Path) -> Tool {
    let mut tool = Tool {
        id: spec.id,
        name: spec.name,
        category: spec.category,
        status: Status::NotFound,
        version: None,
        path: None,
        homepage: spec.homepage,
        winget: spec.winget,
    };
    let mut alias = None;
    for exe in spec.exes {
        let Some(p) = which_in(exe, dirs) else { continue };
        if is_store_alias(&p) {
            alias.get_or_insert(p);
            continue;
        }
        tool.path = Some(p.display().to_string());
        if spec.version_args.is_empty() {
            tool.status = Status::Available;
            return tool;
        }
        match probe(&p, spec.version_args, cwd, Duration::from_secs(5)).and_then(|o| parse_version(&o)) {
            Some(v) => {
                tool.status = Status::Available;
                tool.version = Some(v);
            }
            None => tool.status = Status::Unverified,
        }
        return tool;
    }
    if let Some(a) = alias {
        tool.status = Status::StoreAlias;
        tool.path = Some(a.display().to_string());
    }
    tool
}

/// Detect every known tool (in parallel).
pub fn detect_all(cwd: &Path) -> Vec<Tool> {
    let dirs = path_dirs();
    std::thread::scope(|s| {
        let handles: Vec<_> = TOOLS.iter().map(|spec| s.spawn(|| detect_one(spec, &dirs, cwd))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// Which tools a workspace probably needs, from marker files in its folders (no contents read).
pub fn relevant_tools(roots: &[PathBuf]) -> Vec<&'static str> {
    let mut out = Vec::new();
    let has = |root: &Path, name: &str| root.join(name).exists();
    let has_ext = |root: &Path, ext: &str| {
        std::fs::read_dir(root)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .take(2000)
                    .any(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)))
            })
            .unwrap_or(false)
    };
    for r in roots {
        let mut add = |ids: &[&'static str]| {
            for id in ids {
                if !out.contains(id) {
                    out.push(*id);
                }
            }
        };
        if has(r, ".git") {
            add(&["git"]);
        }
        if has(r, "Cargo.toml") {
            add(&["rustc", "cargo", "rustup"]);
        }
        if has(r, "package.json") {
            add(&["node", "npm"]);
            if has(r, "pnpm-lock.yaml") {
                add(&["pnpm"]);
            }
            if has(r, "yarn.lock") {
                add(&["yarn"]);
            }
            if has(r, "bun.lockb") || has(r, "bun.lock") {
                add(&["bun"]);
            }
        }
        if has(r, "deno.json") || has(r, "deno.jsonc") {
            add(&["deno"]);
        }
        if has(r, "pyproject.toml") || has(r, "requirements.txt") || has(r, "setup.py") {
            add(&["python", "pip"]);
            if has(r, "uv.lock") {
                add(&["uv"]);
            }
        }
        if has(r, "go.mod") {
            add(&["go"]);
        }
        if has(r, "pom.xml") {
            add(&["java", "mvn"]);
        }
        if has(r, "build.gradle") || has(r, "build.gradle.kts") {
            add(&["java", "gradle"]);
        }
        if has_ext(r, "csproj") || has_ext(r, "sln") || has_ext(r, "fsproj") {
            add(&["dotnet"]);
        }
        if has(r, "composer.json") {
            add(&["php", "composer"]);
        }
        if has(r, "Gemfile") {
            add(&["ruby", "gem"]);
        }
        if has(r, "CMakeLists.txt") {
            add(&["cmake"]);
        }
        if has(r, "Makefile") {
            add(&["make"]);
        }
        if has(r, "build.zig") {
            add(&["zig"]);
        }
        if has(r, "Dockerfile") || has(r, "compose.yaml") || has(r, "docker-compose.yml") {
            add(&["docker"]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("v24.15.0\n").as_deref(), Some("24.15.0"));
        assert_eq!(parse_version("rustc 1.100.0 (0ef1bc386 2026-11-09)").as_deref(), Some("1.100.0"));
        assert_eq!(parse_version("git version 2.54.0.windows.1").as_deref(), Some("2.54.0.windows.1"));
        assert_eq!(parse_version("go version go1.23.4 windows/amd64").as_deref(), Some("1.23.4"));
        assert_eq!(parse_version("openjdk version \"21.0.2\" 2024-01-16").as_deref(), Some("21.0.2"));
        assert_eq!(parse_version("no digits here"), None);
    }

    #[test]
    fn which_only_searches_given_absolute_dirs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("mytool.exe"), "x").unwrap();
        assert!(which_in("mytool", &[d.path().to_path_buf()]).is_some());
        assert!(which_in("othertool", &[d.path().to_path_buf()]).is_none());
    }

    #[test]
    fn store_aliases_are_recognized() {
        assert!(is_store_alias(Path::new(r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\python.exe")));
        assert!(!is_store_alias(Path::new(r"C:\Python313\python.exe")));
    }

    #[test]
    fn detects_real_tools_from_a_neutral_cwd() {
        // git is required to build this project, so it must be detected with a version.
        let cwd = tempfile::tempdir().unwrap();
        let git = detect_one(TOOLS.iter().find(|t| t.id == "git").unwrap(), &path_dirs(), cwd.path());
        assert_eq!(git.status, Status::Available, "{git:?}");
        assert!(git.version.is_some());
        let missing = ToolSpec { exes: &["definitely-not-a-real-tool-xyz"], ..TOOLS[0] };
        assert_eq!(detect_one(&missing, &path_dirs(), cwd.path()).status, Status::NotFound);
    }

    #[test]
    fn probe_times_out() {
        let cwd = tempfile::tempdir().unwrap();
        if let Some(ps) = which("powershell") {
            let r = probe(
                &ps,
                &["-NoProfile", "-Command", "Start-Sleep -Seconds 5"],
                cwd.path(),
                Duration::from_millis(400),
            );
            assert!(r.is_none());
        }
    }

    #[test]
    fn workspace_relevance_from_markers() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Cargo.toml"), "").unwrap();
        std::fs::write(d.path().join("package.json"), "{}").unwrap();
        std::fs::write(d.path().join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(d.path().join("App.csproj"), "").unwrap();
        let r = relevant_tools(&[d.path().to_path_buf()]);
        for id in ["cargo", "node", "npm", "pnpm", "dotnet"] {
            assert!(r.contains(&id), "{id} in {r:?}");
        }
        assert!(!r.contains(&"go"));
    }
}
