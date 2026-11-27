# Ivily Center — Architecture

Status: **design baseline (Phase 0), foundation implemented in Phase 2**. Sections describe the intended design; each subsystem's
implementation status is tracked in [../DEVELOPMENT_STATUS.md](../DEVELOPMENT_STATUS.md). When the
implementation diverges, this document is updated in the same commit.

## 1. Process model

```
┌────────────────────────── Ivily Center process ──────────────────────────┐
│  WebView2 (React, plain JS)                 Rust core (Tauri 2)          │
│  ─ UI only, no fs/shell/http plugins  ◄IPC► ─ commands/: validate+route │
│  ─ calls `platform/ipc.js` only             ─ subsystems (below)        │
│                                             ─ SQLite (app data)         │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ user-started only             │ on-demand, short-lived
      ┌─────────▼─────────┐            ┌────────▼──────────────┐
      │ shells (ConPTY),  │            │ Ivily modules         │
      │ language servers, │            │ `exe --iep describe`  │
      │ tasks, git        │            │ (read-only IEP)       │
      └───────────────────┘            └───────────────────────┘
```

* The webview is treated as **less trusted** than Rust: it renders and asks; Rust validates and acts.
* Streams with high volume (terminal output, search results, LSP traffic) use Tauri
  `ipc::Channel`s rather than global events, scoped to the requesting window.
* Child processes are started only by explicit user action or by a user-approved task, are tracked
  in a registry, and are terminated (with their process tree, via Windows Job Objects) on close.

## 2. Repository layout

```
src/                       React UI (plain JS + JSDoc, no TypeScript)
  app/                     bootstrap, providers, startup
  platform/                the ONLY place that calls @tauri-apps/api (ipc, window, events)
  core/                    command registry, keybindings, stores, output/notification clients
  shell/                   window frame, title bar, layout (activity bar, side bar, panel, status bar)
  features/<name>/         explorer, editor, terminal, git, search, tasks, problems, ...
  theme/                   token schema, theme definitions, theme engine
  icons/                   icon-pack registry and packs
src-tauri/src/
  main.rs, lib.rs          entry; builder, plugins, state, command registration
  error.rs                 AppError (serializable, no secrets/paths beyond what the user owns)
  state.rs                 AppState: handles to subsystems
  commands/<name>.rs       thin IPC layer: deserialize → validate → delegate → map errors
  core/                    paths, limits, cancellation tokens, process registry
  db/                      connection, versioned migrations, integrity check
  settings/                schema, defaults, scopes (default < user < workspace), validation
  window/                  window-state persistence, monitor/DPI clamping
  workspace/ fs/ editor_io/ lang/ lsp/ pty/ git/ search/ tasks/ iep/ modules/ update/ backup/
```

Subsystem modules **do not depend on Tauri** except through narrow traits (event sink, path
resolver) so they are unit-testable without a window. The single crate will be split into a Cargo
workspace (`src-tauri/crates/*`) when a subsystem's API stabilises (expected first for `lsp`,
`pty` and `iep`) — recorded as an ADR when it happens.

## 3. Subsystems and responsibilities

| Subsystem | Responsibility | Owner side |
|---|---|---|
| Application core | Startup, state, lifecycle, single instance, crash-safe shutdown | Rust + `app/` |
| Window manager | Frameless window, title bar, drag regions, state save/restore, DPI/multi-monitor clamping; later multi-window | Rust `window/` + `shell/` |
| Command registry | Every user action is a command `{id, title, category, when, run}`; menus, palette, shortcuts all dispatch commands | `core/commands` |
| Keybindings | Default + user bindings, context (`when`) evaluation, conflict detection | `core/keybindings` |
| Settings | Typed schema with defaults, validation and migration; scopes default < user < workspace | Rust `settings/` + UI |
| Theme engine | Theme = token set + component style layer + icon pack + font set; switch at runtime via CSS custom properties without touching app state | `theme/` |
| Icon system | Icon packs map file names / extensions / languages / folder names → icon ids; resolution in one module only | `icons/` |
| Database layer | SQLite in app data dir, `PRAGMA user_version` migrations, WAL, integrity check | Rust `db/` |
| Workspace manager | Workspace records, recents/favourites, profiles, trust, portable workspace file, session | Rust `workspace/` |
| File explorer / fs | Workspace-scoped path validation, lazy listing, ignore rules, watcher, safe mutations | Rust `fs/` + `features/explorer` |
| Editor engine | CodeMirror 6 documents/views, groups, tabs, session restore, large-file mode | `features/editor` + Rust `editor_io/` |
| Language support | Provider registry: id, detection, syntax loader, tier, indentation, comments, folding | `features/languages` |
| LSP manager | Server registry, discovery, process lifecycle, JSON-RPC framing, logs, health | Rust `lsp/` + client glue |
| Terminal manager | PTY sessions (ConPTY), profiles, resize, lifecycle | Rust `pty/` + xterm.js |
| Git manager | Git CLI with fixed argv, porcelain v2 parsing, guarded destructive ops | Rust `git/` |
| Search engine | ripgrep libraries (`ignore`, `grep-*`), streaming, cancellation, replace preview | Rust `search/` |
| Task engine | Task definitions, approval, process management, history | Rust `tasks/` |
| Debugging | DAP client, breakpoints model, provider interface | Rust `debug/` (later) |
| Problems / Output | Diagnostic aggregation; named output channels with redaction | Rust + UI |
| Notifications | Toasts + notification centre with per-category settings | `core/notifications` |
| Extension manager | Manifests, permissions, enable/disable; declarative contributions first | Rust `extensions/` |
| Module manager / IEP | Discovery, describe/request with timeouts, compatibility, dashboard | Rust `iep/`, `modules/` |
| Update manager | Signed app updates; module update metadata | Rust `update/` |
| Backup | App-data backup/restore/verify/retention | Rust `backup/` |
| Resource monitor | Own process + child process stats, sampled only while visible | Rust `monitor/` |

## 4. Security architecture

### 4.1 IPC
* Capabilities grant only core window permissions and dialog/updater/process plugins. **No**
  `fs`, `shell`, `http` or `opener`-with-arbitrary-URL permissions.
* Every command validates its input (types via serde with `deny_unknown_fields`, sizes, path
  scope, ids) before doing work. Errors are typed (`AppError`) and never include secrets.
* CSP: `default-src 'self'`, no remote scripts, no `unsafe-eval`; `freezePrototype: true`.

### 4.2 Filesystem scope
* Rust keeps the set of **roots the user opened** (workspace folders, files opened via dialog).
  File commands accept only paths that canonicalise inside an allowed root. Symlinks/junctions
  that escape a root are not followed for mutations.
* Deletes go to the Recycle Bin by default; permanent delete requires explicit confirmation.

### 4.3 Workspace Trust
Implemented in Phase 3 — see [WORKSPACES.md](WORKSPACES.md#workspace-trust) (per folder and per
capability, folder or folder-and-children scope, session or remembered, revocable). A workspace is
**restricted** until the user trusts it (stored in the app DB, never in the workspace). In restricted mode:

| Allowed | Blocked |
|---|---|
| Browse, edit, search, Git read operations, syntax highlighting | Running tasks; workspace-defined terminal profiles/env; language servers whose command comes from workspace config; workspace extension recommendations auto-enabling anything; HTML preview scripts |

Even in trusted workspaces, nothing runs on open: tasks and terminals are started by the user;
a task's first run shows the exact command line for approval.

### 4.4 Processes
Child processes are spawned with explicit argv (never through `cmd /c` string concatenation),
explicit working directory and an environment built from an allow-list plus user-configured values.
All are registered, assigned to a Job Object, and killed when their owner closes.

### 4.5 Previews
HTML preview renders in an isolated, sandboxed context with no IPC access and scripts disabled by
default; Markdown is sanitized.

### 4.6 Logs
Output channels pass through a redactor (tokens, `Authorization` headers, env vars whose names look
like secrets). Environment dumps are never logged.

## 5. Persistence and data ownership

App data: `%LOCALAPPDATA%\IvilyCenter\` — `center.db` (SQLite), `logs\`, `backups\`.

| Data | Owner | Location |
|---|---|---|
| User settings, keybindings, theme choice | Application | DB (`settings`) |
| Workspace records, trust, recents, favourites, profiles | Application | DB |
| Workspace-scoped settings | Workspace | DB by default; optional portable `*.ivily-workspace` file the user saves explicitly |
| Session (open tabs, layout, cursors) | Session | DB |
| Notes, bookmarks | Workspace | DB (never written into source files) |
| Extension settings | Extension | DB, namespaced by extension id |
| Module integration prefs | Module | DB |

Migrations are forward-only, run in a transaction, and a backup of `center.db` is taken before any
migration that changes existing tables. A database created by a newer Center is opened read-only
with a clear error instead of being downgraded.

## 6. Frontend architecture

* React 19 function components; state in small external stores (`useSyncExternalStore`) per
  feature — no global Redux. Stores never hold CodeMirror objects in React state.
* **Editor:** one `EditorView` per visible editor group; each open document keeps an
  `EditorState` that is swapped into the view on tab switch (preserves undo history, selection,
  scroll). Language and heavy extensions use `Compartment`s so they can be reconfigured lazily.
* **Lists** (explorer, search results, problems, git changes) are virtualised.
* **Themes:** tokens are CSS custom properties on `:root[data-theme]`; components use tokens only.
  Pixel themes additionally swap the component style layer (borders, fonts, icon pack, motion),
  which is why themes are more than colour maps. CodeMirror and xterm.js themes are derived from
  the same tokens.

## 7. Implemented so far (Phases 2–3)

| Subsystem | Implementation | Docs |
|---|---|---|
| Database, app state | `src-tauri/src/db/`, `app_state.rs` | [DATABASE.md](DATABASE.md) |
| Settings | `src-tauri/src/settings/`, `src/core/settings.js` | [DATABASE.md](DATABASE.md#settings-resolution) |
| Output | `src-tauri/src/output/`, `src/core/output.js` | [COMMANDS.md](COMMANDS.md#output-channels) |
| Window manager | `src-tauri/src/window/`, `src/shell/TitleBar.jsx`, `src/platform/window.js` | below |
| Theme engine, icons | `src/theme/`, `src/icons/` | [THEMES.md](THEMES.md) |
| Commands, keybindings, views, notifications | `src/core/` | [COMMANDS.md](COMMANDS.md) |
| Workspaces, launcher, Workspace Trust, sessions (Phase 3) | `src-tauri/src/workspace/`, `src/workspace/`, `src/features/launcher/`, `src/features/trust/` | [WORKSPACES.md](WORKSPACES.md) |

**Window manager.** The window is frameless (`decorations: false`) with the native shadow and native
edge resizing. It starts hidden; Rust validates saved bounds against the monitors' *work areas*
(`window::fit_bounds`: the title bar must be reachable, size is clamped, position pulled inside) and only
then shows it. Bounds are tracked in physical pixels of the virtual screen, so mixed-DPI setups work.
The title bar is a `data-tauri-drag-region="deep"`; buttons are excluded from dragging by Tauri, and a
double-click toggles maximize. The title is context-aware (`core/title.js`) and mirrored to the native
window title for the taskbar. Known limitation: Windows 11 Snap Layouts flyout does not appear when
hovering the custom maximize button (Win+Z and edge snapping work).

## 8. Key technology decisions (ADR summary)

| # | Decision | Alternatives considered |
|---|---|---|
| 1 | Tauri 2 + React 19 + plain JS + Vite, JSDoc for types | TypeScript (excluded by requirement) |
| 2 | Single Rust crate first; split into workspace crates per stable subsystem | Workspace from day one (overhead before APIs settle) |
| 3 | SQLite via `rusqlite` (bundled), `user_version` migrations | sled/JSON files (no transactions/integrity check) |
| 4 | CodeMirror 6 + Lezer / `@codemirror/legacy-modes` for syntax; Tree-sitter only where a concrete feature needs it (e.g. symbol outline without LSP) | Tree-sitter everywhere (heavy WASM/native per language) |
| 5 | Terminal: `portable-pty` (ConPTY) + `@xterm/xterm` | Custom ConPTY bindings (more risk, same result) |
| 6 | Git: system `git` CLI with porcelain v2 `-z`; respects user config & credential helpers | `git2`/`gix` (credential/hook/config parity issues for write ops) |
| 7 | Search: `ignore` + `grep-searcher`/`grep-regex` (ripgrep internals) | Spawning `rg` (extra binary dependency) |
| 8 | LSP: Rust owns processes & framing; JS client glue (evaluate `@codemirror/lsp-client` in Phase 7) | Rust-only client (UI features need editor-side integration anyway) |
| 9 | IEP client: CLI transport per IEP 0.1 + Envora adapter; named pipes only once providers ship them | Inventing a new transport ahead of providers |
| 10 | Updates: `tauri-plugin-updater` with the ecosystem's shared minisign key | Custom updater |
