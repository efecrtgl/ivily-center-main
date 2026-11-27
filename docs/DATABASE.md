# Database and persistence

Implementation: `src-tauri/src/db/`, `src-tauri/src/settings/`, `src-tauri/src/app_state.rs`.

## Location

`%LOCALAPPDATA%\IvilyCenter\center.db` (SQLite, WAL mode). Backups taken before migrations go to
`%LOCALAPPDATA%\IvilyCenter\backups\`.

## Ownership rules

* Each subsystem owns its tables and is the only module that issues SQL against them.
* Table names carry the owner's prefix: `settings`, `app_state`; future: `workspace_*`,
  `project_*`, `session_*`, `ext_*`, `module_*`, `ecosystem_*`, `notes_*`.
* Cross-subsystem references use stable string ids, not foreign keys, so a subsystem can be
  migrated, cleared or exported independently. Cleanup on deletion (e.g. a workspace's settings)
  is done by the owning subsystem's code.
* Project source code is never stored in the database.

## Schema history

| Version | Migration | Tables (owner) |
|---|---|---|
| 1 | `settings_and_app_state` | `settings` (settings), `app_state` (window manager / UI layout) |
| 2 | `workspaces_trust_sessions` | `workspace`, `workspace_session` (workspace manager), `workspace_trust` (trust) |

`settings`: `(scope, scope_id, key) → value (JSON), updated_at`. `scope` is `user` or
`workspace`; `scope_id` is empty for user scope and a Center-generated workspace id otherwise.

`app_state`: `key → value (JSON), updated_at`. `window.*` keys are written only by Rust;
`ui.*` keys may be written by the webview after validation (key format, ≤ 64 KB value).

## Migrations

* Forward-only, numbered, stored in `db/migrations.rs`; released migrations are never edited.
* All pending migrations run in **one transaction**; on failure nothing is applied.
* If the database already contains data, a full copy is made with SQLite's online backup API
  before migrating.
* `PRAGMA user_version` stores the schema version.

## Failure handling

| Situation | Behaviour |
|---|---|
| File missing | Created and migrated. |
| Integrity check (`PRAGMA quick_check`) fails or file is not SQLite | File (and `-wal`/`-shm`) renamed to `center.db.corrupt-<timestamp>` — **kept, never deleted** — and a new database is created. The user is notified. |
| Schema newer than this build | File left untouched; the session runs on an in-memory database and the user is told changes will not be saved. |
| Any other open failure | In-memory database for the session, error notification. |

## Settings resolution

Precedence: **default < user < workspace**. Each setting declares whether it accepts workspace
scope. Stored values are re-validated on every read: invalid values fall back to the next layer
and are reported in the *Settings* output channel, but are not deleted. Unknown keys (e.g. from a
newer version) are preserved. Renamed keys are migrated at startup via `settings::schema::RENAMED`.
