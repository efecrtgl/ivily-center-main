## Summary

<!-- What does this change do and why? Related issue: #... -->

## Type

- [ ] Bug fix (`fix:`)
- [ ] Feature (`feat:`)
- [ ] Performance (`perf:`)
- [ ] Security (`security:`)
- [ ] Documentation (`docs:`)
- [ ] Tests / CI / chore / refactor

## Safety checklist

- [ ] Nothing from a workspace is executed without explicit user action (and Workspace Trust)
- [ ] No destructive operation without confirmation; no force-push; no silent discard
- [ ] IPC input is validated (types, sizes, paths inside an opened root)
- [ ] No secrets or environment dumps in logs/errors
- [ ] No automatic downloads/installs; no new network calls without a setting
- [ ] No TypeScript introduced

## Verification

- [ ] `npm test` and `npm run build`
- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (in `src-tauri/`)
- [ ] `CHANGELOG.md`, `DEVELOPMENT_STATUS.md` and `docs/` updated where relevant

## Screenshots

<!-- For UI changes: at least one Modern and one Pixel theme. -->
