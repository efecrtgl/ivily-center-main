use crate::error::{AppError, AppResult};
use crate::output::{ChannelInfo, Entry, Level, UI_WRITABLE};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn output_channels(state: State<'_, AppState>) -> Vec<ChannelInfo> {
    state.output.channels()
}

#[tauri::command]
pub fn output_read(state: State<'_, AppState>, channel: String, after: Option<u64>) -> AppResult<Vec<Entry>> {
    state.output.read(&channel, after.unwrap_or(0))
}

#[tauri::command]
pub fn output_clear(state: State<'_, AppState>, channel: String) -> AppResult<()> {
    state.output.clear(&channel)
}

/// The webview may only write to UI channels; backend channels stay trustworthy.
#[tauri::command]
pub fn output_append(state: State<'_, AppState>, channel: String, level: Level, message: String) -> AppResult<()> {
    if !UI_WRITABLE.contains(&channel.as_str()) {
        return Err(AppError::PermissionDenied(format!("output channel {channel} is not writable from the UI")));
    }
    state.output.append(&channel, level, &message).map(|_| ())
}
