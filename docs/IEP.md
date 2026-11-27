# Ivily Ecosystem Protocol (IEP) in Ivily Center

Implementation: `src-tauri/src/iep/` (client, `server.rs` for Center's own endpoint,
`version.rs`), `commands/modules.rs`.

IEP is how Ivily apps describe themselves to each other. It is **local only** (no network, no
listening port, no background service): the caller starts the other app's executable with a
command-line flag, writes at most one request to stdin and reads one JSON line from stdout. Every
method is read-only.

## Dialects

| App | Transport | Envelope |
|---|---|---|
| Optimizer (≥ 0.3.0), Portly, Structura, **Center** | `exe --iep describe`, `exe --iep request` | IEP 0.1: request `{ "protocol": "iep", "version": "0.1.0", "id", "method", "params"? }` → `{ "protocol", "version", "id", "ok", "result" \| "error": { "code", "message" } }` |
| Envora | `exe --iep` (request on stdin) | legacy `{ "iep": 1, "id", "method": "iep.hello" \| "envora.*" }` → `{ "iep": 1, "id", "result" \| "error" }` |

Center implements IEP 0.1 as the canonical dialect plus a small adapter for Envora's envelope.
Aligning Envora with IEP 0.1 is recommended (to be done in the Envora repository).

**Compatibility:** semver; while the protocol is 0.x the minor version must match exactly
(0.1 client ↔ 0.1 server). Unknown request fields are rejected by providers; unknown response
fields are ignored by Center.

## Center as a client

* **Discovery:** each module's per-user install location (`%LOCALAPPDATA%\<Product Name>\<exe>`)
  or a path from the setting *Module locations* (`ecosystem.modulePaths`, `product|C:\path\app.exe`).
  Nothing from a workspace is ever used to find or start a module.
* **Version gate:** before starting a module, Center reads the executable's version resource. It
  must name the expected product (e.g. "Ivily Optimizer") with a version that has the IEP command
  line (Optimizer 0.3.0, others 0.1.0). Older builds ignore `--iep` and would open their window, so
  they are shown as *incompatible* and never started for IEP.
* **Calls:** no window (`CREATE_NO_WINDOW`), inside a Job Object, 8 s timeout, ≤ 2 MB output, working
  directory = the module's folder. Only allowlisted read-only methods can be requested:

  | Module | Methods |
  |---|---|
  | Optimizer | `describe`, `health`, `capabilities` |
  | Portly | + `ports.summary`, `projects.summary` |
  | Structura | + `projects.list`, `analysis.summary` |
  | Envora | `iep.hello`, `envora.health`, `envora.profiles.summary`, `envora.path.summary`, `envora.analysis.summary`, `envora.activity.summary`, `envora.workspace.projects`, `envora.update.metadata` |

* Envora answers only when its own setting *Ecosystem* is enabled and each capability is granted
  there; otherwise Center shows it as *disabled* with that explanation.
* Discovery runs only when the Modules view asks (opening it, or *Refresh*); there is no polling.
  The integration can be turned off entirely (`ecosystem.enabled`).

## Center as a provider

`ivily-center.exe --iep describe` and `ivily-center.exe --iep request` behave like the other IEP
0.1 providers: no window, no single-instance lock, the database is never created, migrated or
written (read-only `query_only` connection). Methods: `describe`, `health`, `capabilities`.

```json
{
  "protocol": { "name": "iep", "version": "0.1.0", "minCompatible": "0.1.0" },
  "app": { "id": "com.efecrtgl.ivilycenter", "product": "ivily-center", "name": "Ivily Center", "version": "0.0.1", "platform": "windows", "repository": "https://github.com/efecrtgl/ivily-center-main" },
  "transport": { "kind": "cli", "describe": ["--iep", "describe"], "request": ["--iep", "request"], "backgroundService": false },
  "capabilities": [
    { "id": "app.identity", "version": "1", "access": "read", "status": "available" },
    { "id": "app.capabilities", "version": "1", "access": "read", "status": "available" },
    { "id": "app.health", "version": "1", "access": "read", "status": "available" }
  ],
  "health": { "status": "ok", "dataDirExists": true, "database": "ok", "schemaVersion": 2, "expectedSchemaVersion": 2 },
  "generatedAt": 1795812891
}
```

Errors: `too_large` (> 64 KB), `invalid_request` (invalid JSON, missing or unknown field),
`unsupported_protocol`, `incompatible_version`, `invalid_id` (1–64 of `A-Z a-z 0-9 - _ .`),
`unknown_method`, `invalid_params`, `usage` (exit code 2). Success exits with 0, protocol errors
with 1.

## Verification

Unit tests cover envelopes, allowlists, version rules and the server's validation. On the
development machine the client was also run against locally built Optimizer 0.3.0 and Structura
0.1.0 (status *ok*, `health` request) and Envora 0.1.0 (status *disabled*, its IEP is off by
default); the installed Optimizer 0.2.0 was correctly refused without being started. Portly was
not available as a release build and was not exercised.
