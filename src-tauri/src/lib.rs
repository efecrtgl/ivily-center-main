//! Ivily Center backend.
//!
//! See `docs/ARCHITECTURE.md` for the module layout. `commands` is the only IPC surface;
//! subsystem modules (`db`, `settings`, `output`, `workspace`, ...) do not depend on Tauri.

pub mod app_state;
pub mod commands;
pub mod core;
pub mod db;
pub mod error;
pub mod output;
pub mod settings;
pub mod state;
pub mod window;
pub mod workspace;

use tauri::{Emitter, Manager, RunEvent};

pub const APP_NAME: &str = "Ivily Center";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn run() {
    let cli_path = workspace::service::cli_path(std::env::args());
    let app = tauri::Builder::default()
        // Dialogs are opened from Rust only; the webview has no dialog permission.
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::init(cli_path))
        .setup(|app| {
            let handle = app.handle().clone();
            let st = app.state::<state::AppState>();
            st.output.set_sink(Box::new(move |entry| {
                let _ = handle.emit(commands::events::OUTPUT_ENTRY, entry);
            }));
            if let Some(w) = app.get_webview_window("main") {
                window::runtime::restore_and_show(&w, &st);
            }
            Ok(())
        })
        .on_window_event(|w, event| {
            if let Some(ww) = w.app_handle().get_webview_window(w.label()) {
                window::runtime::on_event(&ww, event, &w.state::<state::AppState>());
            }
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
            commands::workspace::workspace_list,
            commands::workspace::workspace_availability,
            commands::workspace::workspace_current,
            commands::workspace::workspace_open_dialog,
            commands::workspace::workspace_open_recent,
            commands::workspace::workspace_open_discovered,
            commands::workspace::workspace_close,
            commands::workspace::workspace_startup,
            commands::workspace::workspace_update_meta,
            commands::workspace::workspace_remove,
            commands::workspace::workspace_relocate,
            commands::workspace::workspace_discover,
            commands::workspace::workspace_save_as,
            commands::workspace::workspace_save_as_confirm,
            commands::workspace::workspace_reload_file,
            commands::workspace::trust_current,
            commands::workspace::trust_grant,
            commands::workspace::trust_deny,
            commands::workspace::trust_list,
            commands::workspace::trust_revoke,
            commands::workspace::session_load,
            commands::workspace::session_save,
            commands::workspace::session_ready,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ivily Center");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let st = handle.state::<state::AppState>();
            let result = workspace::session::mark_clean_exit(&st.db.lock());
            if let Err(e) = result {
                st.output.error("workspace", format!("could not record clean exit: {e}"));
            }
        }
    });
}
