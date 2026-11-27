// Prevent an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--iep describe` / `--iep request`: answer the Ivily Ecosystem Protocol and exit without
    // opening a window or touching the database.
    if let Some(code) = center_lib::iep::server::maybe_run_cli() {
        std::process::exit(code);
    }
    center_lib::run()
}
