//! Tauri glue for the window manager (kept separate so `window::fit_bounds` stays pure).

use super::{fit_bounds, Area, Bounds, SavedWindow, STATE_KEY};
use crate::state::AppState;
use crate::{app_state, settings};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

const MIN_SIZE: (u32, u32) = (800, 520);

fn current_normal_bounds(w: &WebviewWindow) -> Option<Bounds> {
    if w.is_maximized().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return None;
    }
    // Position is the outer position (what `set_position` sets); size is the *inner* size,
    // because `set_size` sets the inner size. Saving the outer size made the window grow by the
    // frame thickness on every launch.
    let pos = w.outer_position().ok()?;
    let size = w.inner_size().ok()?;
    Some(Bounds { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/// Apply saved bounds (if enabled and still valid), then show the window. Never leaves the
/// window hidden: every failure path falls through to `show()`.
pub fn restore_and_show(w: &WebviewWindow, state: &AppState) {
    let enabled =
        settings::get_user(&state.db.lock(), "window.restoreBounds").ok().and_then(|v| v.as_bool()).unwrap_or(true);
    let saved: Option<SavedWindow> =
        if enabled { app_state::get(&state.db.lock(), STATE_KEY).ok().flatten() } else { None };

    if let Some(saved) = saved {
        let areas: Vec<Area> = w
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| {
                let wa = m.work_area();
                Area { x: wa.position.x, y: wa.position.y, width: wa.size.width, height: wa.size.height }
            })
            .collect();
        match fit_bounds(saved.bounds, &areas, MIN_SIZE) {
            Some(b) => {
                let _ = w.set_size(PhysicalSize::new(b.width, b.height));
                let _ = w.set_position(PhysicalPosition::new(b.x, b.y));
                *state.window_normal.lock() = Some(b);
                if b != saved.bounds {
                    state.output.info("window", "saved window bounds adjusted to the current monitor layout");
                }
            }
            None => {
                let _ = w.center();
                state.output.info("window", "saved window position is not on a connected monitor; centered instead");
            }
        }
        if saved.maximized {
            let _ = w.maximize();
        }
    }
    if let Err(e) = w.show() {
        state.output.error("window", format!("could not show main window: {e}"));
    }
    let _ = w.set_focus();
}

/// Track the last normal bounds and persist them when the window closes.
pub fn on_event(w: &WebviewWindow, event: &WindowEvent, state: &AppState) {
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(b) = current_normal_bounds(w) {
                *state.window_normal.lock() = Some(b);
            }
        }
        WindowEvent::CloseRequested { .. } => save(w, state),
        _ => {}
    }
}

pub fn save(w: &WebviewWindow, state: &AppState) {
    let bounds = current_normal_bounds(w).or(*state.window_normal.lock());
    let Some(bounds) = bounds else { return };
    let saved = SavedWindow { bounds, maximized: w.is_maximized().unwrap_or(false) };
    if let Err(e) = app_state::set(&state.db.lock(), STATE_KEY, &saved) {
        state.output.error("window", format!("could not save window state: {e}"));
    }
}
