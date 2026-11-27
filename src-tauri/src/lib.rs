//! Ivily Center backend.
//!
//! See `docs/ARCHITECTURE.md` for the module layout. `commands` is the only IPC surface;
//! subsystem modules (`db`, `settings`, `output`, ...) do not depend on Tauri.

pub mod app_state;
pub mod commands;
pub mod core;
pub mod db;
pub mod error;
pub mod output;
pub mod settings;
pub mod state;

use tauri::{Emitter, Manager};

pub const APP_NAME: &str = "Ivily Center";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let st = app.state::<state::AppState>();
            st.output.set_sink(Box::new(move |entry| {
                let _ = handle.emit(commands::events::OUTPUT_ENTRY, entry);
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::settings::settings_schema,
            commands::settings::settings_values,
            commands::settings::settings_set,
            commands::settings::settings_reset,
            commands::output::output_channels,
            commands::output::output_read,
            commands::output::output_clear,
            commands::output::output_append,
            commands::ui_state::ui_state_get,
            commands::ui_state::ui_state_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ivily Center");
}
