//! Output channels: named, bounded, timestamped logs shown in the Output panel.
//!
//! Every subsystem writes through [`OutputHub`]; lines are redacted before they are stored. A
//! sink (set by the Tauri layer) forwards new entries to the UI, so this module has no Tauri
//! dependency and is unit-testable.

pub mod redact;

use crate::core::now_ms;
use crate::error::{AppError, AppResult};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

/// Built-in channels. Later phases register more (git, lsp, tasks, ...).
pub const BUILTIN_CHANNELS: &[(&str, &str)] = &[
    ("app", "Ivily Center"),
    ("window", "Window"),
    ("settings", "Settings"),
    ("database", "Database"),
    ("ui", "Interface"),
];

/// Channels the webview may write to. Everything else is backend-only.
pub const UI_WRITABLE: &[&str] = &["ui"];

pub const MAX_LINE_BYTES: usize = 16 * 1024;
pub const DEFAULT_CAPACITY: usize = 5000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Trace,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub channel: String,
    /// Monotonic sequence number across all channels (for incremental reads).
    pub seq: u64,
    pub ts: i64,
    pub level: Level,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: String,
    pub label: String,
    pub lines: usize,
    pub ui_writable: bool,
}

struct Channel {
    label: String,
    lines: VecDeque<Entry>,
}

type Sink = Box<dyn Fn(&Entry) + Send + Sync>;

pub struct OutputHub {
    channels: Mutex<BTreeMap<String, Channel>>,
    seq: Mutex<u64>,
    capacity: RwLock<usize>,
    sink: RwLock<Option<Sink>>,
}

impl Default for OutputHub {
    fn default() -> Self {
        Self::new()
    }
}

fn valid_channel_id(id: &str) -> bool {
    (1..=48).contains(&id.len())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

impl OutputHub {
    pub fn new() -> Self {
        let hub = Self {
            channels: Mutex::new(BTreeMap::new()),
            seq: Mutex::new(0),
            capacity: RwLock::new(DEFAULT_CAPACITY),
            sink: RwLock::new(None),
        };
        for (id, label) in BUILTIN_CHANNELS {
            hub.register(id, label).expect("built-in channel ids are valid");
        }
        hub
    }

    /// Register a channel (idempotent).
    pub fn register(&self, id: &str, label: &str) -> AppResult<()> {
        if !valid_channel_id(id) {
            return Err(AppError::validation("invalid_channel", format!("invalid output channel id: {id}")));
        }
        self.channels
            .lock()
            .entry(id.to_string())
            .or_insert_with(|| Channel { label: label.to_string(), lines: VecDeque::new() });
        Ok(())
    }

    pub fn set_sink(&self, sink: Sink) {
        *self.sink.write() = Some(sink);
    }

    pub fn set_capacity(&self, capacity: usize) {
        let capacity = capacity.max(1);
        *self.capacity.write() = capacity;
        for ch in self.channels.lock().values_mut() {
            while ch.lines.len() > capacity {
                ch.lines.pop_front();
            }
        }
    }

    pub fn append(&self, channel: &str, level: Level, message: &str) -> AppResult<Entry> {
        let message = redact::redact(truncate_utf8(message, MAX_LINE_BYTES));
        let capacity = *self.capacity.read();
        let entry = {
            let mut channels = self.channels.lock();
            let ch =
                channels.get_mut(channel).ok_or_else(|| AppError::NotFound(format!("output channel {channel}")))?;
            let seq = {
                let mut s = self.seq.lock();
                *s += 1;
                *s
            };
            let entry = Entry { channel: channel.to_string(), seq, ts: now_ms(), level, message };
            ch.lines.push_back(entry.clone());
            while ch.lines.len() > capacity {
                ch.lines.pop_front();
            }
            entry
        };
        if let Some(sink) = self.sink.read().as_ref() {
            sink(&entry);
        }
        Ok(entry)
    }

    /// Convenience for backend code: logging must never fail the caller.
    pub fn log(&self, channel: &str, level: Level, message: impl AsRef<str>) {
        let _ = self.append(channel, level, message.as_ref());
    }

    pub fn info(&self, channel: &str, message: impl AsRef<str>) {
        self.log(channel, Level::Info, message);
    }

    pub fn warn(&self, channel: &str, message: impl AsRef<str>) {
        self.log(channel, Level::Warn, message);
    }

    pub fn error(&self, channel: &str, message: impl AsRef<str>) {
        self.log(channel, Level::Error, message);
    }

    /// Entries of `channel` with `seq > after`.
    pub fn read(&self, channel: &str, after: u64) -> AppResult<Vec<Entry>> {
        let channels = self.channels.lock();
        let ch = channels.get(channel).ok_or_else(|| AppError::NotFound(format!("output channel {channel}")))?;
        Ok(ch.lines.iter().filter(|e| e.seq > after).cloned().collect())
    }

    pub fn clear(&self, channel: &str) -> AppResult<()> {
        let mut channels = self.channels.lock();
        let ch = channels.get_mut(channel).ok_or_else(|| AppError::NotFound(format!("output channel {channel}")))?;
        ch.lines.clear();
        Ok(())
    }

    pub fn channels(&self) -> Vec<ChannelInfo> {
        self.channels
            .lock()
            .iter()
            .map(|(id, c)| ChannelInfo {
                id: id.clone(),
                label: c.label.clone(),
                lines: c.lines.len(),
                ui_writable: UI_WRITABLE.contains(&id.as_str()),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn appends_reads_incrementally_and_clears() {
        let hub = OutputHub::new();
        let a = hub.append("app", Level::Info, "one").unwrap();
        hub.append("settings", Level::Warn, "other channel").unwrap();
        hub.append("app", Level::Error, "two").unwrap();
        assert_eq!(hub.read("app", 0).unwrap().len(), 2);
        let after = hub.read("app", a.seq).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].message, "two");
        hub.clear("app").unwrap();
        assert!(hub.read("app", 0).unwrap().is_empty());
        assert_eq!(hub.read("settings", 0).unwrap().len(), 1);
    }

    #[test]
    fn capacity_bounds_memory() {
        let hub = OutputHub::new();
        hub.set_capacity(3);
        for i in 0..10 {
            hub.info("app", format!("line {i}"));
        }
        let lines = hub.read("app", 0).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].message, "line 7");
    }

    #[test]
    fn redacts_and_truncates() {
        let hub = OutputHub::new();
        let e = hub.append("app", Level::Info, "TOKEN=abc123").unwrap();
        assert!(!e.message.contains("abc123"));
        let long = "é".repeat(MAX_LINE_BYTES);
        let e = hub.append("app", Level::Info, &long).unwrap();
        assert!(e.message.len() <= MAX_LINE_BYTES);
    }

    #[test]
    fn rejects_unknown_and_malformed_channels() {
        let hub = OutputHub::new();
        assert!(hub.append("nope", Level::Info, "x").is_err());
        assert!(hub.register("Bad Id", "x").is_err());
        assert!(hub.register("git", "Git").is_ok());
        assert!(hub.append("git", Level::Info, "x").is_ok());
    }

    #[test]
    fn sink_receives_entries() {
        let hub = OutputHub::new();
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        hub.set_sink(Box::new(move |e| g.lock().push(e.seq)));
        hub.info("app", "a");
        hub.info("ui", "b");
        assert_eq!(got.lock().len(), 2);
    }
}
