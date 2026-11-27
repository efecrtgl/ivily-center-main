# Updates

Implementation: `src-tauri/src/commands/update.rs` (tauri-plugin-updater), `src/features/update/`.

## How updates work

* **Source:** only `https://github.com/efecrtgl/ivily-center-main/releases/latest/download/latest.json`
  (fixed in the app; not configurable from the webview).
* **Verification:** the release workflow signs the NSIS installer with the Ivily minisign key; the
  app embeds the matching **public** key (the same key all Ivily apps use) and the updater verifies
  the downloaded installer against it before running it. A package with a missing or wrong
  signature is never installed.
* **Consent:** *Check for Updates* only reads `latest.json`. Downloading and installing happen only
  after *Download and Install* and a confirmation. Before installing, the workspace session and
  drafts are flushed and a clean exit is recorded; the installer runs in passive mode (per-user, no
  administrator rights) and Ivily Center closes. If the installer fails, the existing installation
  stays.
* **Automatic checks:** *Check once a day on startup* (`updates.checkOnStartup`, default on) checks
  15 seconds after startup if the last check is older than 24 hours; it only notifies when an
  update exists. Nothing is downloaded automatically.
* **History:** the last 50 checks and install attempts (time, result, version, error) are kept in
  the app database and shown on the *About Ivily Center* page.

## Module updates

The Ivily Ecosystem dashboard shows the update state each module reports about itself (IEP
`describe` → `update`). Modules update themselves; Center never downloads or runs module
installers.

## Release requirements (maintainers)

`createUpdaterArtifacts` is enabled only in the release workflow (`--config`), so local and CI
builds work without the private key. Publishing an updatable release requires the repository
secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the Ivily signing
key matching the embedded public key). Without them the release workflow stops instead of
publishing unsigned artifacts.

## Verification status

Signature verification, download and installation are performed by tauri-plugin-updater and have
not been exercised end-to-end because no signed release exists yet. The UI flow (check, notes,
confirmation, startup throttling, missing release) is covered by tests with a mocked backend.
