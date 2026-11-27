//! Ivily Center backend.
//!
//! See `docs/ARCHITECTURE.md` for the module layout. `commands` is the only IPC surface;
//! subsystem modules do not depend on Tauri where avoidable.

pub mod commands;
pub mod error;

pub const APP_NAME: &str = "Ivily Center";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::app::app_info])
        .run(tauri::generate_context!())
        .expect("error while running Ivily Center");
}
