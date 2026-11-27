# Backup and restore

Implementation: `src-tauri/src/backup/` + `commands/backup.rs`, `src/features/backup/`.

## What is backed up

Only Ivily Center's own data from `%LOCALAPPDATA%\IvilyCenter`:

| Entry | Contents |
|---|---|
| `center.db` | Settings, UI state, workspace registry, trust decisions, sessions (bookmarks, breakpoints, open editors), approvals, histories — a consistent copy made with SQLite's online backup API while the app runs |
| `notes/` | Workspace notes |
| `extensions/` | Installed extensions |
| `drafts/` | Unsaved editor content (hot exit) |

**Project files are never included** — use version control for them.

## Format

A zip archive `ivily-center-<kind>-<YYYYMMDD-HHMMSS>.zip` (UTC) in `app-backups/` with a
`manifest.json`: format version, app version, creation time, kind (`manual`, `automatic`,
`safety`, `imported`), database schema version and the size and SHA-256 of every file.

## Operations (Backups page, *Show Backups*)

* **Back Up Now** — manual backup (never removed automatically).
* **Automatic backups** — off / daily / weekly (default weekly): 30 seconds after startup, if the
  newest automatic backup is older than the interval. *Keep the last N* (default 10) applies only to
  automatic backups.
* **Verify** — checks that every entry path is safe (relative, no `..`, no drive letters), every
  listed file is present with the recorded size and SHA-256, nothing unlisted is present, the
  database passes `PRAGMA integrity_check`, and it is not from a newer schema.
* **Restore** — asks first, verifies, creates a *safety* backup of the current state, then extracts
  the archive into `pending-restore/`. The restore is applied at the next start **before** the
  database is opened: the current database and folders are moved to
  `replaced-by-restore-<time>/` (kept, not deleted) and the backup's files take their place. A
  staged restore can be cancelled until then. The result is reported after the restart.
* **Export** — copies an archive to a location you choose (an existing file is only replaced after
  confirmation). **Import** — verifies an archive and copies it into the backup folder; restoring it
  is a separate step.
* **Delete** — removes one archive after confirmation.

## Corruption recovery

If the database cannot be opened, it is renamed to `center.db.corrupt-<time>` (kept) and a new one
is created (see DATABASE.md). The notification about it offers *Restore from a backup*.

## Verification

Creating, verifying (including a tampered archive and a non-zip file), retention, import and a
full staged restore applied before reopening the database are covered by Rust tests against real
files. The UI flow is covered by component tests.
