# Ivily Center — Development Plan

This document records the Phase 0 audit, the guiding principles and the phased roadmap.
The architecture itself is described in [ARCHITECTURE.md](ARCHITECTURE.md); live progress is
tracked in [../DEVELOPMENT_STATUS.md](../DEVELOPMENT_STATUS.md).

## 1. Repository audit (2026-11-27)

| Item | Finding |
|---|---|
| Local working copy | Empty except `.claude/` (local tool settings — must not be committed). Not a git repository. |
| GitHub `efecrtgl/ivily-center-main` | Exists, public, **no commits and no branches** (`git ls-remote` returns nothing). |
| Existing code / unfinished work | None. Nothing to preserve or migrate. |
| Security issues / technical debt | None in this repository (nothing exists yet). |
| Toolchain on the dev machine | Rust 1.100, Cargo 1.100, Node 24.15, npm 11.12, pnpm 12, Git 2.54. `gh` CLI **not installed** (GitHub verification is done with `git ls-remote`). |
| Sibling apps | `ivily-optimizer` (Svelte), `ivily-envora`, `ivily-portly`, `ivily-structura` (React). All: Tauri 2, plain JS, Vite 8, Vitest, rusqlite 0.43 (bundled), MIT licence, per-user NSIS installer, `tauri-plugin-updater` with **one shared minisign public key**, CI on `windows-latest`, draft-release workflow with SHA-256 sums. |
| Dev-server ports in use | 1420 (Optimizer), 1430 (Envora), 1440 (Portly), 1450 (Structura). Center uses **1460**. |

### 1.1 IEP as actually implemented by the siblings

The prompt asks Center to *create* the Ivily Ecosystem Protocol. In reality, four providers already
exist, so Center's job is to be a **compatible client** and to steward the spec going forward.

| App | Transport | Envelope | Notes |
|---|---|---|---|
| Optimizer | `exe --iep describe` / `exe --iep request` (stdin, ≤ 64 KB) | IEP 0.1: `{protocol:"iep", version:"0.1.0", id, method, params}` → `{…, ok, result \| error}` | Methods `describe`, `health`, `capabilities`. Named pipe designed, not built. |
| Portly | same as Optimizer | IEP 0.1 | + `ports.summary`, `projects.summary`. |
| Structura | same as Optimizer | IEP 0.1 | + `projects.list`, `analysis.summary` (param `root`). |
| **Envora** | `exe --iep` (single request on stdin) | **Different**: `{iep:1, id, method:"iep.hello" \| "envora.*"}` | Method names are namespaced; capability grants (`granted`) concept. |

**Decision:** Center's IEP client implements IEP 0.1 as the canonical dialect and a small,
isolated adapter for Envora's legacy envelope. Aligning Envora to IEP 0.1 is recommended and
belongs in the Envora repository (tracked as an open issue, not done from here).

All providers share these properties, which Center must respect: local only, read-only methods,
no background service, the process is short-lived and started on demand, unknown request fields
are rejected, unknown response fields must be ignored, and `0.x` requires an exact minor match.

## 2. Guiding principles

1. **IDE first, ecosystem second.** Every IDE feature works with zero Ivily modules installed.
   The ecosystem dashboard is one view, never the home of the app.
2. **Untrusted by default.** Workspace files, extensions and modules are untrusted input. Nothing
   in a workspace is executed (tasks, terminal profiles, language-server paths, env files) until
   the user trusts that workspace — see *Workspace Trust* in ARCHITECTURE.md.
3. **Privileged work happens only in Rust.** The webview gets no `fs`, `shell` or `http` plugin.
   Every native operation is a typed, validated Tauri command scoped to what the user opened.
4. **Never destroy silently.** No force-push code path exists. Deletes go to the Recycle Bin
   (or require confirmation). Overwrites, resets, amends and bulk replaces always preview/confirm.
5. **Consent for installs and network.** No automatic toolchain/LSP installs, no silent downloads,
   no telemetry. The only automatic network call is the optional update check.
6. **Honest capabilities.** Language support has declared tiers (syntax / structure / LSP).
   Docs and UI never claim an unimplemented feature.
7. **Lazy and cheap at idle.** No permanent child processes the user did not start, no polling
   where file-watch events suffice, lazily loaded panels and language packs.
8. **Small verifiable steps.** Each milestone builds, passes tests, is committed and pushed.

## 3. Roadmap

The suggested 26-phase roadmap from the master prompt is kept, with these documented changes:

| Change | Reason |
|---|---|
| **Database, settings store and theme tokens move into Phase 2** (foundation), not 13/20. | Themes must be core "from the beginning", and every later subsystem persists state. Phases 13 and 20 then extend rather than introduce them. |
| **Workspace Trust is part of Phase 3.** | Tasks, terminal profiles and LSP configs read from the workspace must be gated before they exist. |
| **Output channel + notification primitives land in Phase 2**; the full panels stay in Phase 12. | Every subsystem needs to log and notify from day one. |
| **Command registry lands in Phase 2**; the palette UI stays in Phase 10. | All actions (title bar, menus, shortcuts) should be commands from the start, so the palette and keybindings are not retrofitted. |
| Large phases are split into milestones (e.g. 5a tabs/groups, 5b split views, 5c session restore). | Keeps each commit buildable and reviewable. |

| # | Phase | Key deliverables (definition of done) |
|---|---|---|
| 0 | Audit, architecture, planning | This plan, ARCHITECTURE.md, DEVELOPMENT_STATUS.md |
| 1 | Repository infrastructure | git `main`, licence, community files, Tauri 2 + React + Vite scaffold that builds, Vitest + cargo test running, CI, Dependabot, version check script |
| 2 | Core & custom window | Frameless window + custom title bar (drag regions, min/max/restore/close, state persistence, DPI), app layout shell, error model, SQLite + migrations, settings store (user scope), theme token engine with first themes, command registry, output channel + notification primitives |
| 3 | Workspace system & launcher | Open folder, recent/favourite workspaces, workspace records in DB, workspace settings scope, **Workspace Trust**, portable `.ivily-workspace` file (opt-in, versioned), launcher view, startup behaviour setting, session persistence skeleton |
| 4 | File explorer & fs ops | Workspace-scoped path validation, lazy tree, `.gitignore`/exclusions, file watcher, create/rename/copy/move/duplicate, delete to Recycle Bin, multi-select, keyboard nav, icon-pack architecture (moved here from 9 as needed) |
| 5 | Editor engine | CodeMirror 6 documents, tabs (pin/preview/dirty), editor groups & splits, save/save as/save all, autosave, encoding & EOL detection/conversion, find/replace, session restore, large-file mode |
| 6 | Language support | Language provider registry, language tiers, Lezer/legacy-mode syntax for the full language list, indentation/folding/comment rules |
| 7 | LSP & toolchains | LSP process manager (Rust), JSON-RPC framing, server registry & discovery, install *guidance* only, client features (completion, hover, diagnostics, go-to, references, rename, formatting), toolchain discovery view |
| 8 | Terminal | ConPTY via `portable-pty`, xterm.js, profiles (PowerShell, CMD, Git Bash, WSL), tabs/splits, resize, search, safe process lifecycle |
| 9 | Git | Git CLI backend (fixed argv, porcelain v2), status/stage/commit/branches/stash/remotes/tags/history, diff viewer, conflict workspace; destructive ops behind confirmation, no force-push |
| 10 | Search, Quick Open, Command Palette | ripgrep-library content search with cancellation & streaming, replace with preview, fuzzy quick open, palette UI over the command registry, keybinding editor |
| 11 | Task engine | Task definitions (trusted workspaces only), approval on first run, chains/dependencies, cancellation, history |
| 12 | Problems, Output, Diagnostics | Problems panel aggregating LSP/task diagnostics, full Output panel (filter/search/export, secret redaction) |
| 13 | Settings, themes, icons (complete) | Settings UI (search, reset, import/export, precedence), all six themes incl. full Pixel visual system, icon packs |
| 14 | Notes, bookmarks, previews | Notes/bookmarks in app DB, Markdown/image/SVG/JSON previews, sandboxed HTML preview |
| 15 | Debugging infrastructure | DAP client architecture, breakpoints model, first provider only where it is genuinely integrated |
| 16 | Extension architecture | Manifest, versioning, permissions, enable/disable; declarative contributions first (themes, icon packs, languages, snippets); no arbitrary code execution |
| 17 | IEP client | Discovery, `describe`/`request` with timeouts, 0.1 + Envora adapter, Center's own `--iep describe`, protocol docs |
| 18 | Module manager & dashboard | Module list, status/compat/health, enable/disable integration, open module, ecosystem events |
| 19 | Update manager | App updates via signed updater, module update metadata, history, settings |
| 20 | Backup & restore | App-data backups (never source code by default), verify, retention, import/export, corruption recovery |
| 21 | Security, performance, stability | Threat-model review, IPC fuzz/negative tests, profiling on large repos, crash recovery |
| 22 | Multi-window, accessibility, UX | Per-window sessions, scoped IPC, keyboard/screen-reader audit |
| 23 | Comprehensive testing | Integration/UI test coverage of the subsystems above |
| 24 | Documentation | All user/dev docs reconciled with the implementation |
| 25 | Installer & first release | Per-user NSIS, checksums, signed updater artifacts, release notes, v0.1.0 |

Phases 4–14 depend on 2–3 but are otherwise largely independent; their order may change if a
dependency demands it, and any change is recorded in DEVELOPMENT_STATUS.md.

## 4. Risks and open questions

| Risk / question | Mitigation |
|---|---|
| Scope is very large for one codebase. | Strict milestone gating; nothing marked done without build + tests; status doc lists gaps honestly. |
| ConPTY quirks (resize, encoding, Ctrl+C, process trees). | Use `portable-pty` (well exercised); kill process trees with Job Objects; dedicated lifecycle tests. |
| CodeMirror memory with many open files. | One `EditorView` per visible group; inactive tabs keep only `EditorState`; large-file mode disables heavy extensions. |
| Git CLI parsing differences across versions. | Porcelain v2 + `-z` only; minimum Git version check; parser unit tests from recorded output. |
| Extension security. | No third-party code execution until a sandbox design is accepted (Phase 16 ADR). |
| Envora IEP dialect divergence. | Adapter in Center; propose alignment in Envora. |
| Updater signing key lives with the maintainer. | Release workflow fails closed if `TAURI_SIGNING_PRIVATE_KEY` is missing (same as siblings). |
| `gh` CLI unavailable locally. | Verify pushes with `git ls-remote`; GitHub UI for releases. |
