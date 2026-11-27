# Ivily Center

Ivily Center is an open-source, Windows-first development environment built with Rust, Tauri 2,
React and CodeMirror 6. It works as a standalone IDE and, optionally, as the integration hub of the
Ivily ecosystem (Ivily Optimizer, Envora, Portly and Structura).

> **Status: pre-release (0.x).** All planned subsystems are implemented and tested; see
> [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for what has and has not been verified on real
> hardware and with real external tools.

## Features

| Area | Highlights |
|---|---|
| Workspaces | Folders and multi-root `*.ivily-workspace` files, launcher with recents/favorites/discovery, per-workspace settings and sessions, crash recovery, **Workspace Trust** per folder and capability, multiple windows |
| Explorer | Lazy tree with Git decorations, `.gitignore`/excludes, file watcher, create/rename/move/copy, Recycle Bin deletes, properties |
| Editor | CodeMirror 6: tabs, split groups, preview tabs, hot exit (drafts), encodings and line endings, large files, conflict-safe saves, bookmarks, Markdown/HTML preview |
| Languages | 60+ languages with honest support tiers, toolchain detection (without installing anything), **LSP** for 23 known servers (completion, hover, diagnostics, navigation, rename, formatting) |
| Terminal | ConPTY terminals with PowerShell/CMD/Git Bash/WSL profiles, tabs and splits, search, links |
| Git | Status, staging, commits/amend, branches, history, diffs, stashes, tags, remotes, merge/rebase/cherry-pick/revert, conflict resolution — never forced |
| Search | Workspace search/replace (ripgrep libraries), Quick Open (Ctrl+P), Command Palette (Ctrl+Shift+P), symbols, go to line, keyboard-shortcut editor |
| Tasks | `.ivily`/`.vscode` tasks, npm scripts, Cargo; approval of the exact command on first run; dependencies; problem matchers |
| Debugging | Debug Adapter Protocol client (debugpy, lldb-dap, netcoredbg or any configured adapter): breakpoints, stepping, call stack, variables, debug console |
| Problems & Output | Diagnostics and task problems in one panel; output channels with secret redaction and export |
| Customization | Six themes (modern, pixel, retro, glass), user themes and icon packs, settings import/export, declarative **extensions** (themes, icon packs, snippets, shortcuts, file associations — no code) |
| Ivily ecosystem | Read-only **Ivily Ecosystem Protocol** client and dashboard; Center answers `--iep describe` itself |
| Maintenance | Signed updates from GitHub Releases (only after confirmation), verified backups of app data with staged restore |
| Accessibility | Every command reachable by keyboard, accessible names audited, high-contrast support, adjustable interface size, reduced motion |

## Principles

- **Standalone.** Every IDE feature works without any other Ivily app installed.
- **Untrusted by default.** Nothing from a workspace runs until you trust it — and tasks and launch
  configurations still need approval of their exact command.
- **No silent destruction, installs, elevation or telemetry.** Deletes go to the Recycle Bin, saves
  never overwrite external changes, tools are never installed for you.
- **Honest.** Features are documented once they exist; unverified parts are listed as such.

## Documentation

User and design documentation lives in [`docs/`](docs):

- Workspaces & trust: [WORKSPACES](docs/WORKSPACES.md) · Explorer: [EXPLORER](docs/EXPLORER.md) · Editor: [EDITOR](docs/EDITOR.md)
- Languages: [LANGUAGES](docs/LANGUAGES.md) · [LSP](docs/LSP.md) · Terminal: [TERMINAL](docs/TERMINAL.md) · Git: [GIT](docs/GIT.md)
- [Search, Quick Open & shortcuts](docs/SEARCH.md) · [Tasks](docs/TASKS.md) · [Debugging](docs/DEBUGGING.md) · [Problems & output](docs/PROBLEMS.md)
- [Themes & customization](docs/THEMES.md) · [Commands & keybindings](docs/COMMANDS.md) · [Notes, bookmarks, previews](docs/NOTES.md) · [Extensions](docs/EXTENSIONS.md)
- [Ivily Ecosystem Protocol & dashboard](docs/IEP.md) · [Updates](docs/UPDATES.md) · [Backup & restore](docs/BACKUP.md)
- [Multiple windows & accessibility](docs/WINDOWS-AND-ACCESSIBILITY.md)
- Engineering: [Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) · [Security review](docs/SECURITY-REVIEW.md) · [Testing](docs/TESTING.md) · [Releasing](docs/RELEASING.md) · [Development plan](docs/DEVELOPMENT_PLAN.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Installing

Download `Ivily Center_<version>_x64-setup.exe` from
[GitHub Releases](https://github.com/efecrtgl/ivily-center-main/releases) and run it. The installer
is per-user (no administrator rights) and installs the WebView2 runtime if it is missing. Verify the
download with the `SHA256SUMS.txt` published next to it:

```powershell
Get-FileHash ".\Ivily Center_<version>_x64-setup.exe" -Algorithm SHA256
```

## Building from source

Requirements: Windows 10/11 x64, Rust (stable, MSVC toolchain), Node.js 22+, the WebView2 runtime.
Git for Windows is needed for the Source Control features at runtime.

```powershell
npm ci
npm run tauri dev      # run in development (Vite dev server on port 1460)
npm test               # frontend tests
cd src-tauri; cargo test; cd ..
npm run tauri build    # NSIS installer in src-tauri/target/release/bundle/nsis/
```

## License

[MIT](LICENSE)
