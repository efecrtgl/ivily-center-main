//! Ivily Ecosystem Protocol (IEP) client.
//!
//! Center talks to the other Ivily apps ("modules") through their command-line IEP transport:
//! a short-lived process, one request, one JSON response, read-only methods only. Two dialects
//! exist (see docs/IEP.md): IEP 0.1 (Optimizer, Portly, Structura) and Envora's legacy `iep: 1`
//! envelope, handled by a small adapter.
//!
//! Safety:
//! * Modules are found at their per-user install location or at a path the user configured
//!   (`ecosystem.modulePaths`); nothing from a workspace is used.
//! * Before a module is started, its version resource must name the expected product with a
//!   version that supports IEP — an older build would open its window instead of answering.
//! * Calls run without a window, inside a Job Object, with a timeout and an output limit; only
//!   methods on a per-module allowlist can be requested.

pub mod server;
pub mod version;

use crate::core::process::ProcessJob;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub const CLIENT_VERSION: &str = "0.1.0";
const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Dialect {
    /// `exe --iep describe` / `exe --iep request` with the IEP 0.1 envelope.
    Iep01,
    /// `exe --iep` with `{ iep: 1, id, method }` (Envora).
    EnvoraV1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub product: &'static str,
    pub name: &'static str,
    pub exe: &'static str,
    pub description: &'static str,
    /// Folder under `%LOCALAPPDATA%` used by the per-user installer.
    #[serde(skip)]
    pub install_dir: &'static str,
    /// First version with the IEP command-line transport.
    #[serde(skip)]
    pub min_version: (u32, u32, u32),
    pub dialect: Dialect,
    /// Read-only methods Center may call.
    pub methods: &'static [&'static str],
    pub repository: &'static str,
}

pub static PROVIDERS: &[Provider] = &[
    Provider {
        product: "ivily-optimizer",
        name: "Ivily Optimizer",
        exe: "ivily-optimizer.exe",
        description: "System cleanup and optimization with snapshots and quarantine.",
        install_dir: "Ivily Optimizer",
        min_version: (0, 3, 0),
        dialect: Dialect::Iep01,
        methods: &["describe", "health", "capabilities"],
        repository: "https://github.com/efecrtgl/ivily-optimizer",
    },
    Provider {
        product: "ivily-envora",
        name: "Ivily Envora",
        exe: "ivily-envora.exe",
        description: "Environment variables, PATH and profiles.",
        install_dir: "Ivily Envora",
        min_version: (0, 1, 0),
        dialect: Dialect::EnvoraV1,
        methods: &[
            "iep.hello",
            "envora.health",
            "envora.profiles.summary",
            "envora.path.summary",
            "envora.analysis.summary",
            "envora.activity.summary",
            "envora.workspace.projects",
            "envora.update.metadata",
        ],
        repository: "https://github.com/efecrtgl/ivily-envora",
    },
    Provider {
        product: "ivily-portly",
        name: "Ivily Portly",
        exe: "ivily-portly.exe",
        description: "Ports, listening processes and local services.",
        install_dir: "Ivily Portly",
        min_version: (0, 1, 0),
        dialect: Dialect::Iep01,
        methods: &["describe", "health", "capabilities", "ports.summary", "projects.summary"],
        repository: "https://github.com/efecrtgl/ivily-portly",
    },
    Provider {
        product: "ivily-structura",
        name: "Ivily Structura",
        exe: "ivily-structura.exe",
        description: "Project structure analysis.",
        install_dir: "Ivily Structura",
        min_version: (0, 1, 0),
        dialect: Dialect::Iep01,
        methods: &["describe", "health", "capabilities", "projects.list", "analysis.summary"],
        repository: "https://github.com/efecrtgl/ivily-structura",
    },
];

pub fn provider(product: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.product == product)
}

/// Where a module is: a user override (`product|C:\path\to.exe`) or the per-user install folder.
pub fn locate(p: &Provider, overrides: &[String]) -> Option<PathBuf> {
    for o in overrides {
        if let Some((prod, path)) = o.split_once('|') {
            if prod.trim() == p.product {
                let path = PathBuf::from(path.trim());
                return (path.is_absolute() && path.is_file()).then_some(path);
            }
        }
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let path = base.join(p.install_dir).join(p.exe);
    path.is_file().then_some(path)
}

/// Check that `path` is the expected product in a version that speaks IEP.
pub fn check_binary(p: &Provider, path: &Path) -> Result<String, String> {
    let info = version::read(path).ok_or_else(|| "the file has no version information".to_string())?;
    if !info.product_name.eq_ignore_ascii_case(p.name) {
        return Err(format!("the file is '{}', not {}", info.product_name, p.name));
    }
    if info.version < p.min_version {
        let (a, b, c) = p.min_version;
        return Err(format!(
            "version {} does not support the Ivily Ecosystem Protocol (needs {a}.{b}.{c} or newer)",
            info.version_string()
        ));
    }
    Ok(info.version_string())
}

/// Run a module once: arguments, optional stdin, no window, Job Object, timeout, output limit.
pub fn run(path: &Path, args: &[&str], input: Option<&[u8]>) -> AppResult<Vec<u8>> {
    let job = ProcessJob::new()?;
    let mut cmd = Command::new(path);
    cmd.args(args)
        .current_dir(path.parent().unwrap_or(Path::new(".")))
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::core::process::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| AppError::Io(format!("could not start {}: {e}", path.display())))?;
    if let Err(e) = job.assign(&child) {
        let _ = child.kill();
        return Err(e);
    }
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(data)?;
    }
    let mut stdout = child.stdout.take().ok_or_else(|| AppError::Internal("no stdout".into()))?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(MAX_OUTPUT as u64 + 1).read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if start.elapsed() > TIMEOUT {
            let _ = child.kill();
            drop(job);
            return Err(AppError::Io("the module did not answer in time".into()));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = reader.join().map_err(|_| AppError::Internal("reader failed".into()))?;
    if out.len() > MAX_OUTPUT {
        return Err(AppError::Io("the module answer is too large".into()));
    }
    Ok(out)
}

fn parse_json(out: &[u8]) -> AppResult<Value> {
    let text = String::from_utf8_lossy(out);
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| AppError::Io("the module did not return JSON".into()))?;
    serde_json::from_str(line).map_err(|e| AppError::Io(format!("invalid answer from the module: {e}")))
}

/// IEP 0.x compatibility: same major and, while major is 0, same minor.
pub fn compatible(server_version: &str) -> bool {
    let parse = |s: &str| -> Option<(u64, u64)> {
        let mut it = s.split('.');
        Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
    };
    match (parse(server_version), parse(CLIENT_VERSION)) {
        (Some((a, b)), Some((c, d))) => a == c && (a != 0 || b == d),
        _ => false,
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn next_id() -> String {
    format!("center-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

/// Build the request bytes for a method in the provider's dialect.
pub fn encode_request(p: &Provider, method: &str, params: &Value) -> AppResult<(Vec<&'static str>, Vec<u8>)> {
    if !p.methods.contains(&method) {
        return Err(AppError::validation(
            "iep_method",
            format!("{} does not offer '{method}' to Ivily Center", p.name),
        ));
    }
    let params =
        if params.is_null() || params.as_object().is_some_and(|o| o.is_empty()) { None } else { Some(params.clone()) };
    Ok(match p.dialect {
        Dialect::Iep01 => {
            let mut req = json!({ "protocol": "iep", "version": CLIENT_VERSION, "id": next_id(), "method": method });
            if let Some(pr) = params {
                req["params"] = pr;
            }
            (vec!["--iep", "request"], serde_json::to_vec(&req).unwrap_or_default())
        }
        Dialect::EnvoraV1 => {
            let mut req = json!({ "iep": 1, "id": next_id(), "method": method });
            if let Some(pr) = params {
                req["params"] = pr;
            }
            (vec!["--iep"], serde_json::to_vec(&req).unwrap_or_default())
        }
    })
}

/// Turn a response of either dialect into `Ok(result)` or an error.
pub fn decode_response(p: &Provider, v: &Value) -> AppResult<Value> {
    let error = |code: &str, msg: &str| AppError::Io(format!("{} answered with {code}: {msg}", p.name));
    match p.dialect {
        Dialect::Iep01 => {
            if v.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            } else {
                let e = v.get("error").cloned().unwrap_or_default();
                Err(error(
                    e.get("code").and_then(Value::as_str).unwrap_or("error"),
                    e.get("message").and_then(Value::as_str).unwrap_or(""),
                ))
            }
        }
        Dialect::EnvoraV1 => match (v.get("result"), v.get("error")) {
            (Some(r), None) => Ok(r.clone()),
            (_, Some(e)) => Err(error(
                e.get("code").and_then(Value::as_str).unwrap_or("error"),
                e.get("message").and_then(Value::as_str).unwrap_or(""),
            )),
            _ => Err(error("invalid_response", "missing result")),
        },
    }
}

/// Call one allowlisted method.
pub fn request(p: &Provider, path: &Path, method: &str, params: &Value) -> AppResult<Value> {
    let (args, body) = encode_request(p, method, params)?;
    let out = run(path, &args, Some(&body))?;
    decode_response(p, &parse_json(&out)?)
}

/// Module status for the dashboard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleStatus {
    pub product: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub repository: &'static str,
    pub path: Option<String>,
    pub version: Option<String>,
    /// `notInstalled`, `incompatible`, `disabled`, `ok`, `degraded`, `error`.
    pub status: &'static str,
    pub message: Option<String>,
    /// Normalized descriptor: `{ protocol, capabilities: [{ id, status, access }], health, update, activity, granted }`.
    pub info: Option<Value>,
    pub checked_at: i64,
}

impl ModuleStatus {
    /// A module the user disabled: not located, not started.
    pub fn off(p: &'static Provider) -> Self {
        ModuleStatus {
            product: p.product,
            name: p.name,
            description: p.description,
            repository: p.repository,
            path: None,
            version: None,
            status: "off",
            message: Some("Disabled in Ivily Center.".into()),
            info: None,
            checked_at: crate::core::now_ms(),
        }
    }
}

/// Describe a module (no side effects in the module: describe is read-only by contract).
pub fn status(p: &'static Provider, overrides: &[String]) -> ModuleStatus {
    let mut s = ModuleStatus {
        product: p.product,
        name: p.name,
        description: p.description,
        repository: p.repository,
        path: None,
        version: None,
        status: "notInstalled",
        message: None,
        info: None,
        checked_at: crate::core::now_ms(),
    };
    let Some(path) = locate(p, overrides) else { return s };
    s.path = Some(path.display().to_string());
    match check_binary(p, &path) {
        Ok(v) => s.version = Some(v),
        Err(e) => {
            s.status = "incompatible";
            s.message = Some(e);
            return s;
        }
    }
    let described = match p.dialect {
        Dialect::Iep01 => run(&path, &["--iep", "describe"], None).and_then(|o| parse_json(&o)).map(|d| {
            let proto = d.pointer("/protocol/version").and_then(Value::as_str).unwrap_or("").to_string();
            let health = d.get("health").cloned().unwrap_or(Value::Null);
            let info = json!({
                "protocol": proto,
                "capabilities": d.get("capabilities").cloned().unwrap_or(json!([])),
                "health": health,
                "update": d.get("update").cloned().unwrap_or(Value::Null),
                "activity": d.get("activity").cloned().unwrap_or(Value::Null),
            });
            let state = if !compatible(&proto) {
                ("incompatible", Some(format!("speaks IEP {proto}; Ivily Center speaks {CLIENT_VERSION}")))
            } else if health.get("status").and_then(Value::as_str) == Some("degraded") {
                ("degraded", Some("the module reports a degraded state".into()))
            } else {
                ("ok", None)
            };
            (state, info)
        }),
        Dialect::EnvoraV1 => request(p, &path, "iep.hello", &Value::Null).map(|r| {
            let enabled = r.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            let granted: Vec<String> = r.get("granted").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
            let caps: Vec<Value> = r
                .get("capabilities")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|c| json!({ "id": c, "access": "read", "status": if granted.iter().any(|g| g == c) { "available" } else { "notGranted" } }))
                .collect();
            let info = json!({ "protocol": "envora-1", "capabilities": caps, "granted": granted, "health": Value::Null });
            let state = if enabled {
                ("ok", None)
            } else {
                ("disabled", Some("Ecosystem access is turned off in Ivily Envora (Settings → Ecosystem).".to_string()))
            };
            (state, info)
        }),
    };
    match described {
        Ok(((st, msg), info)) => {
            s.status = st;
            s.message = msg;
            s.info = Some(info);
        }
        Err(e) => {
            s.status = "error";
            s.message = Some(e.to_string());
        }
    }
    s
}

#[cfg(test)]
mod tests;
