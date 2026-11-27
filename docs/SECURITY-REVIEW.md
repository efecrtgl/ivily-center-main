# Security, performance and stability review (Phase 21)

Date: 2026-11-28. Scope: the whole application as of Phase 20.

## Threat model

| Actor / input | Trust | Examples |
|---|---|---|
| The user (UI actions, settings, dialogs) | trusted | Commands, user-scope settings, files picked in native dialogs |
| Workspace content | **untrusted** until the folder is trusted, and even then never executed silently | `tasks.json`, `launch.json`, `package.json` scripts, `.ivily/extensions.json`, `.git/config`, file names and contents |
| Webview (React UI) | constrained | Has no filesystem, shell, HTTP, dialog or updater permissions; only validated commands |
| Installed Ivily modules | semi-trusted (user-installed apps) | IEP answers are parsed defensively, size- and time-limited |
| Extensions | untrusted data | Declarative JSON only — no code |
| Network | untrusted | Only GitHub Releases for updates (signature-verified) |

## Boundaries and controls

**Webview → backend (IPC).** 132 commands. Capabilities grant only window controls; strict CSP
(`script-src 'self'`, no remote connections, `object-src 'none'`, `frame-ancestors 'none'`),
`freezePrototype`. The webview never passes absolute paths: files are `(root index, relative path)`
resolved and confined by `fs::scope` (junction/symlink escapes tested), dialog results are opaque
one-shot grants (`Discovered`, `SaveTarget`, `ExternalDoc`, `ExtensionSource`), and workspace
commands resolve their workspace from the calling window. Inputs use `deny_unknown_fields`, size
limits and allowlists (e.g. IEP methods, backup names, extension ids, UI-state keys).

**Process launches** — every one is listed here:

| Launch | Trigger | Gate |
|---|---|---|
| Language servers | opening a file | trust `languageServers`; executable from PATH or user setting; Job Object |
| Terminal shells | user action | detected/user profiles only (absolute paths); Job Object |
| Tasks | user action | trust `taskExecution` + approval of the exact command (hash), cwd confined, PowerShell `-EncodedCommand`; Job Object |
| Git | Source Control view | trust `workspaceExecutables` (repo config can run programs); no force options |
| Debug adapters | user action | trust `debugging` + approval of the resolved configuration; reverse requests refused; Job Object |
| Ivily modules (IEP) | dashboard open/refresh | version resource must name the product with an IEP-capable version; no window; Job Object; 8 s / 2 MB limits; allowlisted read-only methods |
| Module app window | user action | executable must carry the expected product name |
| `rundll32 url.dll` | link click | `http`/`https` only, no whitespace/quotes/control characters |
| `explorer.exe /select` | user action | workspace-confined path |
| Update installer | user action | minisign signature verified against the embedded public key |
| Toolchain probes | Tools page | fixed tool names, `--version`, no workspace input |

Nothing is installed silently (winget commands are only shown or run in a visible terminal after
confirmation), and nothing requests elevation.

**Data integrity.** Saves are atomic with hash checks (external changes are never overwritten
silently); deletes go to the Recycle Bin unless "delete permanently" is confirmed; multi-file
replace skips dirty and changed files; restores keep the replaced data; corrupt databases are kept
aside; migrations take backups first.

**Secrets.** Output channels redact tokens, passwords and credentials in URLs; error messages do
not echo file contents or JSON input; Git remote URLs with credentials are redacted in the UI.

**Supply chain.** CI runs `npm audit --omit=dev --audit-level=high` and `cargo audit`.
In this phase `zip` was upgraded 2.6 → 9 (six advisories in the old version, in code paths Ivily
Center did not use). Remaining `cargo audit` warnings are informational and come from Tauri's
transitive dependencies: `glib` (Linux GTK stack, not used on Windows), `proc-macro-error`
(build-time macro, unmaintained), `chrono` (unmaintained notice).

## Residual risks (accepted, documented)

* Trust is bound to a path (a deleted trusted folder recreated at the same path stays trusted).
* A trusted workspace's tasks/launch configurations run with the user's rights after approval —
  approval is the control, not sandboxing.
* Rendered Markdown and HTML previews rely on DOMPurify and a permission-less sandboxed frame.
* IEP providers are trusted to the extent of their parsed, size-limited JSON answers.

## Performance

Measured on the development machine (32 threads, NVMe), release build:

| Operation | Size | Time |
|---|---|---|
| Workspace walk (Quick Open index) | 5,202 files / 137 MB (`node_modules`) | 29 ms |
| Fuzzy scoring of every file | 5,202 paths | 4 ms |
| Search, literal and regex | same tree, warm cache | ~105 ms |
| Search, first run | same tree, cold disk cache | ~4.5 s (I/O bound) |
| `--iep describe` of a module | real Optimizer/Structura builds | < 100 ms each |

Frontend bundle: the main chunk went from 1.5 MB to 1.08 MB by loading xterm.js with the first
terminal and loading the diff, tools, keybindings, preview, trust manager, ecosystem, about and
backup pages on first use. Language grammars were already lazy.

## Stability

* A real-app smoke test (debug build + dev server, inspected through the WebView2 DevTools
  protocol) loaded the workbench, opened the command palette (75 commands), the lazy pages and the
  new side-bar views without any JavaScript exception or console error.
* Crash detection, safe mode after repeated failed starts, draft recovery and the clean-exit marker
  (also set before an update installs) are in place from earlier phases.
