# Contributing to Ivily Center

Thanks for your interest! Ivily Center is an open-source, Windows-first development environment
and the optional integration hub of the Ivily ecosystem. Contributions are welcome as long as they
keep these promises:

1. **The IDE stands alone.** No IDE feature may require another Ivily app to be installed.
2. **Untrusted by default.** Never execute anything from a workspace (tasks, scripts, terminal
   profiles, language-server commands) without explicit user action in a trusted workspace.
3. **No silent destruction.** No force-push, no silent discard, no permanent delete without
   confirmation, no overwrite without consent.
4. **No silent installs or network.** No automatic toolchain/LSP downloads, no telemetry.
5. **Never overclaim.** Language tiers, debugger support and docs reflect what is implemented.

## Development setup

Requirements: Windows 10/11, Rust (stable, MSVC toolchain), Node.js 22+, WebView2 runtime, Git.

```powershell
npm ci
npm run tauri dev
```

## Checks (run before opening a PR)

```powershell
npm test                 # UI unit tests (Vitest)
npm run build            # UI build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

## Code layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

* `src/` — React UI in **plain JavaScript** (no TypeScript; use JSDoc for types).
  Only `src/platform/` may import `@tauri-apps/api`.
* `src-tauri/src/commands/` — IPC commands: deserialize, validate, delegate. No business logic.
* `src-tauri/src/<subsystem>/` — subsystem logic, free of Tauri types where possible, unit-tested.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) in English, with a scope:
`feat(editor): …`, `fix(terminal): …`, `perf(explorer): …`, `security(ipc): …`, `docs(iep): …`,
`refactor(git): …`, `test(workspace): …`, `ci: …`, `chore: …`.

Keep commits small and buildable. Stage files explicitly (avoid `git add .`).

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.
