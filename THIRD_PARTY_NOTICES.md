# Third-party notices

Ivily Center is MIT-licensed and builds on the open-source projects below. Each keeps its own
licence; the full licence texts ship with the packages (`node_modules/*/LICENSE`, the Cargo
registry sources). The lists cover direct dependencies; transitive dependencies are recorded in
`package-lock.json` and `src-tauri/Cargo.lock`.

## Bundled assets

| Asset | Source | Licence |
|---|---|---|
| Pixelify Sans | `@fontsource/pixelify-sans` (Google Fonts) | SIL Open Font License 1.1 |
| VT323 | `@fontsource/vt323` (Google Fonts) | SIL Open Font License 1.1 |
| JetBrains Mono | `@fontsource/jetbrains-mono` | SIL Open Font License 1.1 |
| Pixel theme palette | "Sweetie 16" by GrafxKid | Public domain (CC0) |

Icons in `src/icons/packs/` are original to this project (MIT).

## Frontend (npm)

| Package | Licence |
|---|---|
| React, React DOM | MIT |
| CodeMirror 6 (`@codemirror/*`, `codemirror`, `@lezer/highlight`), incl. `@codemirror/lsp-client` and `@codemirror/merge` | MIT |
| xterm.js (`@xterm/xterm`, `addon-fit`, `addon-search`, `addon-web-links`) | MIT |
| marked | MIT |
| DOMPurify | MPL-2.0 OR Apache-2.0 (used under Apache-2.0) |
| `@tauri-apps/api` | Apache-2.0 OR MIT |

## Backend (Rust crates)

| Crate | Licence |
|---|---|
| tauri, tauri-plugin-dialog, tauri-plugin-updater | Apache-2.0 OR MIT |
| rusqlite (bundled SQLite: public domain) | MIT |
| portable-pty | MIT |
| grep-searcher, grep-regex, grep-matcher, ignore, globset | Unlicense OR MIT |
| regex, serde, serde_json, sha2, base64, parking_lot, tempfile, thiserror, dirs, windows-sys | MIT OR Apache-2.0 |
| encoding_rs | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| notify | CC0-1.0 |
| trash, zip | MIT |
| dunce | CC0-1.0 OR MIT-0 OR Apache-2.0 |

## External programs (not bundled)

Ivily Center can start programs that are already installed on the computer — Git for Windows,
language servers, debug adapters, shells and the other Ivily apps. They are not distributed with
Ivily Center and keep their own licences.
