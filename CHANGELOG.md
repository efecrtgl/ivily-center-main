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
