// Keyboard shortcuts.
//
// A binding maps a normalized key chord (e.g. `Ctrl+Shift+P`) to a command, optionally with a
// `when` clause and arguments. Default bindings come from features; user bindings (Phase 10
// editor) are layered on top. A user binding whose command starts with `-` removes the matching
// default, as in `{ key: 'Ctrl+B', command: '-workbench.toggleSidebar' }`.
//
// Keys are identified by physical position (`KeyboardEvent.code`) so shortcuts are stable across
// keyboard layouts; the displayed label uses the US layout name of that key.
import { createStore } from './store.js';
import { evaluateWhen } from './context.js';
import { executeCommand, hasCommand } from './commands.js';

/**
 * @typedef {object} Keybinding
 * @property {string} key       Chord, e.g. `Ctrl+Shift+P`.
 * @property {string} command   Command id (or `-id` in user bindings to remove a default).
 * @property {string} [when]
 * @property {unknown} [args]
 */

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const ALIASES = {
  control: 'Ctrl', ctrl: 'Ctrl', cmd: 'Meta', win: 'Meta', meta: 'Meta', super: 'Meta',
  alt: 'Alt', option: 'Alt', shift: 'Shift', esc: 'Escape', escape: 'Escape', return: 'Enter',
  enter: 'Enter', del: 'Delete', delete: 'Delete', space: 'Space', tab: 'Tab', backspace: 'Backspace',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', plus: '=', minus: '-',
};
const CODE_TO_KEY = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Space: 'Space',
  NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract', NumpadMultiply: 'NumpadMultiply',
  NumpadDivide: 'NumpadDivide', NumpadEnter: 'Enter', NumpadDecimal: 'NumpadDecimal',
};
const NAMED = new Set([
  'Escape', 'Enter', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** Normalize a key part (non-modifier). Returns null when unknown. */
function normalizeKey(part) {
  const lower = part.toLowerCase();
  if (ALIASES[lower] && !MODIFIERS.includes(ALIASES[lower])) return ALIASES[lower];
  if (/^[a-z0-9]$/i.test(part)) return part.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(part)) return part.toUpperCase();
  if (/^numpad[0-9]$/i.test(part)) return `Numpad${part.slice(-1)}`;
  const mapped = Object.values(CODE_TO_KEY).find((k) => k.toLowerCase() === lower);
  if (mapped) return mapped;
  for (const n of NAMED) if (n.toLowerCase() === lower) return n;
  return null;
}

/**
 * Normalize a chord string: canonical modifier order and key names. Returns null if invalid.
 * `ctrl+shift+p` → `Ctrl+Shift+P`; `shift + ctrl + ,` → `Ctrl+Shift+,`.
 * @param {string} chord
 * @returns {string | null}
 */
export function normalizeChord(chord) {
  if (typeof chord !== 'string') return null;
  // '+' separates parts, so the plus key itself is written as "=" (main row) or "NumpadAdd".
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    const alias = ALIASES[p.toLowerCase()];
    if (alias && MODIFIERS.includes(alias)) {
      mods.add(alias);
      continue;
    }
    if (key !== null) return null; // two non-modifier keys
    key = normalizeKey(p);
    if (key === null) return null;
  }
  if (key === null) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+');
}

/**
 * Chord for a keyboard event, or null for lone modifier presses.
 * @param {Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>} e
 */
export function chordFromEvent(e) {
  let key = null;
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = code;
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (CODE_TO_KEY[code]) key = CODE_TO_KEY[code];
  else if (NAMED.has(code)) key = code;
  else if (NAMED.has(e.key)) key = e.key;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

/** @type {import('./store.js').Store<{ defaults: Keybinding[], user: Keybinding[] }>} */
export const keybindingStore = createStore({ defaults: [], user: [] });

/**
 * Add default bindings (from a feature). Invalid chords throw — defaults are code, not input.
 * @param {Keybinding[]} bindings
 * @returns {() => void} disposer
 */
export function registerDefaultKeybindings(bindings) {
  const normalized = bindings.map((b) => {
    const key = normalizeChord(b.key);
    if (!key) throw new Error(`Invalid default keybinding '${b.key}' for ${b.command}`);
    return { ...b, key };
  });
  keybindingStore.set((s) => ({ ...s, defaults: [...s.defaults, ...normalized] }));
  return () => keybindingStore.set((s) => ({ ...s, defaults: s.defaults.filter((b) => !normalized.includes(b)) }));
}

/**
 * Replace user bindings. Returns entries that were rejected (invalid chord or shape).
 * @param {unknown} list
 * @returns {{ accepted: Keybinding[], rejected: unknown[] }}
 */
export function setUserKeybindings(list) {
  const accepted = [];
  const rejected = [];
  for (const b of Array.isArray(list) ? list : []) {
    const key = b && typeof b === 'object' ? normalizeChord(b.key) : null;
    if (!key || typeof b.command !== 'string' || !b.command || (b.when !== undefined && typeof b.when !== 'string')) {
      rejected.push(b);
      continue;
    }
    accepted.push({ key, command: b.command, when: b.when, args: b.args });
  }
  keybindingStore.set((s) => ({ ...s, user: accepted }));
  return { accepted, rejected };
}

/**
 * Effective bindings: defaults minus removed ones, then user bindings (which take precedence).
 * @param {{ defaults: Keybinding[], user: Keybinding[] }} [state]
 * @returns {(Keybinding & { source: 'default' | 'user' })[]}
 */
export function effectiveKeybindings(state = keybindingStore.get()) {
  const removals = state.user.filter((b) => b.command.startsWith('-'));
  const defaults = state.defaults
    .filter((d) => !removals.some((r) => r.command.slice(1) === d.command && r.key === d.key))
    .map((b) => ({ ...b, source: /** @type {const} */ ('default') }));
  const user = state.user
    .filter((b) => !b.command.startsWith('-'))
    .map((b) => ({ ...b, source: /** @type {const} */ ('user') }));
  return [...defaults, ...user];
}

/**
 * The binding that handles `chord` in the given context: last matching entry wins, so user
 * bindings override defaults.
 * @param {string} chord
 * @param {Record<string, unknown>} [ctx]
 */
export function resolveKeybinding(chord, ctx) {
  const list = effectiveKeybindings();
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (b.key === chord && hasCommand(b.command) && evaluateWhen(b.when, ctx)) return b;
  }
  return null;
}

/** First chord bound to a command (for display next to menu items / palette entries). */
export function keybindingFor(commandId) {
  const list = effectiveKeybindings();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].command === commandId && !list[i].args) return list[i].key;
  return null;
}

/**
 * Bindings that share a chord and an identical `when` clause — only the last one can ever fire.
 * @returns {{ key: string, when: string, commands: string[] }[]}
 */
export function findConflicts(list = effectiveKeybindings()) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const b of list) {
    const id = `${b.key}\u0000${(b.when || '').replace(/\s+/g, '')}`;
    groups.set(id, [...(groups.get(id) || []), b.command]);
  }
  return [...groups.entries()]
    .filter(([, cmds]) => new Set(cmds).size > 1)
    .map(([id, cmds]) => {
      const [key, when] = id.split('\u0000');
      return { key, when, commands: [...new Set(cmds)] };
    });
}

const isTextInput = (el) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes(/** @type {HTMLInputElement} */ (el).type)) || el.tagName === 'SELECT');

/**
 * Install the global shortcut dispatcher. Chords without Ctrl/Alt/Meta (plain typing, Shift+X)
 * and editing keys are ignored inside text inputs so typing is never hijacked.
 * @param {Window} [target]
 */
export function installKeybindingDispatcher(target = window) {
  const onKeyDown = (/** @type {KeyboardEvent} */ e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const chord = chordFromEvent(e);
    if (!chord) return;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (plain && isTextInput(e.target) && !/^F\d/.test(chord.split('+').pop())) return;
    const binding = resolveKeybinding(chord);
    if (!binding) return;
    e.preventDefault();
    e.stopPropagation();
    executeCommand(binding.command, binding.args);
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
