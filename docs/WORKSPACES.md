# Workspaces, Workspace Trust and sessions

Implementation: `src-tauri/src/workspace/` (backend), `src/workspace/` (UI state),
`src/features/launcher/`, `src/features/trust/`.

A **workspace** is the context every IDE subsystem works in. Its folders are the roots the user has
opened — the only places future file, search, Git, terminal and language-server operations may act
on. Its id keys sessions and workspace data, and its trust state gates anything that would execute
workspace-controlled content.

## Kinds

| Kind | What it is | Where workspace data lives |
|---|---|---|
| Folder | One folder opened directly | Ivily Center's database only. **Nothing is written into the folder.** |
| Workspace file | A `*.ivily-workspace` file listing one or more folders | Folder list and workspace settings in the file (portable); session in the database |

## Opening a workspace

Workspaces open from exactly four sources, so the user interface never supplies a filesystem path:

1. a native folder/file dialog shown by the backend (**Open Folder…** `Ctrl+Alt+O`, **Open Workspace File…**),
2. a known workspace (launcher, by id),
3. a project found by **Find Projects…** (opaque token for a folder inside the folder the user picked),
4. a folder or workspace file passed on the command line (`ivily-center.exe C:\code\shop`).

Validation: paths must be absolute; device paths (`\\.\…`) are refused; the location is canonicalized
(junctions and symlinks resolved, `\\?\` prefix removed) and must be an existing, readable folder
(or a `.ivily-workspace` file). Opening a workspace **executes nothing**.

**Duplicates.** Workspaces are keyed by a canonical, case-insensitive path key, so `c:/Code/App/` and
`C:\code\app` are the same workspace; reopening updates its recency instead of adding an entry.

**Moved or missing locations.** The launcher checks availability in parallel with a 3-second timeout
per entry (an unreachable network share cannot freeze it) and shows *Missing*, *Not accessible* or
*Not reachable*. **Locate…** points the entry at the new location (trust is *not* carried over: it
belongs to the old location). Folders missing from a workspace file are listed as unavailable; the
workspace opens if at least one folder is available.

**Removing** a workspace from the list deletes its registry entry, session and database-stored
workspace settings. Files on disk and trust decisions are never touched.

## Switching

Opening, switching and closing go through one serialized transition:

1. the current workspace's session is saved,
2. the backend opens the new workspace (cancelling a dialog changes nothing; errors keep the current workspace),
3. every session participant resets its workspace-specific state,
4. an epoch counter is incremented — async work started for the previous workspace is discarded,
5. context keys, the title, and settings (with the new workspace layer) are updated,
6. the new workspace's session is restored.

The backend stores the open workspace **per window**; every workspace-scoped command (settings,
session, trust) resolves the workspace of the *calling* window and never accepts a workspace id from
the UI, so one window cannot read or write another workspace's data.

## Launcher

The launcher is the editor-area page shown when no workspace is open, and on demand
(**Show Launcher / Recent Workspaces**, `Ctrl+R`, or the workspace name in the status bar). It lists
favorites and recent workspaces (filter by name, path or group), lets you rename, group, favorite,
locate and remove entries, finds projects inside a chosen folder (one level deep, by marker files
such as `.git`, `Cargo.toml`, `package.json`; symlinks are not followed and no file contents are read),
and sets the startup behaviour.

**Startup** (`workbench.startup`): *Reopen the last workspace* (default; falls back to the launcher
if it is gone), *Show the launcher*, or *Show the welcome page*. A path on the command line always
wins. The launcher is never a mandatory step.

## Workspace settings

Precedence: **default < user < workspace**. Only settings declared workspace-capable can be set per
workspace (currently `appearance.theme`); the Settings view has *User* and *Workspace* tabs.
Folder workspaces store workspace settings in the database; workspace files store them in the file.

## Workspace files (`*.ivily-workspace`, format 1)

```json
{
  "ivilyWorkspace": 1,
  "name": "Shop",
  "folders": [ { "path": "." }, { "path": "../shared-lib", "name": "Shared" } ],
  "settings": { "appearance.theme": "pixel-dark" }
}
```

* `folders[].path` is relative to the file's directory or absolute. Up to 64 folders; files ≤ 1 MB;
  UTF-8 (BOM accepted). A file with a newer format version is refused with an explanation.
* Unknown fields are preserved when Ivily Center rewrites the file.
* Trust is **never** read from a workspace file.
* **Created only explicitly** with **Save Workspace As…**. An existing file is replaced only after a
  confirmation; the target path stays in the backend (the UI holds an opaque token).
* **Written only on an explicit change** (a workspace setting), atomically (temporary file + rename),
  and only if the file still has the content Ivily Center read (SHA-256 comparison). If it changed or
  disappeared, nothing is written and **Reload Workspace File** is offered.

## Workspace Trust

Trust is a user decision about folders on this computer, stored only in Ivily Center's database.

| Property | Behaviour |
|---|---|
| Default | Every folder is untrusted until the user decides. Untrusted = **Restricted Mode**. |
| Granular | Six capabilities: run workspace tasks, start workspace-defined processes, start workspace-configured language servers, activate workspace extensions, start debug sessions, use executables from workspace settings. A grant may cover any subset. |
| Scope | One folder, or a folder **and everything below it** (e.g. trust `C:\code` once). Whole drives cannot be trusted with their children. |
| Duration | Remembered, or **for this session only** (kept in memory). |
| Denial | **Stay restricted** is remembered, so the user is not asked again for that folder. |
| Resolution | The most specific decision wins (exact folder over the nearest trusted parent; a session grant over a stored decision). A multi-folder workspace has a capability only if every folder grants it. |
| Revocation | **Manage Workspace Trust** lists the current workspace's folders (with where their state comes from) and every remembered decision; each can be revoked or forgotten after confirmation. |
| Prompt | Shown when an undecided workspace opens (setting `security.workspaceTrust.prompt`). Closing it decides nothing. With prompts off, workspaces open restricted; trust is never granted automatically. |

Enforcement is in the backend: subsystems call `workspace::service::require_capability` (or
`trust::require`), which fails with error code `workspace_untrusted`. Gated subsystems: language
servers (`languageServers`), Git (`workspaceExecutables`), tasks (`taskExecution`, plus approval of
each command) and debugging (`debugging`, plus approval of each launch configuration). Terminals
start only the user's own profiles; extensions are declarative and never come from a workspace
(workspace recommendations are only listed), so `processLaunch` and `extensions` have nothing to gate
today.

## Sessions and crash recovery

* Features contribute **session participants** (`registerSessionParticipant(id, { save, restore, reset })`).
  The workbench layout is the first; editor tabs, explorer state, terminals and Git views will follow.
* The versioned session document (≤ 256 KB) is saved debounced, before switching, and before the
  window closes. The backend keeps the previous version; if the latest is unreadable, the previous one
  is restored and the user is told.
* Every start is counted until the workbench reports it has restored. After two starts in a row that
  never got that far, Ivily Center starts in **safe mode** and does not reopen the last workspace. A
  missing clean-exit marker is reported as "did not shut down cleanly".

## Data separation

| Data | Owner | Location |
|---|---|---|
| User settings, theme, keybindings, layout default | User | Database, user scope / `app_state` |
| Workspace registry, sessions, folder-workspace settings | Workspace | Database, keyed by workspace id |
| Trust decisions | User (about folders) | Database, keyed by folder path |
| Workspace files | Project | `*.ivily-workspace`, only when the user saves one |
