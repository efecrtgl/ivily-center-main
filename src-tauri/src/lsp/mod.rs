//! Language server process management.
//!
//! * A fixed registry of known servers (executable names and arguments are never taken from the
//!   UI or the workspace). Users may point a server at a specific executable in **user** settings
//!   (`lsp.serverPaths`, `id=C:\path\to\server.exe`).
//! * Starting any server requires the window's workspace to grant the `languageServers` trust
//!   capability: servers execute workspace code (build scripts, `node_modules`, macros).
//! * Each server runs in its own Job Object (tree-kill on stop/exit), with the first workspace
//!   folder as working directory. LSP base-protocol framing (`Content-Length`) is handled here;
//!   message bodies are forwarded to and from the editor's LSP client unchanged.

pub mod framing;

use crate::core::process::ProcessJob;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSpec {
    pub id: &'static str,
    pub name: &'static str,
    /// LSP language ids served.
    pub languages: &'static [&'static str],
    #[serde(skip)]
    pub exes: &'static [&'static str],
    #[serde(skip)]
    pub args: &'static [&'static str],
    pub homepage: &'static str,
    /// How to install (shown to the user; never executed automatically).
    pub install: &'static str,
}

const fn s(
    id: &'static str,
    name: &'static str,
    languages: &'static [&'static str],
    exes: &'static [&'static str],
    args: &'static [&'static str],
    homepage: &'static str,
    install: &'static str,
) -> ServerSpec {
    ServerSpec { id, name, languages, exes, args, homepage, install }
}

pub const SERVERS: &[ServerSpec] = &[
    s(
        "rust-analyzer",
        "rust-analyzer",
        &["rust"],
        &["rust-analyzer"],
        &[],
        "https://rust-analyzer.github.io/",
        "rustup component add rust-analyzer",
    ),
    s(
        "typescript-language-server",
        "TypeScript Language Server",
        &["javascript", "javascriptreact", "typescript", "typescriptreact"],
        &["typescript-language-server"],
        &["--stdio"],
        "https://github.com/typescript-language-server/typescript-language-server",
        "npm install -g typescript-language-server typescript",
    ),
    s(
        "pyright",
        "Pyright",
        &["python"],
        &["pyright-langserver", "basedpyright-langserver"],
        &["--stdio"],
        "https://github.com/microsoft/pyright",
        "npm install -g pyright   (or: pip install pyright)",
    ),
    s(
        "pylsp",
        "Python LSP Server",
        &["python"],
        &["pylsp"],
        &[],
        "https://github.com/python-lsp/python-lsp-server",
        "pip install python-lsp-server",
    ),
    s("gopls", "gopls", &["go"], &["gopls"], &[], "https://go.dev/gopls", "go install golang.org/x/tools/gopls@latest"),
    s(
        "clangd",
        "clangd",
        &["c", "cpp"],
        &["clangd"],
        &[],
        "https://clangd.llvm.org/installation",
        "winget install LLVM.LLVM",
    ),
    s(
        "vscode-html",
        "HTML Language Server",
        &["html"],
        &["vscode-html-language-server"],
        &["--stdio"],
        "https://github.com/hrsh7th/vscode-langservers-extracted",
        "npm install -g vscode-langservers-extracted",
    ),
    s(
        "vscode-css",
        "CSS Language Server",
        &["css", "scss", "less"],
        &["vscode-css-language-server"],
        &["--stdio"],
        "https://github.com/hrsh7th/vscode-langservers-extracted",
        "npm install -g vscode-langservers-extracted",
    ),
    s(
        "vscode-json",
        "JSON Language Server",
        &["json", "jsonc"],
        &["vscode-json-language-server"],
        &["--stdio"],
        "https://github.com/hrsh7th/vscode-langservers-extracted",
        "npm install -g vscode-langservers-extracted",
    ),
    s(
        "yaml-language-server",
        "YAML Language Server",
        &["yaml"],
        &["yaml-language-server"],
        &["--stdio"],
        "https://github.com/redhat-developer/yaml-language-server",
        "npm install -g yaml-language-server",
    ),
    s(
        "bash-language-server",
        "Bash Language Server",
        &["shellscript"],
        &["bash-language-server"],
        &["start"],
        "https://github.com/bash-lsp/bash-language-server",
        "npm install -g bash-language-server",
    ),
    s(
        "lua-language-server",
        "Lua Language Server",
        &["lua"],
        &["lua-language-server"],
        &[],
        "https://luals.github.io/",
        "winget install LuaLS.lua-language-server",
    ),
    s(
        "zls",
        "Zig Language Server",
        &["zig"],
        &["zls"],
        &[],
        "https://github.com/zigtools/zls",
        "winget install zigtools.zls",
    ),
    s(
        "taplo",
        "Taplo (TOML)",
        &["toml"],
        &["taplo"],
        &["lsp", "stdio"],
        "https://taplo.tamasfe.dev/",
        "cargo install taplo-cli --features lsp",
    ),
    s(
        "marksman",
        "Marksman (Markdown)",
        &["markdown"],
        &["marksman"],
        &["server"],
        "https://github.com/artempyanykh/marksman",
        "winget install Artempyanykh.Marksman",
    ),
    s(
        "csharp-ls",
        "csharp-ls",
        &["csharp"],
        &["csharp-ls"],
        &[],
        "https://github.com/razzmatazz/csharp-language-server",
        "dotnet tool install --global csharp-ls",
    ),
    s(
        "intelephense",
        "Intelephense (PHP)",
        &["php"],
        &["intelephense"],
        &["--stdio"],
        "https://intelephense.com/",
        "npm install -g intelephense",
    ),
    s(
        "solargraph",
        "Solargraph (Ruby)",
        &["ruby"],
        &["solargraph"],
        &["stdio"],
        "https://solargraph.org/",
        "gem install solargraph",
    ),
    s(
        "dockerfile-language-server",
        "Dockerfile Language Server",
        &["dockerfile"],
        &["docker-langserver"],
        &["--stdio"],
        "https://github.com/rcjsuen/dockerfile-language-server-nodejs",
        "npm install -g dockerfile-language-server-nodejs",
    ),
    s(
        "terraform-ls",
        "Terraform Language Server",
        &["terraform"],
        &["terraform-ls"],
        &["serve"],
        "https://github.com/hashicorp/terraform-ls",
        "winget install Hashicorp.TerraformLanguageServer",
    ),
    s(
        "kotlin-language-server",
        "Kotlin Language Server",
        &["kotlin"],
        &["kotlin-language-server"],
        &[],
        "https://github.com/fwcd/kotlin-language-server",
        "Download a release from GitHub and set lsp.serverPaths",
    ),
    s(
        "svelte-language-server",
        "Svelte Language Server",
        &["svelte"],
        &["svelteserver"],
        &["--stdio"],
        "https://github.com/sveltejs/language-tools",
        "npm install -g svelte-language-server",
    ),
    s(
        "vue-language-server",
        "Vue Language Server",
        &["vue"],
        &["vue-language-server"],
        &["--stdio"],
        "https://github.com/vuejs/language-tools",
        "npm install -g @vue/language-server",
    ),
];

pub fn spec(id: &str) -> Option<&'static ServerSpec> {
    SERVERS.iter().find(|s| s.id == id)
}

/// Executable for a server: a user override (`id=path`) or the first exe found on PATH.
pub fn resolve_exe(spec: &ServerSpec, overrides: &[String]) -> Option<PathBuf> {
    for o in overrides {
        if let Some((id, path)) = o.split_once('=') {
            if id.trim() == spec.id {
                let p = PathBuf::from(path.trim().trim_matches('"'));
                return (p.is_absolute() && p.is_file()).then_some(p);
            }
        }
    }
    spec.exes.iter().find_map(|e| crate::toolchains::which(e)).filter(|p| !crate::toolchains::is_store_alias(p))
}

/// A running server.
pub struct ServerProcess {
    pub server: &'static str,
    pub window: String,
    pub stdin: ChildStdin,
    pub child: std::process::Child,
    _job: ProcessJob,
}

impl ServerProcess {
    pub fn send(&mut self, body: &str) -> AppResult<()> {
        framing::write_message(&mut self.stdin, body.as_bytes())?;
        self.stdin.flush()?;
        Ok(())
    }
}

/// Spawn a server (stdio). Returns the process plus its stdout and stderr for reader threads.
pub fn spawn(
    spec: &'static ServerSpec,
    exe: &std::path::Path,
    cwd: &std::path::Path,
    window: &str,
) -> AppResult<(ServerProcess, std::process::ChildStdout, std::process::ChildStderr)> {
    let job = ProcessJob::new()?;
    let mut cmd = Command::new(exe);
    cmd.args(spec.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::core::process::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| AppError::Io(format!("could not start {}: {e}", spec.name)))?;
    if let Err(e) = job.assign(&child) {
        let _ = child.kill();
        return Err(e);
    }
    let stdin = child.stdin.take().ok_or_else(|| AppError::Internal("no stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::Internal("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::Internal("no stderr".into()))?;
    Ok((ServerProcess { server: spec.id, window: window.to_string(), stdin, child, _job: job }, stdout, stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_consistent() {
        let mut ids = std::collections::HashSet::new();
        for s in SERVERS {
            assert!(ids.insert(s.id), "duplicate {}", s.id);
            assert!(!s.exes.is_empty());
            assert!(s.homepage.starts_with("https://"));
        }
    }

    #[test]
    fn overrides_must_be_absolute_existing_files() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("ra.exe");
        std::fs::write(&exe, "x").unwrap();
        let ra = spec("rust-analyzer").unwrap();
        assert_eq!(resolve_exe(ra, &[format!("rust-analyzer={}", exe.display())]), Some(exe.clone()));
        assert_eq!(resolve_exe(ra, &["rust-analyzer=relative\\ra.exe".into()]), None);
        assert_eq!(resolve_exe(ra, &[format!("rust-analyzer={}", d.path().join("missing.exe").display())]), None);
    }
}

#[cfg(test)]
mod process_tests {
    use super::*;

    /// A tiny LSP server in JavaScript: answers `initialize` and echoes `shutdown`.
    const FAKE_SERVER: &str = r#"
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
    buf = buf.slice(sep + 4 + len);
    const reply = (result) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    if (msg.method === 'initialize') reply({ capabilities: { hoverProvider: true }, serverInfo: { name: 'fake-ü' } });
    if (msg.method === 'shutdown') reply(null);
    if (msg.method === 'exit') process.exit(0);
  }
});
"#;

    #[test]
    fn spawns_frames_and_answers_initialize() {
        let Some(node) = crate::toolchains::which("node") else { return };
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-lsp.js");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        let args: &'static [&'static str] =
            Box::leak(vec![&*Box::leak(script.display().to_string().into_boxed_str())].into_boxed_slice());
        let spec: &'static ServerSpec = Box::leak(Box::new(ServerSpec { args, ..*spec("rust-analyzer").unwrap() }));
        let (mut proc, stdout, _stderr) = spawn(spec, &node, dir.path(), "main").unwrap();
        proc.send(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#).unwrap();
        let mut reader = std::io::BufReader::new(stdout);
        let body = framing::read_message(&mut reader).unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["serverInfo"]["name"], "fake-ü");
        proc.send(r#"{"jsonrpc":"2.0","id":2,"method":"shutdown"}"#).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&framing::read_message(&mut reader).unwrap().unwrap()).unwrap()
                ["id"],
            2
        );
        drop(proc); // job closed → process killed
    }
}
