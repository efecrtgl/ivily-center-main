# Testing

## Suites

| Suite | Command | Count (Phase 23) | What it covers |
|---|---|---|---|
| Rust unit/integration | `cd src-tauri && cargo test` | 149 (+1 ignored benchmark) | Database migrations and recovery, settings, workspaces/trust/sessions, filesystem scope (incl. a real junction escape), document I/O and encodings, toolchain detection, LSP framing and a real stdio process, ConPTY terminal, Git against real repositories, search/replace/Quick Open, tasks (real PowerShell exit codes), DAP transport with a scripted adapter, extensions install, IEP envelopes and **real sibling binaries when present**, Center's `--iep` server, backups (create/verify/tamper/restore), multi-window rules |
| Frontend (Vitest + Testing Library, jsdom) | `npm test` | 185 in 32 files | Stores and models of every feature, component behaviour, keyboard handling, dialogs, the workbench integration test (all contributions, shortcuts, Command Palette, Quick Open, pages, notifications, context menus) and the accessibility audit |
| Coverage | `npm run test:coverage` | statements 61.8 %, lines 67.4 % | Reported locally (`coverage/`, not committed) |
| Real-app smoke tests | `powershell -ExecutionPolicy Bypass -File scripts/smoke/run.ps1` | 2 scripts | Builds and runs the debug app, attaches to the WebView2 DevTools protocol and checks: workbench renders, Command Palette (76 commands), lazy pages (About, Ecosystem, Keyboard Shortcuts, Backups), side-bar views, a second window via Ctrl+Shift+N — with **no JavaScript exceptions or console errors** |
| Benchmark | `cd src-tauri && cargo test --release bench_large_tree -- --ignored --nocapture` | — | Walk, fuzzy scoring and search on `node_modules` (see SECURITY-REVIEW.md) |

CI (`.github/workflows/ci.yml`) runs the frontend tests and build, `cargo fmt --check`,
`cargo clippy -D warnings`, `cargo test --locked`, `npm audit` and `cargo audit` on
`windows-latest` for every push.

## Principles

* Backend tests use real temporary folders, real processes (PowerShell, cmd, Node.js scripted
  servers/adapters, Git) and real SQLite databases instead of mocks wherever practical.
* Frontend tests mock only the IPC boundary (`platform/ipc.js`); everything above it is real.
* Every destructive or security-relevant path has a test that the dangerous action does **not**
  happen without confirmation (discard, delete, replace, restore, task/debug approval, extension
  install, theme/settings import, update install).

## Not covered by automated tests

* Visual appearance (themes, layout) and native dialogs (open/save/folder pickers).
* Real language servers and debug adapters (none installed on the development machine; covered by
  scripted servers/adapters).
* Network Git operations (fetch/pull/push/clone) and update download/installation (no signed
  release exists yet).
* Screen readers (accessible names are audited automatically; no manual Narrator/NVDA pass).
* Portly over IEP (no release build available locally); Optimizer, Structura and Envora were
  exercised with real builds.
