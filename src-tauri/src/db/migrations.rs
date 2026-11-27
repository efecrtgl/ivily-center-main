//! Forward-only schema migrations. Never edit a released migration; append a new one.
//!
//! Each migration lists which subsystem owns the tables it creates.

pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[Migration {
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
}];
