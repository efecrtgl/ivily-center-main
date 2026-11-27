# File explorer

Implementation: `src-tauri/src/fs/` (backend), `src/features/explorer/` (UI), `src/icons/fileTypes.js`.

## Scope and safety

* The UI addresses files as *(workspace folder index, relative path)*. The backend validates every
  path: no absolute or UNC paths, no `..`/`.`, no `:` (alternate data streams), no reserved Windows
  device names (`CON`, `NUL`, `COM1`, …), no trailing dots/spaces, no invalid characters. The
  resolved path (or its nearest existing ancestor) is canonicalized and must stay inside the
  workspace folder, so links and junctions cannot be used to reach other locations.
* Nothing is overwritten: creating, renaming, copying and moving fail on existing targets (copies
  and duplicates can pick a unique name such as `name copy.ext`). A case-only rename is allowed.
* **Delete** moves items to the Recycle Bin after a confirmation (`explorer.confirmDelete`).
  **Delete Permanently** (Shift+Delete) always asks. Workspace folders themselves cannot be deleted,
  renamed, copied or moved from the explorer.
* Folders cannot be copied or moved into themselves; a failed copy removes the partial copy it created.
* Dragging items onto a folder moves them (hold Ctrl to copy) after a confirmation.

## Listing

* Folders are listed lazily on expand; at most 20 000 entries per folder (a marker shows truncation).
* `files.exclude` glob patterns hide entries (and everything below a matching folder).
* `.gitignore` files (nested ones included) and `.git/info/exclude` are honoured; matches are dimmed,
  hidden or shown normally (`explorer.gitIgnored`).
* Hidden files (Windows hidden attribute or leading dot) are shown dimmed or hidden (`explorer.showHidden`).
* Sort orders: folders first (natural order, `file2` before `file10`), by name, by type, by modification date.

## Watching

One recursive watcher per workspace folder, restarted whenever the window's workspace changes.
Events are batched (150 ms); only loaded folders that contain changes are reloaded; large bursts
trigger a reload of what is loaded. Changes inside `.git` are reported separately for the Git view.

## Interaction

| Action | How |
|---|---|
| Select / multi-select | Click, Ctrl+click, Shift+click, Shift+arrows, Ctrl+A |
| Navigate | Arrows, Home/End, PageUp/PageDown; Right expands / enters, Left collapses / goes to parent |
| Open | Click (preview) or double-click / Enter (pinned) once the editor exists (Phase 5) |
| New file / folder | Toolbar, context menu or commands; names may contain `/` to create nested folders |
| Rename | F2 or context menu (inline; the extension is not pre-selected) |
| Cut / copy / paste | Ctrl+X / Ctrl+C / Ctrl+V or context menu |
| Delete | Delete (Recycle Bin) / Shift+Delete (permanent) |
| Other | Duplicate, Copy Path, Copy Relative Path, Reveal in File Explorer, Properties, Refresh, Collapse All |

The explorer's expanded folders and selection are part of the workspace session.

## Icons

`src/icons/fileTypes.js` maps ~90 file types (exact names such as `Cargo.toml`, compound
extensions such as `.d.ts`/`.test.tsx`, plain extensions) and special folder names (`src`, `.git`,
`node_modules`, `dist`, …) to a short badge and a colour. The active icon pack draws the page or folder
shape (smooth in the Modern pack, pixel-crisp in the Pixel pack), so every theme stays consistent.
Other features can annotate rows through `features/explorer/decorations.js` (used by Git later).
