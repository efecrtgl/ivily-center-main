# Editor

Implementation: `src/features/editor/` (CodeMirror 6), `src-tauri/src/editor_io/` (file I/O, drafts).

## Documents

* **Opening:** from the explorer (click = preview tab, double-click/Enter = regular tab), **Open
  File…** (Ctrl+O, native dialog — files outside the workspace are addressed by an opaque token),
  **New Text File** (Ctrl+N).
* **Encodings:** UTF-8, UTF-8 with BOM, UTF-16 LE/BE (BOM), and Windows-1252 as a lossless fallback
  for non-UTF-8 text. The encoding is kept on save; *Change File Encoding* switches it.
* **Line endings:** detected (LF/CRLF; mixed files are marked with `*` and normalized on save);
  *Change End of Line Sequence* converts. New files use `files.eol`.
* **Refused:** binary files (NUL bytes) and files over 64 MB. Files above
  `editor.largeFileThresholdMB` open in large-file mode (no highlighting, folding or completion).
* **Read-only** files cannot be saved in place (Save As works).

## Saving

* Ctrl+S save, Ctrl+Shift+S save as, Ctrl+Alt+S save all. Untitled documents use Save As.
* Every save sends the hash of the version the editor loaded. If the file changed on disk, nothing
  is written; the user chooses **Overwrite**, **Discard Mine and Reload**, or **Cancel**.
* Save As never replaces an existing file without a confirmation.
* Writes are atomic (temporary file + rename).
* **Auto save** (`editor.autoSave`): after a delay or when the editor loses focus. Untitled,
  read-only and conflicting documents are never auto-saved.

## External changes

The workspace file watcher notifies the editor. Clean documents reload silently; documents with
unsaved changes are flagged (banner + notification) and are never overwritten without a choice.
Deleted files are flagged as well.

## Recovery (hot exit)

Unsaved content is written to recovery drafts 1.5 s after the last change and before every
workspace switch or window close (`%LOCALAPPDATA%\IvilyCenter\drafts\<workspace>\`). On the next
start, documents are restored with their unsaved changes — including untitled ones and drafts from
a crash that happened before the session was saved. If the file changed on disk meanwhile, the
document is flagged. Drafts are deleted when a document is saved or its changes are discarded.

## Tabs and groups

* Tabs show dirty (●), preview (italic) and pinned state; middle-click closes; drag to reorder;
  context menu: close, close others/right/saved/all, pin, split, copy path, revert, reload.
* Closing the last tab of a dirty document asks **Save / Don't Save / Cancel**.
* Up to four editor groups, side by side or stacked (Ctrl+\ split right). Each group has its own
  cursor, selection and undo history; edits are mirrored between views of the same document.
* Ctrl+Tab / Ctrl+PageDown and Ctrl+Shift+Tab / Ctrl+PageUp cycle tabs; Ctrl+1/2/3 focus groups;
  Ctrl+W close; Ctrl+Shift+T reopens the last closed editor.
* Open editors, cursors and layout are part of the workspace session.

## Editing (CodeMirror 6)

Line numbers, folding, bracket matching and auto-closing, auto-indentation, multiple cursors
(Alt+click, Ctrl+D via the search keymap), rectangular selection (Alt+drag), find & replace (Ctrl+F,
regex/case/word), selection-match highlighting, active line, word completion, undo/redo, configurable
font, size, line height, tab size, spaces vs. tabs, word wrap (Alt+Z) and whitespace rendering.
Language-aware completion, diagnostics and navigation come with language servers (Phase 7).
Syntax highlighting is lazy-loaded per language (see Language support).

A minimap is intentionally not included: an efficient implementation would require a second
rendering pipeline; it may be added later as an extension.

The editor's colours come from the active theme's `editor.*` and `syntax.*` tokens.
