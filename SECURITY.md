# Security Policy

## Supported versions

Ivily Center is pre-release. Once released, only the latest minor version receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities **privately** via
[GitHub security advisories](https://github.com/efecrtgl/ivily-center-main/security/advisories/new).
Do not open a public issue. You can expect an initial response within 7 days.

## Security model

The full design is in [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-security-architecture).
The table below lists only guarantees that are **implemented today**; it grows with each phase.

| Area | Guarantee | Since |
|---|---|---|
| IPC | The webview has no filesystem, shell or HTTP plugin. Native work happens only in validated Rust commands. A strict Content Security Policy is applied and the JS prototype chain is frozen. | Phase 1 |
| Network | No telemetry. | Phase 1 |
| Window | Only minimize/maximize/close/drag/set-title window permissions are granted to the webview. | Phase 2 |
| Settings | Every setting write is validated in Rust against a typed schema (type, range, enum, scope); unknown keys are rejected. | Phase 2 |
| UI state | The webview may only write `ui.*` keys (≤ 64 KB); window bounds are written by Rust only. | Phase 2 |
| Logs | Output lines are redacted for common secret shapes (auth headers, URL credentials, `*_TOKEN=`/`password=` values, GitHub/GitLab/OpenAI/Slack/AWS tokens, JWTs, private keys) before storage. The webview can write only to the `ui` channel. | Phase 2 |
| Themes | Theme token values cannot contain `url()`, `@import`, comments or CSS delimiters, so themes cannot load remote content or inject CSS. | Phase 2 |
| Workspaces | The webview never passes filesystem paths: workspaces open only from native dialogs shown by the backend, known workspace ids, opaque tokens or the command line. Paths are validated and canonicalized; the webview has no dialog permission. Each window can only address its own workspace. | Phase 3 |
| Workspace Trust | Workspaces are untrusted by default (Restricted Mode). Trust is per folder and per capability, stored only in the app database (never read from a project), revocable, and enforced in the backend (`workspace_untrusted`). Nothing is executed when a workspace is opened. | Phase 3 |
| Project files | Ivily Center writes into a project only when the user explicitly saves a workspace file: atomically, never replacing an existing file without confirmation, never over external changes. | Phase 3 |
| Data | The database is never deleted: a corrupt file is moved aside, a newer-schema file is left untouched, and existing data is backed up before migrations. | Phase 2 |

Planned (not yet implemented): workspace-scoped file operations (Phase 4), process registry with Job Objects, sandboxed HTML preview, signed updates, read-only IEP client with timeouts.
