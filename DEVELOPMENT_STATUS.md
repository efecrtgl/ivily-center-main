# Development Status

Last updated: 2026-11-27

No completion percentages are given on purpose; a phase is either **done** (built, tested,
committed, pushed and verified on GitHub), **in progress**, or **planned**.

## Current phase

**Phase 25 — Installer and first release:** installer built and verified locally; release workflow added; tag `v0.1.0` pushed (see Release status). **All phases 0–25 are implemented.**

## Phases

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Audit, architecture, planning | done | [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 1 | Repository infrastructure | done | Scaffold, community files, CI. Release workflow deferred to Phase 25 (needs updater signing). |
| 2 | Core & custom window | done | `ffc8066`, `58b9731`, `7725969`. Window-size regression fixed in Phase 3 (`3bda5ed`). |
| 3 | Workspace system & launcher | done | `52f9bfc` backend, `611e072` UI state, `3bda5ed` window fix, `6d6ae4e` UI, then docs. [docs/WORKSPACES.md](docs/WORKSPACES.md) |
| 4 | File explorer & filesystem | done | `defcb4c` backend, `6c20e52` UI. [docs/EXPLORER.md](docs/EXPLORER.md) |
| 5 | Code editor | done | `2250911` document I/O, `962bcb5` editor. [docs/EDITOR.md](docs/EDITOR.md) |
| 6 | Language support & toolchains | done | `4d8e963`. [docs/LANGUAGES.md](docs/LANGUAGES.md) |
| 7 | Language Server Protocol | done | `fd2dffc`. [docs/LSP.md](docs/LSP.md) |
| 8 | Integrated terminal | done | `d207d27`. [docs/TERMINAL.md](docs/TERMINAL.md) |
| 9 | Git | done | `e4179dc` backend, then UI. [docs/GIT.md](docs/GIT.md) |
| 10 | Search, Quick Open, Command Palette, shortcuts | done | backend + UI commits. [docs/SEARCH.md](docs/SEARCH.md) |
| 11 | Tasks | done | [docs/TASKS.md](docs/TASKS.md) |
| 12 | Problems panel, output export | done | [docs/PROBLEMS.md](docs/PROBLEMS.md) |
| 13 | Settings import/export, user themes, icon packs | done | [docs/THEMES.md](docs/THEMES.md) |
| 14 | Notes, bookmarks, Markdown/HTML preview | done | [docs/NOTES.md](docs/NOTES.md) |
| 15 | Debugging (DAP) | done | `ce9f520` backend, then UI. [docs/DEBUGGING.md](docs/DEBUGGING.md). No real adapter installed — verified with scripted adapters. |
| 16 | Declarative extensions | done | [docs/EXTENSIONS.md](docs/EXTENSIONS.md) |
| 17 | IEP client and Center's `--iep` endpoint | done | [docs/IEP.md](docs/IEP.md); verified against real Optimizer/Structura/Envora builds |
| 18 | Ivily Ecosystem dashboard | done | [docs/IEP.md](docs/IEP.md#ivily-ecosystem-dashboard-module-manager) |
| 19 | Update manager | done | [docs/UPDATES.md](docs/UPDATES.md); end-to-end install untested until a signed release exists |
| 20 | Backup and restore | done | [docs/BACKUP.md](docs/BACKUP.md) |
| 21 | Security, performance, stability | done | [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) |
| 22 | Multi-window, accessibility | done | [docs/WINDOWS-AND-ACCESSIBILITY.md](docs/WINDOWS-AND-ACCESSIBILITY.md) |
| 23 | Comprehensive testing | done | [docs/TESTING.md](docs/TESTING.md): 149 Rust + 185 frontend tests, coverage, real-app smoke tests |
| 24 | Documentation | done | README, ARCHITECTURE (as built, ADRs 11–15), SECURITY, THIRD_PARTY_NOTICES, stale references removed |
| 25 | Installer and first release | done (publication depends on the signing secret) | [docs/RELEASING.md](docs/RELEASING.md) |

## Phase 3 deliverables

| Area | Delivered | Not included (later phase) |
|---|---|---|
| Opening | Folder and `*.ivily-workspace` workspaces via backend-owned dialogs, recents, discovery tokens and the command line; validated canonical paths; duplicate collapse; per-window workspace context | Second-instance forwarding of command-line paths, multi-window (Phase 22) |
| Registry | Recents, favorites, groups, display names, availability checks with timeout, relocation, removal that never touches disk | Project notes (Phase 14), Git/health summaries in the launcher (Phase 9) |
| Launcher | Optional editor-area page, filter, favorites/recent sections, project discovery, startup choice | Project templates / project creation |
| Settings | Workspace layer (DB for folders, file for workspace files), User/Workspace tabs, per-layer values, conflict handling | More workspace-capable settings arrive with their features (editor, files, terminal …) |
| Workspace files | Format v1, relative folders, unknown-field preservation, explicit Save As with overwrite confirmation, atomic hash-checked writes, reload | Editing folder lists in the UI |
| Trust | Per folder and capability, folder/parent scope, session/remembered, remembered denial, revocation, prompt, banner, status item, trust manager, backend gate `workspace_untrusted` | Nothing executes yet; subsystems from Phases 7, 8, 11, 15, 16 must call the gate |
| Sessions | Per-workspace documents with participants (layout now), previous-version fallback, flush on switch/close, crash detection, safe mode | Editor/explorer/terminal participants (their phases) |

## Architectural decisions (Phase 3)

* The webview never supplies filesystem paths; locations come from backend dialogs, ids, opaque tokens or the command line.
* Workspace-scoped commands resolve the workspace from the calling window (multi-window ready).
* Trust is keyed by folder path and stored only in the app database; workspace files can never carry trust.
* One serialized transition (flush → backend → reset → epoch → publish → restore) for all workspace changes.
* Features persist workspace UI state through session participants rather than on their own.
* See also [ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-key-technology-decisions-adr-summary).

## Known issues / limitations

* Windows 11 Snap Layouts flyout is not shown when hovering the custom maximize button.
* A command-line path given to a second launch starts a second instance (no single-instance forwarding yet; use New Window inside the app).
* No manual screen-reader pass (Narrator/NVDA) has been done; accessibility is verified by automated checks.
* Trust is bound to a path: if a trusted folder is deleted and another folder is created at the same path, it is trusted too.
* A workspace file's folder list cannot be edited in the UI yet (edit the file and use Reload Workspace File).
* `appearance.reduceMotion = system` is not re-read when the Windows animation setting changes while running.
* Ivily Envora's IEP envelope differs from IEP 0.1 (handled by an adapter in Center; alignment belongs in the Envora repository).
* `gh` CLI is not installed on the development machine; pushes are verified with `git ls-remote`.

## Notes for Phases 4–5

* Explorer and editor were verified with unit/component tests (backend operations against real
  temporary folders, including a real junction-escape attempt; UI against a mocked backend). They
  have not yet been exercised interactively in the running application.
* Documents opened from outside the workspace are not restored after a restart (their access token
  is per-process); their unsaved content is still recovered from drafts as an untitled document.
* The main JavaScript chunk is ~1.08 MB after code splitting in Phase 21 (CodeMirror core, React, the workbench); terminals, diffs and secondary pages load on demand.

## Notes for Phases 6–9

* LSP was verified against a scripted Node.js server (real process, framing, Job Object) and a
  scripted transport in the UI; no real language server was installed on the development machine,
  so completion/hover with e.g. rust-analyzer has not been exercised.
* The terminal was verified with a real ConPTY session (cmd.exe: echo, resize, exit); the xterm.js
  UI is tested with a fake terminal.
* Git was verified against real repositories (status, staging, commits, branches, a real merge
  conflict, stash); network operations (fetch/pull/push/clone) have not been exercised against a
  remote.
* Git requires the `workspaceExecutables` trust capability (see docs/GIT.md for why).

## Notes for Phase 10

* Search, replace and the Quick Open index were tested against real temporary folders (ignore
  rules, binaries, options, limit/cancel, replacement); the UI against a mocked backend.
* Symbol modes (`@`, `#`) depend on a running language server and are untested with a real one.

## Notes for Phase 11

* Task discovery, dependency planning, approval fingerprints and PowerShell exit-code propagation
  are tested against real files and a real `powershell.exe`; the run path reuses the tested ConPTY
  session code. The UI flow (approval dialog, chains, problem matching) is tested with a mocked
  backend. Tasks have not been run interactively in the application window.

## Build / test status (local, 2026-11-28)

| Check | Result |
|---|---|
| `npm test` (Vitest) | 32 files, 185 tests passed |
| `npm run test:coverage` | statements 61.8 %, branches 52.9 %, lines 67.4 % |
| `npm run build` | ok, no warnings except the main-chunk size note (1.08 MB) |
| `cargo fmt --check` | ok |
| `cargo clippy --all-targets --locked -- -D warnings` | ok |
| `cargo test --locked` | 149 passed, 1 ignored (benchmark) |
| `npm audit --omit=dev` / `cargo audit` | 0 vulnerabilities / 0 vulnerabilities (3 informational warnings in Tauri's transitive dependencies) |
| Real-app smoke tests (`scripts/smoke/run.ps1`) | Workbench renders; Command Palette (76 commands); lazy pages and side-bar views open; second window opens; **no JavaScript exceptions or console errors** |
| Real-app runs, earlier phases | Database migration with backup; command-line folder → workspace without automatic trust; restore of the last workspace; unclean-exit marker; stable window size |
| Real external programs | ConPTY shells, PowerShell tasks, Git (local repositories), Node.js scripted LSP server and DAP adapter, real Ivily Optimizer 0.3.0 / Structura 0.1.0 / Envora 0.1.0 builds over IEP, Center's own `--iep` |
| Not verified | Visual appearance and native dialogs; real language servers and debug adapters; network Git; update download/install (no signed release); Portly over IEP; screen readers |

CI results: see GitHub Actions.

## Release status

Version **0.1.0**.

* Local build: `src-tauri/target/release/bundle/nsis/Ivily Center_0.1.0_x64-setup.exe` (5.27 MiB),
  SHA-256 `64098b3310fd1962e5f7cafdb53017147f5846019a7959ae61ad2340a83f198b`. The release executable
  reports version 0.1.0 and answers `--iep describe`. Built **without** updater artifacts (no signing
  key was used locally); for testing only.
* Published releases are produced only by `.github/workflows/release.yml` on a `v*` tag. It requires
  the repository secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, creates a
  **draft** release with signed updater artifacts, `latest.json` and `SHA256SUMS.txt`, and tests
  install/uninstall on the runner. The draft must be published by the repository owner.
* Tag `v0.1.0` was pushed on 2026-11-28. Release run 46071136970: version check, `npm ci`, frontend
  and Rust tests **passed**; it then **stopped at "Updater signing key must be configured"** because
  the repository secret is not set. **No GitHub release exists yet.** To publish: add the two
  secrets (docs/RELEASING.md) and re-run the failed workflow run (or delete and re-push the tag),
  then publish the draft.

## Repository synchronisation

`origin` = https://github.com/efecrtgl/ivily-center-main, branch `main`, verified with `git ls-remote` after each push.
