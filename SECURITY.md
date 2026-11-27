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

Planned (not yet implemented): workspace-scoped filesystem access, Workspace Trust, process
registry with Job Objects, log redaction, sandboxed HTML preview, signed updates, read-only IEP
client with timeouts.
