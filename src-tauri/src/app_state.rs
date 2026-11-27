//! Small key/value store for application state that is not a user setting
//! (window bounds, UI layout sizes, last-opened views).
//!
//! Key namespaces: `window.*` is written by the Rust window manager only; `ui.*` is writable
//! from the webview through [`validate_ui_key`]-checked commands.

use crate::core::now_ms;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

pub const MAX_UI_VALUE_BYTES: usize = 64 * 1024;

pub fn get_raw(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM app_state WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn get<T: DeserializeOwned>(conn: &Connection, key: &str) -> AppResult<Option<T>> {
    // A value that no longer parses (older format) is treated as absent, not as an error.
    Ok(get_raw(conn, key)?.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn set<T: Serialize>(conn: &Connection, key: &str, value: &T) -> AppResult<()> {
    let json = serde_json::to_string(value).map_err(|e| AppError::Internal(e.to_string()))?;
    conn.execute(
        "INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, json, now_ms()],
    )?;
    Ok(())
}

/// UI keys: `ui.` followed by 1–64 of `[a-z0-9._-]` (case-insensitive letters allowed).
pub fn validate_ui_key(key: &str) -> AppResult<()> {
    let rest = key.strip_prefix("ui.").unwrap_or("");
    let ok = (1..=64).contains(&rest.len())
        && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(AppError::validation("invalid_state_key", "UI state keys must look like 'ui.name'"))
    }
}

pub fn validate_ui_value(value: &Value) -> AppResult<()> {
    let size = serde_json::to_string(value).map(|s| s.len()).unwrap_or(usize::MAX);
    if size > MAX_UI_VALUE_BYTES {
        return Err(AppError::validation(
            "state_too_large",
            format!("UI state values are limited to {MAX_UI_VALUE_BYTES} bytes"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrate, MIGRATIONS};
    use serde_json::json;

    #[test]
    fn round_trip_and_key_rules() {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, MIGRATIONS, None).unwrap();
        set(&c, "ui.layout", &json!({ "sidebar": 280 })).unwrap();
        assert_eq!(get::<Value>(&c, "ui.layout").unwrap(), Some(json!({ "sidebar": 280 })));
        assert_eq!(get::<Value>(&c, "ui.none").unwrap(), None);

        assert!(validate_ui_key("ui.layout").is_ok());
        assert!(validate_ui_key("window.main").is_err(), "webview must not write window.* keys");
        assert!(validate_ui_key("ui.").is_err());
        assert!(validate_ui_key("ui.a b").is_err());
        assert!(validate_ui_value(&json!("x".repeat(MAX_UI_VALUE_BYTES + 1))).is_err());
    }
}
