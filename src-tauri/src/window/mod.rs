//! Window manager: frameless main window, bounds persistence and multi-monitor clamping.
//!
//! The main window starts hidden (`visible: false` in tauri.conf.json). On setup the saved bounds
//! are validated against the *current* monitor layout (monitors may have been unplugged or
//! rescaled since the last session), applied, and only then is the window shown — so it never
//! flashes at a wrong position or opens off-screen.
//!
//! Coordinates are physical pixels in the Windows virtual-screen space, which is what both the
//! OS and Tauri use for positions across monitors with different DPI scale factors.

pub mod runtime;

use serde::{Deserialize, Serialize};

pub const STATE_KEY: &str = "window.main";
/// Minimum visible part of the title bar required to keep a saved position.
const MIN_VISIBLE_W: i64 = 120;
const TITLE_STRIP_H: i64 = 32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedWindow {
    /// Last *normal* (not maximized/minimized) bounds.
    pub bounds: Bounds,
    pub maximized: bool,
}

/// A monitor's work area (excludes the taskbar).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn overlap(a0: i64, a1: i64, b0: i64, b1: i64) -> i64 {
    (a1.min(b1) - a0.max(b0)).max(0)
}

/// Fit saved bounds into the current monitor layout.
///
/// * Returns `None` when the window's title bar would not be reachable on any monitor
///   (the caller then centers the window with default size).
/// * Otherwise picks the monitor containing most of the title strip, shrinks the window to that
///   monitor's work area if needed (respecting `min`), and moves it fully inside.
pub fn fit_bounds(saved: Bounds, areas: &[Area], min: (u32, u32)) -> Option<Bounds> {
    if saved.width == 0 || saved.height == 0 {
        return None;
    }
    let (sx0, sy0) = (saved.x as i64, saved.y as i64);
    let sx1 = sx0 + saved.width as i64;
    let strip_y1 = sy0 + TITLE_STRIP_H.min(saved.height as i64);

    let best = areas
        .iter()
        .map(|a| {
            let (ax0, ay0) = (a.x as i64, a.y as i64);
            let (ax1, ay1) = (ax0 + a.width as i64, ay0 + a.height as i64);
            let w = overlap(sx0, sx1, ax0, ax1);
            let h = overlap(sy0, strip_y1, ay0, ay1);
            (a, w, h)
        })
        .filter(|(_, w, h)| *w >= MIN_VISIBLE_W && *h > 0)
        .max_by_key(|(_, w, h)| w * h)?
        .0;

    let width = saved.width.min(best.width).max(min.0.min(best.width));
    let height = saved.height.min(best.height).max(min.1.min(best.height));
    let max_x = best.x as i64 + best.width as i64 - width as i64;
    let max_y = best.y as i64 + best.height as i64 - height as i64;
    let x = (saved.x as i64).clamp(best.x as i64, max_x) as i32;
    let y = (saved.y as i64).clamp(best.y as i64, max_y) as i32;
    Some(Bounds { x, y, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (u32, u32) = (800, 520);
    const PRIMARY: Area = Area { x: 0, y: 0, width: 1920, height: 1040 };
    // A 4K monitor at 150% to the right, slightly higher.
    const SECONDARY: Area = Area { x: 1920, y: -200, width: 3840, height: 2100 };

    fn b(x: i32, y: i32, width: u32, height: u32) -> Bounds {
        Bounds { x, y, width, height }
    }

    #[test]
    fn keeps_valid_bounds() {
        assert_eq!(fit_bounds(b(100, 80, 1400, 900), &[PRIMARY], MIN), Some(b(100, 80, 1400, 900)));
        assert_eq!(fit_bounds(b(2500, 100, 2000, 1200), &[PRIMARY, SECONDARY], MIN), Some(b(2500, 100, 2000, 1200)));
    }

    #[test]
    fn rejects_bounds_on_a_disconnected_monitor() {
        assert_eq!(fit_bounds(b(2500, 100, 1400, 900), &[PRIMARY], MIN), None);
        assert_eq!(fit_bounds(b(-5000, -5000, 1400, 900), &[PRIMARY], MIN), None);
    }

    #[test]
    fn rejects_title_bar_above_screen() {
        // Title bar hidden above the top edge; only the bottom of the window is visible.
        assert_eq!(fit_bounds(b(100, -600, 1400, 900), &[PRIMARY], MIN), None);
    }

    #[test]
    fn pulls_partially_offscreen_windows_inside() {
        assert_eq!(fit_bounds(b(1500, 500, 1400, 900), &[PRIMARY], MIN), Some(b(520, 140, 1400, 900)));
    }

    #[test]
    fn shrinks_windows_larger_than_the_monitor() {
        let small = Area { x: 0, y: 0, width: 1280, height: 680 };
        assert_eq!(fit_bounds(b(0, 0, 1920, 1080), &[small], MIN), Some(b(0, 0, 1280, 680)));
        // Never below the minimum size unless the monitor itself is smaller.
        let tiny = Area { x: 0, y: 0, width: 700, height: 500 };
        assert_eq!(fit_bounds(b(0, 0, 1920, 1080), &[tiny], MIN), Some(b(0, 0, 700, 500)));
    }

    #[test]
    fn picks_the_monitor_with_most_of_the_title_bar() {
        let r = fit_bounds(b(1800, 50, 1400, 900), &[PRIMARY, SECONDARY], MIN).unwrap();
        assert!(r.x >= 1920, "should move onto the secondary monitor: {r:?}");
    }

    #[test]
    fn rejects_degenerate_sizes() {
        assert_eq!(fit_bounds(b(0, 0, 0, 900), &[PRIMARY], MIN), None);
    }
}
