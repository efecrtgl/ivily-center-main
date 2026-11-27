# Search, Quick Open, Command Palette and shortcuts

Implementation: `src-tauri/src/search/` + `commands/search.rs`, `src/features/search/`,
`src/features/palette/`, `src/features/keybindings/`.

## Search in files (Ctrl+Shift+F, replace: Ctrl+Shift+H)

* The backend searches the workspace folders with ripgrep's libraries (`grep-searcher`,
  `grep-regex`, `ignore`) on several threads and streams results to the view in batches; typing
  re-runs the search after a short pause, Enter runs it immediately, **Stop** cancels.
* Options: match case, whole word, regular expression (Rust regex syntax), files to include /
  exclude (comma-separated globs), and *use .gitignore and files.exclude* (on by default).
* Skipped: binary files, files over 10 MB, the `.git` folder, symbolic links (never followed).
* At most 20 000 matches are collected; the view says when the limit was reached.
* Searching reads files **on disk**: unsaved editor changes are not searched.
* Results are grouped by file; click a match to preview it, double-click or Enter to open it.
  Matches and files can be dismissed from the list. Search terms are remembered (Alt+↑/↓,
  stored as UI state) and the editor selection seeds the search box.

### Replace

* **Replace all** (or *Replace in This File* from a file's context menu) always asks first and
  states how many occurrences in how many files will change.
* Files with **unsaved changes** in the editor are skipped (save them first).
* The backend re-reads every file, keeps its encoding and line endings, and writes atomically with
  a content-hash check, so a file that changed in between is reported and left alone.
* Regex replacements support `$1` / `${name}` groups; literal mode replaces text literally.
* There is no multi-file undo; use Source Control or a backup to revert.

## Quick Open (Ctrl+P / Ctrl+E) and the Command Palette (Ctrl+Shift+P / F1)

One picker with modes chosen by the first character:

| Input | Mode |
|---|---|
| `name` | files in the workspace (fuzzy; file-name and word-start matches rank first) |
| `name:42[:7]` | open the file at line 42 (column 7) |
| `>` | commands (recently used first), with their shortcuts |
| `@` (Ctrl+Shift+O) | symbols in the active editor (needs a running language server) |
| `#` (Ctrl+T) | symbols in the workspace (language server) |
| `:` (Ctrl+G) | go to line[:column] |
| `?` | list of modes |

The file list is indexed by the backend per window (respecting `.gitignore` and `files.exclude`,
up to 300 000 files), rebuilt after file changes and on workspace switch; scoring happens in the
backend so large workspaces never send their whole file list to the UI.

## Keyboard Shortcuts editor

*Preferences: Open Keyboard Shortcuts* shows every command with its shortcuts, `when` clause and
source. Search by text or **Record keys** to find what a chord does; *Change* / *Add* records a new
chord (Enter confirms, Esc cancels), *Remove* disables a default or deletes a user binding, *Reset*
restores a command's defaults. Assigning a chord that is already used asks first; conflicts (same
chord and `when`) are highlighted. User shortcuts are stored in the UI state database
(`ui.keybindings`) as a list of `{ key, command, when? }`; a removal of a default is stored as
`{ key, command: "-<id>" }`.
