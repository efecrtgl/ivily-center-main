//! Small shared primitives: time, application paths and startup issues.

pub mod process;

use serde::Serialize;
use std::path::PathBuf;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `%LOCALAPPDATA%\IvilyCenter` (falls back to the temp dir if Windows reports no local data dir).
pub fn data_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("IvilyCenter")
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

/// A problem detected during startup that the UI should surface (e.g. database recovered).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupIssue {
    pub severity: Severity,
    /// Stable identifier, e.g. `db_newer_schema`.
    pub code: &'static str,
    pub message: String,
}

impl StartupIssue {
    pub fn new(severity: Severity, code: &'static str, message: impl Into<String>) -> Self {
        Self { severity, code, message: message.into() }
    }
}

/// Open an `https://` URL in the default browser. Only fixed, well-formed URLs from built-in tables
/// are passed here; anything else is refused. No shell is involved.
pub fn open_url(url: &str) -> crate::error::AppResult<()> {
    let ok = url.starts_with("https://")
        && url.len() < 2048
        && !url.chars().any(|c| {
            c.is_whitespace() || c.is_control() || c == '"' || c == '^' || c == '&' || c == '|' || c == '<' || c == '>'
        });
    if !ok {
        return Err(crate::error::AppError::validation("invalid_url", "refusing to open this URL"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).spawn()?;
    }
    Ok(())
}

#[cfg(test)]
mod url_tests {
    #[test]
    fn refuses_non_https_and_injection() {
        for bad in ["http://x", "file:///c:/windows", "https://x\" & calc", "https://a b", "javascript:alert(1)"] {
            assert!(super::open_url(bad).is_err(), "{bad}");
        }
    }
}
