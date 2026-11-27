# Notes, bookmarks and previews

## Workspace notes

The **Notes** side-bar view keeps one Markdown document per workspace. It is saved automatically
(and before switching or closing a workspace) to the application data folder
(`%LOCALAPPDATA%\IvilyCenter\notes\<workspace id>.md`), never into the project, so notes are not
committed by accident. Up to 1 MB. *Preview* renders it like the Markdown preview.

## Bookmarks

* *Toggle Bookmark* (Ctrl+Alt+K) marks the cursor line of a workspace file; a ◆ appears in the
  gutter. Bookmarks move with the text when lines are inserted or removed above them.
* *Go to Next / Previous Bookmark* (Ctrl+Alt+L / Ctrl+Alt+J) cycles through all bookmarks of the
  workspace; *List Bookmarks* shows them with the line text; *Remove All Bookmarks* asks first.
* Bookmarks are saved with the workspace session (restored on reopen). Files outside the workspace
  and untitled documents cannot be bookmarked.

## Previews (Ctrl+Shift+V)

* **Markdown**: GitHub-flavoured Markdown rendered live from the editor (unsaved changes included).
  The HTML is sanitized with DOMPurify: scripts, event handlers, `javascript:` links, forms,
  frames, embedded objects and inline styles are removed. `http(s)` links open in the default
  browser (validated by the backend); links to other workspace files open them in the editor
  (`file.md#L12` jumps to line 12); `file:`, UNC and other schemes are ignored. Images load only
  from `data:` URLs (the content security policy blocks remote and local file images).
* **HTML**: shown in a sandboxed frame with **no permissions** (no scripts, forms, popups,
  same-origin access or top navigation); the app's content security policy also blocks external
  resources. It is a static view, not a browser.
