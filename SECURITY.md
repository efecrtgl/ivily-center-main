# Security Policy

## Supported versions

Ivily Center is pre-release. Once released, only the latest minor version receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities **privately** via
[GitHub security advisories](https://github.com/efecrtgl/ivily-center-main/security/advisories/new).
Do not open a public issue. You can expect an initial response within 7 days.

## Security model

The full design is in [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-security-architecture).
The table below lists guarantees that are **implemented**.

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
| Filesystem | File operations accept only (workspace folder, relative path) pairs confined to the folder (symlink/junction escapes refused); deletes go to the Recycle Bin unless "delete permanently" is confirmed; saves are atomic and refuse to overwrite external changes. | Phase 4–5 |
| Processes | Language servers, terminals, tasks, debug adapters and IEP calls run inside Windows Job Objects (killed with their process tree); nothing elevates; nothing is installed silently (install commands are only shown or run visibly after confirmation). | Phase 6–8 |
| Language servers / Git | Require the workspace trust capabilities *Language servers* / *Use executables from workspace settings*; Git never force-pushes and confirms destructive operations. | Phase 7, 9 |
| Tasks / debugging | Require trust *Run tasks* / *Debugging* plus approval of the exact command or resolved launch configuration on first run (re-approval when it changes); unsupported variables are refused; adapters cannot launch processes through Center. | Phase 11, 15 |
| Search & replace | Replace only touches confirmed files, skips files with unsaved changes and refuses files changed since they were read. | Phase 10 |
| Imports & extensions | Themes, icon packs, settings and extensions are validated before use; extensions are declarative (no code), copied only as referenced JSON files after a contribution preview. | Phase 13, 16 |
| Previews | Markdown is sanitized (DOMPurify); HTML previews run in a permission-less sandboxed frame. | Phase 14 |
| Ecosystem | IEP modules are found only at install locations or user-configured paths, version-gated before launch, run without a window with timeout/output limits, and only allowlisted read-only methods are callable. | Phase 17–18 |
| Updates | Only from this repository's GitHub Releases, verified against the embedded minisign public key, installed only after confirmation. | Phase 19 |
| Backups | Archives are verified (paths, SHA-256, database integrity) before restore; restores keep the replaced data. | Phase 20 |
| Windows | Every window can address only its own workspace; one window per workspace. | Phase 22 |

The threat model, process-launch inventory and residual risks are in
[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).
