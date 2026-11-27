# Ivily Center

Ivily Center is an open-source, Windows-first development environment built with Rust, Tauri 2,
React and CodeMirror 6. It is designed to be a genuinely usable standalone IDE, and the optional
integration hub of the Ivily ecosystem (Ivily Optimizer, Envora, Portly and Structura).

> **Status: early development.** Implemented: custom window and workbench, settings, themes,
> commands, output, notifications, workspaces (folders and workspace files), the launcher, Workspace
> Trust and session restore. Not implemented yet: file explorer contents, editor, terminal, Git and
> the other IDE features. See
> [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for what exists today.

## Principles

- **Standalone.** Every IDE feature works without any other Ivily app installed.
- **Untrusted by default.** Nothing from a workspace is executed without explicit user action.
- **No silent destruction, installs or telemetry.**
- **Honest.** Features are documented only once they are implemented.

## Documentation

- [Development plan and roadmap](docs/DEVELOPMENT_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Building from source

Requirements: Windows 10/11, Rust (stable, MSVC), Node.js 22+, WebView2 runtime.

```powershell
npm ci
npm run tauri dev      # run in development
npm run tauri build    # produce the NSIS installer
```

## License

[MIT](LICENSE)
