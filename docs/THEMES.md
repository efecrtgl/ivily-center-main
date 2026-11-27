# Themes, style layers and icon packs

Implementation: `src/theme/`, `src/icons/`, `src/styles/`.

A theme is three independent parts:

| Part | What it controls | Where |
|---|---|---|
| **Tokens** | Colours, fonts, radii, borders, shadows, motion, backdrop, editor/syntax/terminal colours | `src/theme/tokens.js` (schema), theme definitions |
| **Style layer** | How components are *built*: corners, border weight, bevels, shadows, typography, decorative effects, motion style | `src/theme/layers.js` + `src/theme/layers/<id>.css` |
| **Icon pack** | Which artwork draws each semantic icon | `src/icons/packs/` |

Application features only reference **tokens** (`var(--color-surface)`) and **semantic class names**
(`.btn`, `.panel`, `.titlebar`, …). They never know which theme, layer or icon pack is active.
Switching themes writes CSS custom properties and `data-theme`, `data-style`, `data-appearance` and
`data-icon-pack` on `<html>`; no React state outside the theme store changes, so workspaces, editors,
terminals and all other state are unaffected.

## Built-in themes

| Theme | Appearance | Style layer | Icon pack | Character |
|---|---|---|---|---|
| Modern Dark | dark | modern | modern | Soft depth, rounded corners, smooth motion |
| Modern Light | light | modern | modern | Bright, crisp contrast |
| Pixel Dark | dark | pixel | pixel | 16-colour palette, Pixelify Sans, square notched controls, 2px bevelled borders, hard drop shadows, dithered backdrop, stepped motion |
| Pixel Light | light | pixel | pixel | Same pixel system on a paper-white palette |
| Retro Terminal | dark | retro | pixel | Green phosphor, VT323 bitmap type, CRT scanlines and vignette, `[ BUTTON ]` text-mode controls, inverse-video focus, blinking block cursor |
| Glass | dark | glass | modern | Frosted translucent surfaces (`backdrop-filter`), gradient backdrop, floating rounded workbench tiles |

Glass emulates translucency inside the window; the window itself is not transparent to the desktop.

## Token resolution

`theme.tokens[name]` → `styleLayer.tokens[name]` → schema fallback (`ref` to another token, or a literal,
optionally per appearance). Only the 11 core palette tokens are required; everything else derives.
Editor (`editor.*`, `syntax.*`) and terminal (`terminal.*`, 16 ANSI colours) tokens already exist so the
CodeMirror (Phase 5) and xterm.js (Phase 8) adapters can be themed without changing the schema.

## Validation and safety

`registerTheme` rejects a theme with a missing required token, an unknown token, unknown style layer or
icon pack, or a value containing `url(`, `expression(`, `javascript:`, `@import`, comments, `; { } < > \`.
Themes are therefore pure data and cannot load remote resources or inject CSS. Future extension themes
(Phase 16) go through the same function. A custom theme can choose any registered style layer but cannot
ship new CSS.

## Adding a built-in theme

1. Add a definition to `src/theme/themes/builtin.js` (id, name, appearance, style, iconPack, tokens).
2. Add its id/label to `THEMES` in `src-tauri/src/settings/schema.rs` (the setting is validated in Rust).
3. `npm test` validates every built-in theme and checks that all tokens resolve.

## Icon packs

Packs map semantic ids (`settings`, `close`, `warning`, …) to either stroke paths (`modern`, 24×24) or
12×12 pixel bitmaps (`pixel`, rendered as one crisp-edged SVG path). Missing icons fall back to `modern`.
File-type and folder icons will be added to the same pack structure in Phase 4.

## Fonts

All fonts are bundled (the CSP allows only `font-src 'self'`): Pixelify Sans and VT323 for the pixel and
retro layers, JetBrains Mono for code. See [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
