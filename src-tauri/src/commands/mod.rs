//! Tauri IPC commands. Each command deserializes and validates its input, then delegates to a
//! subsystem module. No business logic lives here.

pub mod app;
pub mod editor;
pub mod fs;
pub mod lsp;
pub mod output;
pub mod settings;
pub mod terminal;
pub mod toolchains;
pub mod ui_state;
pub mod workspace;

/// Event names emitted to the webview.
pub mod events {
    pub const SETTINGS_CHANGED: &str = "settings://changed";
    pub const OUTPUT_ENTRY: &str = "output://entry";
}
