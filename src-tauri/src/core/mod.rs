//! Small shared primitives: time, application paths and startup issues.

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
