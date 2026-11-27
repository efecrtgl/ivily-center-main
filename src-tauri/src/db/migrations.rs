//! Forward-only schema migrations. Never edit a released migration; append a new one.
//!
//! Each migration lists which subsystem owns the tables it creates.

pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "settings_and_app_state",
        // Owners: `settings` → settings subsystem; `app_state` → window manager and UI layout.
        sql: "
        CREATE TABLE settings (
            scope      TEXT    NOT NULL CHECK (scope IN ('user', 'workspace')),
            scope_id   TEXT    NOT NULL DEFAULT '',
            key        TEXT    NOT NULL,
            value      TEXT    NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, scope_id, key)
        ) WITHOUT ROWID;

        CREATE TABLE app_state (
            key        TEXT    PRIMARY KEY,
            value      TEXT    NOT NULL,
            updated_at INTEGER NOT NULL
        ) WITHOUT ROWID;
    ",
    },
    Migration {
        version: 2,
        name: "workspaces_trust_sessions",
        // Owners: `workspace`, `workspace_session` → workspace manager; `workspace_trust` → trust.
        // Trust is keyed by folder path (a user decision about a location), not by workspace id.
        sql: "
        CREATE TABLE workspace (
            id             TEXT    PRIMARY KEY,
            kind           TEXT    NOT NULL CHECK (kind IN ('folder', 'file')),
            path           TEXT    NOT NULL,
            path_key       TEXT    NOT NULL UNIQUE,
            name           TEXT    NOT NULL,
            favorite       INTEGER NOT NULL DEFAULT 0,
            group_name     TEXT    NOT NULL DEFAULT '',
            created_at     INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            open_count     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX workspace_by_recent ON workspace (last_opened_at DESC);

        CREATE TABLE workspace_trust (
            path_key         TEXT    PRIMARY KEY,
            path             TEXT    NOT NULL,
            decision         TEXT    NOT NULL CHECK (decision IN ('trusted', 'denied')),
            include_children INTEGER NOT NULL DEFAULT 0,
            capabilities     TEXT    NOT NULL DEFAULT '[]',
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE workspace_session (
            workspace_id   TEXT    PRIMARY KEY,
            state          TEXT    NOT NULL,
            previous_state TEXT,
            updated_at     INTEGER NOT NULL
        ) WITHOUT ROWID;
    ",
    },
];
