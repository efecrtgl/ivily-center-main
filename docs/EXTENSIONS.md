# Extensions

Implementation: `src-tauri/src/extensions/` + `commands/extensions.rs`, `src/features/extensions/`.

## Model

Extensions are **declarative**: a folder with `ivily-extension.json` and JSON files it references.
They cannot run code, read files, use the network or start processes. Supported contributions:

| Contribution | Effect |
|---|---|
| `themes` | Theme JSON files (same format and validation as user themes, see THEMES.md). |
| `iconPacks` | Icon pack JSON files (validated SVG paths / bitmaps). A theme of the same extension can use its pack by its own id. |
| `snippets` | `{ "language": "<language id>", "path": "snippets/x.json" }` — VS Code snippet format (`prefix`, `body`, `description`; tab stops, placeholders and choices; variables are replaced by their defaults). Offered in completion for that language. |
| `keybindings` | `{ "key", "command", "when"? }` for **existing** commands only; removals (`-command`) are not allowed. Unknown commands are reported and skipped. User shortcuts still take precedence. |
| `languages` | `{ "id": "<existing language>", "extensions": [".ext"] }` adds file associations. |

```json
{
  "id": "acme.sea",
  "name": "Sea",
  "version": "1.0.0",
  "publisher": "Acme",
  "description": "Calm colours",
  "contributes": {
    "themes": ["themes/sea.json"],
    "snippets": [{ "language": "rust", "path": "snippets/rust.json" }],
    "keybindings": [{ "key": "Ctrl+Alt+R", "command": "tasks.run" }]
  }
}
```

Ids are `publisher.name` (lower case). Contributed theme and icon-pack ids are namespaced as
`user-<publisher>-<name>-<id>`.

## Installing

*Install from Folder…* (Extensions view, Ctrl+Shift+X): the backend validates the manifest and
every referenced file (relative `.json` paths inside the folder only, symlinks resolved and checked,
≤ 1 MB each, ≤ 10 MB / 200 files in total, valid JSON). The dialog lists exactly what the
extension contributes and which files are copied; nothing is installed before confirmation. The
folder is read again at confirmation, and only the manifest and referenced JSON files are copied to
`%LOCALAPPDATA%\IvilyCenter\extensions\<id>` (staged, then swapped in, so an update never leaves a
half-written extension). Other files in the folder are ignored.

Extensions can be disabled (contributions are removed immediately) or removed (the installed copy
is deleted; the source folder is never touched). Problems with individual contributions are shown
on the extension and logged; they do not stop other contributions.

## Workspace recommendations

`.ivily/extensions.json` with `{ "recommendations": ["publisher.name"] }` lists extensions in the
Extensions view as *recommended by this workspace*. Nothing is installed or enabled automatically
(there is no marketplace); the trust capability *Extensions* therefore has nothing to gate yet.
