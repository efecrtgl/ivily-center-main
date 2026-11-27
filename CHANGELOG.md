# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Phase 0: repository audit, architecture and roadmap (`docs/`).
- Phase 1: repository infrastructure — Tauri 2 + React (plain JS) + Vite scaffold, minimal
  capabilities with strict CSP, Vitest and cargo test suites, CI (tests, fmt, clippy, dependency
  audit), Dependabot, issue/PR templates and community files.
- Phase 2: application core.
  - SQLite database with transactional, forward-only migrations, pre-migration backups and safe
    recovery (corrupt files kept aside, newer schemas never touched).
  - Typed settings registry validated in Rust with default < user < workspace resolution.
  - Output channels with secret redaction; Output panel with filter, level, follow, copy and clear.
  - Theme engine with token schema, four style layers and six themes (Modern Dark/Light,
    Pixel Dark/Light, Retro Terminal, Glass); modern and pixel icon packs.
  - Command registry, `when` clauses and layout-independent keybindings.
  - Notification centre and pop-ups with level and do-not-disturb preferences.
  - Frameless window with custom title bar, persisted bounds clamped to connected monitors,
    workbench layout (activity bar, side bar, panel, status bar) with resizable, persisted regions,
    searchable Settings view and theme picker.
- Phase 3: workspaces.
  - Folder and `*.ivily-workspace` workspaces with validated, canonical paths, duplicate detection,
    availability checks, relocation, favorites, groups and display names.
  - Optional launcher with recents, favorites, filter, project discovery and startup choice.
  - Workspace-level settings (database for folders, file for workspace files) with User/Workspace tabs.
  - Explicit, atomic, conflict-checked workspace file writing; never overwrites without confirmation.
  - Workspace Trust: per-folder, per-capability, folder or parent scope, session or remembered,
    remembered denial, revocation, trust manager, Restricted Mode banner, backend enforcement gate.
  - Per-workspace sessions with participants, previous-version fallback, crash detection and safe mode.

- Phase 4: file explorer — workspace-scoped, traversal-safe file operations (no overwrites,
  Recycle Bin deletion), lazy virtualized tree with .gitignore/exclusions, watcher, keyboard and
  multi-select, drag and drop, file-type icons for ~90 types.
- Phase 5: editor — CodeMirror 6 with groups/splits, tabs, encodings and line endings, hash-checked
  saving and conflict resolution, auto save, external change handling and hot-exit recovery drafts.

- Phase 6: language provider registry with honest support tiers (structure / syntax / basic) for
  the required languages and ~90 more; toolchain discovery for ~35 tools (safe probing, install
  guidance only).
- Phase 7: language servers (23 known servers) with trust gating, Job Object isolation,
  completion, hover, signature help, diagnostics, navigation, references, rename and formatting.
- Phase 8: ConPTY integrated terminal with profile detection (PowerShell, CMD, Git Bash, WSL),
  tabs, splits, search, clipboard, links and theme-aware colours.
- Phase 9: Git — status, staging, commits/amend, branches, history, diffs, stashes, tags, remotes,
  merge/rebase/cherry-pick/revert/reset, conflict resolution in the editor, clone and init; never
  forced, destructive actions confirmed, gated by workspace trust.
- Phase 10: search in files (streaming, regex/case/word, include/exclude, .gitignore, history)
  with confirmed, hash-checked replace; Quick Open with backend fuzzy file index and `>` `@` `#`
  `:` modes; Command Palette; Keyboard Shortcuts editor with recording, conflicts and reset.
- Phase 11: tasks from `.ivily/tasks.json`, `.vscode/tasks.json`, npm scripts and Cargo; trust-gated
  with approval of the exact command on first run; dependencies (sequence/parallel), terminate,
  rerun, history and problem matchers (rustc, tsc, gcc, eslint, msCompile).
- Phase 12: Problems panel (language-server diagnostics and task problems, filters, F8 navigation,
  status-bar counts, running-task indicator) and *Save Output As…* with confirmed overwrite.

### Fixed
- The main window no longer grows by its border width on every launch (inner size is persisted).
