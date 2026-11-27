# Commands, keybindings, views, output and notifications

Implementation: `src/core/`.

## Commands (`core/commands.js`)

Every user action is a registered command:

```js
registerCommand({ id: 'workbench.togglePanel', title: 'Toggle Panel', category: 'View',
                  icon: 'panel', when: '...', run: (args) => { ... } }, 'workbench');
```

* Ids are namespaced (`area.action`). Duplicate ids are rejected.
* `executeCommand(id, args)` never throws: it resolves to `{ ok, value | reason }`
  (`unknown`, `unavailable`, `error`). Failures are routed to a single handler that logs to the
  *Interface* output channel and shows an error notification.
* Recently executed commands are tracked (for the Command Palette, Phase 10).
* The title bar buttons, activity bar, shortcuts and theme picker all dispatch commands.

## `when` clauses (`core/context.js`)

Commands and keybindings may be conditional on context keys:
`!`, `&&`, `||`, `==`, `!=`, parentheses, quoted or bare literals. Unknown keys are falsy; a malformed
clause evaluates to false and is logged. Current keys: `sidebarVisible`, `panelVisible`,
`activeSidebarView`, `activePanel`, `notificationCenterOpen`, `workspaceOpen`, `workspaceKind`,
`workspaceFavorite`, `workspaceTrusted`, `workspaceTrustLevel` and `workspaceTrust.<capability>`.

## Keybindings (`core/keybindings.js`)

* Chords are normalized (`ctrl+shift+p` → `Ctrl+Shift+P`). Keys are matched by **physical position**
  (`KeyboardEvent.code`), so shortcuts work identically on Turkish, German, etc. layouts.
* Default bindings come from features; user bindings (editor UI in Phase 10) override them; a user
  entry `{ key, command: '-id' }` removes a default.
* Plain keys (no Ctrl/Alt/Meta) are never captured inside text inputs.
* `findConflicts()` reports bindings with the same chord and identical `when` clause.
* The plus key is written `=` (main row) or `NumpadAdd`, because `+` separates chord parts.

| Shortcut | Command |
|---|---|
| Ctrl+B | View: Toggle Side Bar |
| Ctrl+J | View: Toggle Panel |
| Ctrl+Shift+E | View: Show Explorer |
| Ctrl+Shift+U | View: Show Output |
| Ctrl+, | Preferences: Open Settings |
| Ctrl+= / Ctrl+NumpadAdd | View: Increase Interface Size |
| Ctrl+- / Ctrl+NumpadSubtract | View: Decrease Interface Size |
| Ctrl+0 | View: Reset Interface Size |
| Ctrl+Alt+O | Workspace: Open Folder… |
| Ctrl+R | Workspace: Show Launcher / Recent Workspaces |

Browser shortcuts that make no sense in an IDE (F5/Ctrl+R reload, Ctrl+P print, Ctrl+F page find,
Ctrl+S save page, Ctrl+U view source) are suppressed. In release builds the browser context menu is
shown only in text fields.

## Views (`core/views.js`)

Features register views for the `sidebar` (with an activity-bar entry) or the `panel` (a tab). The
shell renders whatever is registered. Layout (visibility, sizes, active views) is persisted under
`ui.layout` and sanitized on load.

## Output channels

Backend channels: `app`, `window`, `settings`, `database`; UI channel: `ui` (the only one the webview
may write to). Lines are redacted for secrets **in Rust before storage**, bounded per channel by the
`output.maxLinesPerChannel` setting, and streamed to the Output panel (filter, minimum level, follow,
copy, clear).

## Notifications

`notify({ severity, title, message, source, actions, sticky })`. All notifications are kept in the
notification centre (status bar bell, max 200). Whether one also pops up depends on the
`notifications.level` and `notifications.doNotDisturb` settings (errors always pop up). Errors are
sticky; others hide after `notifications.timeoutSeconds`. Unread duplicates are collapsed with a counter.
Actions run commands.
