//! The settings registry. Adding a setting = adding one entry here (and using it).
//!
//! Only settings that are actually consumed by implemented code are registered; later phases
//! add their own (`editor.*`, `terminal.*`, ...).

use super::{DefaultValue as D, ScopeSet, SettingDef, SettingType as T};

pub const THEMES: &[(&str, &str)] = &[
    ("modern-dark", "Modern Dark"),
    ("modern-light", "Modern Light"),
    ("pixel-dark", "Pixel Dark"),
    ("pixel-light", "Pixel Light"),
    ("retro-terminal", "Retro Terminal"),
    ("glass", "Glass"),
];

pub const SETTINGS: &[SettingDef] = &[
    // ── Appearance ────────────────────────────────────────────────────────────
    SettingDef {
        key: "appearance.theme",
        title: "Theme",
        description: "Colour theme, typography, component style and icon pack of the whole application.",
        category: "Appearance",
        ty: T::Enum(THEMES),
        default: D::Str("modern-dark"),
        scopes: ScopeSet::UserAndWorkspace,
    },
    SettingDef {
        key: "appearance.uiFontSize",
        title: "Interface font size",
        description: "Base font size of the interface in pixels. Every UI element scales with it.",
        category: "Appearance",
        ty: T::Integer { min: 10, max: 20 },
        default: D::Int(13),
        scopes: ScopeSet::User,
    },
    SettingDef {
        key: "appearance.reduceMotion",
        title: "Reduce motion",
        description: "Disable interface animations. 'system' follows the Windows animation setting.",
        category: "Appearance",
        ty: T::Enum(&[("system", "Follow system"), ("on", "On"), ("off", "Off")]),
        default: D::Str("system"),
        scopes: ScopeSet::User,
    },
    // ── Files & Explorer ──────────────────────────────────────────────────────
    SettingDef {
        key: "files.exclude",
        title: "Excluded files",
        description: "Glob patterns (one per line) of files and folders hidden from the explorer, Quick Open and search, e.g. **/node_modules or **/*.tmp.",
        category: "Files",
        ty: T::StringList { max_items: 200, max_len: 256 },
        default: D::List(&["**/.git", "**/.svn", "**/.hg", "**/Thumbs.db", "**/desktop.ini", "**/.DS_Store"]),
        scopes: ScopeSet::UserAndWorkspace,
    },
    SettingDef {
        key: "explorer.gitIgnored",
        title: "Files ignored by .gitignore",
        description: "How the explorer shows files matched by .gitignore.",
        category: "Files",
        ty: T::Enum(&[("dim", "Show dimmed"), ("hide", "Hide"), ("show", "Show normally")]),
        default: D::Str("dim"),
        scopes: ScopeSet::UserAndWorkspace,
    },
    SettingDef {
        key: "explorer.showHidden",
        title: "Show hidden files",
        description: "Show files and folders with the Windows hidden attribute or a leading dot.",
        category: "Files",
        ty: T::Bool,
        default: D::Bool(true),
        scopes: ScopeSet::UserAndWorkspace,
    },
    SettingDef {
        key: "explorer.sortOrder",
        title: "Sort order",
        description: "How explorer entries are ordered.",
        category: "Files",
        ty: T::Enum(&[("foldersFirst", "Folders first, then by name"), ("mixed", "By name"), ("type", "By file type"), ("modified", "Most recently modified first")]),
        default: D::Str("foldersFirst"),
        scopes: ScopeSet::UserAndWorkspace,
    },
    SettingDef {
        key: "explorer.confirmDelete",
        title: "Confirm before moving to the Recycle Bin",
        description: "Ask before deleting. Permanent deletion always asks.",
        category: "Files",
        ty: T::Bool,
        default: D::Bool(true),
        scopes: ScopeSet::User,
    },
    // ── Workbench ─────────────────────────────────────────────────────────────
    SettingDef {
        key: "workbench.startup",
        title: "On startup",
        description: "What to show when Ivily Center starts. A folder passed on the command line is always opened.",
        category: "Workbench",
        ty: T::Enum(&[
            ("lastWorkspace", "Reopen the last workspace"),
            ("launcher", "Show the launcher"),
            ("welcome", "Show the welcome page"),
        ]),
        default: D::Str("lastWorkspace"),
        scopes: ScopeSet::User,
    },
    // ── Security ──────────────────────────────────────────────────────────────
    SettingDef {
        key: "security.workspaceTrust.prompt",
        title: "Ask to trust new workspaces",
        description: "Ask whether to trust a folder the first time it is opened. When off, undecided workspaces open in Restricted Mode without asking. Trust is never granted automatically.",
        category: "Security",
        ty: T::Bool,
        default: D::Bool(true),
        scopes: ScopeSet::User,
    },
    // ── Window ────────────────────────────────────────────────────────────────
    SettingDef {
        key: "window.restoreBounds",
        title: "Restore window size and position",
        description: "Reopen the main window where it was last closed (clamped to the connected monitors).",
        category: "Window",
        ty: T::Bool,
        default: D::Bool(true),
        scopes: ScopeSet::User,
    },
    // ── Notifications ─────────────────────────────────────────────────────────
    SettingDef {
        key: "notifications.level",
        title: "Show notifications",
        description:
            "Minimum severity that shows a pop-up. All notifications are still kept in the notification centre.",
        category: "Notifications",
        ty: T::Enum(&[("info", "All"), ("warning", "Warnings and errors"), ("error", "Errors only")]),
        default: D::Str("info"),
        scopes: ScopeSet::User,
    },
    SettingDef {
        key: "notifications.doNotDisturb",
        title: "Do not disturb",
        description:
            "Suppress all pop-ups except errors. Notifications are still collected in the notification centre.",
        category: "Notifications",
        ty: T::Bool,
        default: D::Bool(false),
        scopes: ScopeSet::User,
    },
    SettingDef {
        key: "notifications.timeoutSeconds",
        title: "Pop-up duration",
        description: "Seconds before an informational pop-up hides itself. Errors stay until dismissed.",
        category: "Notifications",
        ty: T::Integer { min: 2, max: 60 },
        default: D::Int(6),
        scopes: ScopeSet::User,
    },
    // ── Output ────────────────────────────────────────────────────────────────
    SettingDef {
        key: "output.maxLinesPerChannel",
        title: "Output history per channel",
        description: "Maximum number of lines kept in memory for each output channel. Older lines are discarded.",
        category: "Output",
        ty: T::Integer { min: 500, max: 100_000 },
        default: D::Int(5000),
        scopes: ScopeSet::User,
    },
];

/// Renamed setting keys `(old, new)`, applied once at startup. Append-only.
pub const RENAMED: &[(&str, &str)] = &[];
