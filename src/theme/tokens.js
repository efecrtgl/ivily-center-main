// Theme token schema.
//
// A token is a named design value (colour, font, radius, motion, ...). Components reference
// tokens only, through CSS custom properties (`color.surface.hover` → `--color-surface-hover`).
// Every token is either `required` in each theme or resolved from a fallback:
//   - `ref`:     another token's resolved value
//   - `value`:   a literal, or `{ dark, light }` per appearance
// Style layers (layers.js) may provide their own defaults that sit between the theme and the
// schema fallback. Resolution order: theme.tokens > layer.tokens > schema fallback.

/**
 * @typedef {object} TokenSpec
 * @property {string} name
 * @property {boolean} [required]
 * @property {string} [ref]
 * @property {string | { dark: string, light: string }} [value]
 */

const ANSI_DARK = {
  black: '#1e2127', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
  brightBlack: '#5c6370', brightRed: '#ff7b86', brightGreen: '#b5e890', brightYellow: '#ffd68a', brightBlue: '#7cc4ff', brightMagenta: '#dd94f0', brightCyan: '#6fd4e0', brightWhite: '#ffffff',
};
const ANSI_LIGHT = {
  black: '#1f2328', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0550ae', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
};

/** @type {TokenSpec[]} */
export const TOKENS = [
  // Core palette (required in every theme)
  { name: 'color.bg', required: true },
  { name: 'color.surface', required: true },
  { name: 'color.border', required: true },
  { name: 'color.fg', required: true },
  { name: 'color.fg.muted', required: true },
  { name: 'color.accent', required: true },
  { name: 'color.accent.fg', required: true },
  { name: 'color.danger', required: true },
  { name: 'color.warning', required: true },
  { name: 'color.success', required: true },
  { name: 'color.info', required: true },

  // Derived palette
  { name: 'color.bg.elevated', ref: 'color.surface' },
  { name: 'color.surface.hover', ref: 'color.surface' },
  { name: 'color.surface.active', ref: 'color.surface.hover' },
  { name: 'color.border.strong', ref: 'color.border' },
  { name: 'color.fg.subtle', ref: 'color.fg.muted' },
  { name: 'color.accent.muted', ref: 'color.surface.active' },
  { name: 'color.focus', ref: 'color.accent' },
  { name: 'color.selection', ref: 'color.accent.muted' },
  { name: 'color.overlay', value: { dark: 'rgba(0, 0, 0, 0.55)', light: 'rgba(20, 22, 30, 0.25)' } },
  { name: 'color.shadow', value: { dark: 'rgba(0, 0, 0, 0.45)', light: 'rgba(20, 22, 30, 0.16)' } },

  // Workbench regions
  { name: 'color.titlebar.bg', ref: 'color.bg' },
  { name: 'color.titlebar.fg', ref: 'color.fg' },
  { name: 'color.activitybar.bg', ref: 'color.bg' },
  { name: 'color.activitybar.fg', ref: 'color.fg.muted' },
  { name: 'color.activitybar.active', ref: 'color.accent' },
  { name: 'color.sidebar.bg', ref: 'color.surface' },
  { name: 'color.panel.bg', ref: 'color.surface' },
  { name: 'color.statusbar.bg', ref: 'color.bg' },
  { name: 'color.statusbar.fg', ref: 'color.fg.muted' },
  { name: 'color.scrollbar', ref: 'color.border.strong' },
  { name: 'color.window.close', value: '#e81123' },

  // Editor (consumed by the CodeMirror theme adapter, Phase 5)
  { name: 'editor.bg', ref: 'color.bg' },
  { name: 'editor.fg', ref: 'color.fg' },
  { name: 'editor.lineHighlight', ref: 'color.surface.hover' },
  { name: 'editor.selection', ref: 'color.selection' },
  { name: 'editor.cursor', ref: 'color.accent' },
  { name: 'editor.gutter.fg', ref: 'color.fg.subtle' },
  { name: 'syntax.keyword', ref: 'color.accent' },
  { name: 'syntax.string', ref: 'color.success' },
  { name: 'syntax.number', ref: 'color.warning' },
  { name: 'syntax.comment', ref: 'color.fg.subtle' },
  { name: 'syntax.function', ref: 'color.info' },
  { name: 'syntax.type', ref: 'color.warning' },
  { name: 'syntax.variable', ref: 'color.fg' },
  { name: 'syntax.operator', ref: 'color.fg.muted' },

  // Terminal (consumed by the xterm.js theme adapter, Phase 8)
  { name: 'terminal.bg', ref: 'editor.bg' },
  { name: 'terminal.fg', ref: 'editor.fg' },
  { name: 'terminal.cursor', ref: 'editor.cursor' },
  { name: 'terminal.selection', ref: 'editor.selection' },
  ...Object.keys(ANSI_DARK).map((k) => ({ name: `terminal.ansi.${k}`, value: { dark: ANSI_DARK[k], light: ANSI_LIGHT[k] } })),

  // Typography
  { name: 'font.ui', value: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif" },
  { name: 'font.display', ref: 'font.ui' },
  { name: 'font.mono', value: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace" },
  { name: 'font.scale', value: '1' },
  { name: 'font.weight.strong', value: '600' },
  { name: 'font.letterSpacing', value: 'normal' },

  // Shape, depth and motion
  { name: 'radius.sm', value: '4px' },
  { name: 'radius.md', value: '6px' },
  { name: 'radius.lg', value: '10px' },
  { name: 'border.width', value: '1px' },
  { name: 'shadow.popup', value: { dark: '0 8px 28px rgba(0, 0, 0, 0.5)', light: '0 8px 28px rgba(20, 22, 30, 0.14)' } },
  { name: 'surface.blur', value: '0px' },
  // Background image layers drawn behind the whole app (no colour: color.bg is appended).
  { name: 'backdrop', value: 'none' },
  { name: 'motion.duration', value: '140ms' },
  { name: 'motion.easing', value: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
];

export const TOKEN_NAMES = new Set(TOKENS.map((t) => t.name));

/** `color.surface.hover` → `--color-surface-hover` */
export const cssVar = (name) => `--${name.replace(/\./g, '-')}`;
