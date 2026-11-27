# Releasing

## One-time setup (repository owner)

The updater verifies every installer against the Ivily minisign **public** key embedded in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`, key id `0F2E0C0D3639FEC8`, shared by all
Ivily apps). Releases must therefore be signed with the matching **private** key. Add these
repository secrets (*Settings → Secrets and variables → Actions*):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the Ivily minisign private key (the contents of the `.key` file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

Without them the release workflow stops at *Updater signing key must be configured*; no release is
created and nothing unsigned is published.

## Cutting a release

1. Update the version in `package.json` and `src-tauri/Cargo.toml` (then `npm install
   --package-lock-only` and `cargo update -p ivily-center`), and move the `[Unreleased]` entries of
   `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading.
   `scripts/check-version.ps1 -Tag vX.Y.Z` must pass.
2. Commit, push, and push the tag: `git tag -a vX.Y.Z -m "Ivily Center X.Y.Z"` then
   `git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` then: checks the version, runs all tests, requires the signing
   key, builds the NSIS installer with updater artifacts (`--config src-tauri/tauri.release.conf.json`),
   creates a **draft** release with `latest.json` and the release notes from `CHANGELOG.md`,
   verifies the artifacts (installer, `.sig`, size, version), installs and uninstalls the
   installer on the clean runner (`scripts/test-installer.ps1`) and uploads `SHA256SUMS.txt`.
4. Review the draft (notes, assets, checksums) and publish it. Publishing makes `latest.json`
   available at `releases/latest/download/latest.json`, which is what installed copies check.

## Release assets

| Asset | Purpose |
|---|---|
| `Ivily.Center_X.Y.Z_x64-setup.exe` | Per-user NSIS installer (no administrator rights; installs WebView2 if missing) |
| `Ivily.Center_X.Y.Z_x64-setup.exe.sig` | Updater signature (minisign) |
| `latest.json` | Updater manifest |
| `SHA256SUMS.txt` | SHA-256 of every asset (published names) |

## Local builds

`npm run tauri build` produces the installer in `src-tauri/target/release/bundle/nsis/` without
updater artifacts (no key needed). Such a build is for testing only; distribute only CI-built,
signed releases.
