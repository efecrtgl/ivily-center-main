# Development Status

Last updated: 2026-11-27

No completion percentages are given on purpose; a phase is either **done** (built, tested,
committed, pushed and verified on GitHub), **in progress**, or **planned**.

## Current phase

**Phase 2 — Core & custom window:** done. **Next: Phase 3 — Workspace system and launcher** (not started).

## Phases

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Audit, architecture, planning | done | [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 1 | Repository infrastructure | done | Scaffold, community files, CI. Release workflow deferred to Phase 25 (needs updater signing). |
| 2 | Core & custom window | done | Three commits: `ffc8066` backend foundation, `58b9731` UI core, then window & shell (see git log). |
| 3 | Workspace system & launcher | planned | Includes Workspace Trust (roadmap change, plan §3). |
| 4–25 | See plan | planned | |

## Phase 2 deliverables

| Area | Delivered | Not included (belongs to a later phase) |
|---|---|---|
| Database | SQLite, transactional migrations, pre-migration backup, corrupt/newer-schema handling, ownership rules ([DATABASE.md](docs/DATABASE.md)) | Backup/restore UI, export/import (Phase 20) |
| Settings | Rust-validated typed registry, default < user < workspace resolution (workspace storage and resolution tested; no workspaces exist yet), key-rename migration, searchable Settings view with reset | Settings import/export, keybinding editor (Phases 10, 13) |
| Themes | Token schema, 4 style layers, 6 themes, 2 icon packs, bundled fonts ([THEMES.md](docs/THEMES.md)) | File-type/folder icons (Phase 4), CodeMirror/xterm theme adapters (Phases 5, 8), custom theme files (Phase 16) |
| Commands | Registry, `when` clauses, keybindings with overrides/removals/conflicts, 22 commands (16 workbench + 6 theme commands) ([COMMANDS.md](docs/COMMANDS.md)) | Command Palette UI, keybinding editor (Phase 10) |
| Output | Redacted bounded channels, Output panel | Export, per-subsystem channels (added with each subsystem) |
| Notifications | Store, toasts, notification centre, level / do-not-disturb / timeout settings | Per-category notification rules |
| Window | Frameless window, custom title bar and controls, drag region, bounds persistence with monitor/work-area clamping, context-aware title, workbench layout with persisted resizable regions | Multi-window (Phase 22) |

## Architectural decisions

See [ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-key-technology-decisions-adr-summary). Phase 2 additions:

* Settings schema lives in Rust only; the UI receives it over IPC (single source of truth).
* Themes = tokens + style layer + icon pack; features use tokens and semantic class names only.
* Keybindings use physical key codes (layout-independent).
* UI-writable state is namespaced (`ui.*`); output channels have a UI-writable allow-list.

## Known issues / limitations

* Windows 11 Snap Layouts flyout is not shown when hovering the custom maximize button.
* The Explorer view is an honest empty state; folders cannot be opened until Phases 3–4.
* `appearance.reduceMotion = system` is read at startup and when the setting changes; a change of the
  Windows animation setting while the app runs is not picked up live.
* Ivily Envora's IEP envelope differs from IEP 0.1 (adapter planned for Phase 17).
* `gh` CLI is not installed on the development machine; pushes are verified with `git ls-remote`.

## Build / test status (local, 2026-11-27)

| Check | Result |
|---|---|
| `npm test` (Vitest) | 10 files, 65 tests passed |
| `npm run build` | ok |
| `cargo fmt --check` | ok |
| `cargo clippy --all-targets --locked -- -D warnings` | ok |
| `cargo test --locked` | 32 passed |
| `npm run tauri dev` smoke run | App started without errors; database created at schema v1; native title set; window bounds persisted on close. Visual inspection of the rendered UI was **not** performed. |

CI results: see GitHub Actions.

## Release status

Unreleased (version 0.0.1).

## Repository synchronisation

`origin` = https://github.com/efecrtgl/ivily-center-main, branch `main`, verified with `git ls-remote` after each push.
