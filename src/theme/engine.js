// Theme engine: registration, validation, token resolution and application.
//
// Applying a theme only writes CSS custom properties and `data-*` attributes on the root element
// and updates `themeStore`. It never touches application state, so switching themes keeps
// workspaces, editors, terminals and every other subsystem exactly as they were.
import { createStore } from '../core/store.js';
import { TOKENS, TOKEN_NAMES, cssVar } from './tokens.js';
import { getStyleLayer } from './layers.js';
import { hasIconPack } from '../icons/registry.js';

/**
 * @typedef {object} ThemeDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {'dark' | 'light'} appearance
 * @property {string} style      Style layer id (layers.js).
 * @property {string} iconPack   Icon pack id (icons/registry.js).
 * @property {Record<string, string>} tokens
 */

/** @typedef {ThemeDefinition & { resolved: Record<string, string> }} ResolvedTheme */

// Token values are plain CSS values. They may not load resources or escape the declaration, so
// future third-party (extension) themes cannot inject CSS or fetch remote content.
const FORBIDDEN_VALUE = /url\s*\(|expression\s*\(|javascript:|@import|[;{}<>\\]|\/\*/i;
const MAX_VALUE_LENGTH = 400;

/** @type {Map<string, ThemeDefinition>} */
const themes = new Map();

/** @type {import('../core/store.js').Store<{ current: ResolvedTheme | null, version: number }>} */
export const themeStore = createStore({ current: null, version: 0 });

/**
 * Validate a theme definition. Returns a list of problems (empty when valid).
 * @param {any} def
 * @returns {string[]}
 */
export function validateTheme(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['theme must be an object'];
  if (typeof def.id !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(def.id)) errors.push('id must be 2–48 chars of a-z, 0-9, -');
  if (typeof def.name !== 'string' || !def.name.trim() || def.name.length > 64) errors.push('name is required (≤ 64 chars)');
  if (def.appearance !== 'dark' && def.appearance !== 'light') errors.push("appearance must be 'dark' or 'light'");
  if (!getStyleLayer(def.style)) errors.push(`unknown style layer '${def.style}'`);
  if (!hasIconPack(def.iconPack)) errors.push(`unknown icon pack '${def.iconPack}'`);
  if (!def.tokens || typeof def.tokens !== 'object') {
    errors.push('tokens must be an object');
    return errors;
  }
  for (const t of TOKENS) if (t.required && !(t.name in def.tokens)) errors.push(`missing required token '${t.name}'`);
  for (const [name, value] of Object.entries(def.tokens)) {
    if (!TOKEN_NAMES.has(name)) errors.push(`unknown token '${name}'`);
    else if (typeof value !== 'string' || !value.trim() || value.length > MAX_VALUE_LENGTH) errors.push(`token '${name}' must be a non-empty string`);
    else if (FORBIDDEN_VALUE.test(value)) errors.push(`token '${name}' contains a forbidden construct`);
  }
  return errors;
}

/**
 * Register a theme (built-in now; extension-contributed later through the same path).
 * @param {ThemeDefinition} def
 * @param {{ replace?: boolean }} [opts]
 */
export function registerTheme(def, { replace = false } = {}) {
  const errors = validateTheme(def);
  if (errors.length) throw new Error(`Invalid theme '${def?.id}': ${errors.join('; ')}`);
  if (themes.has(def.id) && !replace) throw new Error(`Theme already registered: ${def.id}`);
  themes.set(def.id, Object.freeze({ ...def, tokens: Object.freeze({ ...def.tokens }) }));
  themeStore.set((s) => ({ ...s, version: s.version + 1 }));
}

export const getTheme = (id) => themes.get(id);
export const listThemes = () => [...themes.values()];

/**
 * Resolve every token for a theme: theme value > style-layer default > schema fallback.
 * @param {ThemeDefinition} def
 * @returns {Record<string, string>}
 */
export function resolveTokens(def) {
  const layer = getStyleLayer(def.style)?.tokens || {};
  /** @type {Record<string, string>} */
  const out = {};
  const specs = new Map(TOKENS.map((t) => [t.name, t]));
  const visiting = new Set();
  const resolve = (name) => {
    if (name in out) return out[name];
    if (visiting.has(name)) throw new Error(`Token reference cycle at ${name}`);
    visiting.add(name);
    const spec = specs.get(name);
    let v = def.tokens[name] ?? layer[name];
    if (v === undefined && spec?.ref) v = resolve(spec.ref);
    if (v === undefined && spec?.value !== undefined) v = typeof spec.value === 'string' ? spec.value : spec.value[def.appearance];
    if (v === undefined) throw new Error(`Token ${name} has no value in theme ${def.id}`);
    visiting.delete(name);
    out[name] = v;
    return v;
  };
  for (const t of TOKENS) resolve(t.name);
  return out;
}

/**
 * Apply a theme to the document. Unknown ids fall back to `fallbackId`.
 * @param {string} id
 * @param {{ root?: HTMLElement, fallbackId?: string }} [opts]
 * @returns {ResolvedTheme}
 */
export function applyTheme(id, { root = document.documentElement, fallbackId = 'modern-dark' } = {}) {
  const def = themes.get(id) || themes.get(fallbackId);
  if (!def) throw new Error(`No theme '${id}' and no fallback '${fallbackId}'`);
  const resolved = resolveTokens(def);
  for (const [name, value] of Object.entries(resolved)) root.style.setProperty(cssVar(name), value);
  root.dataset.theme = def.id;
  root.dataset.style = def.style;
  root.dataset.appearance = def.appearance;
  root.dataset.iconPack = def.iconPack;
  root.style.colorScheme = def.appearance;
  const current = { ...def, resolved };
  themeStore.set((s) => ({ ...s, current }));
  return current;
}

/** Resolved value of a token in the active theme (for canvas/editor/terminal adapters). */
export function token(name) {
  return themeStore.get().current?.resolved[name];
}

/** Test helper. */
export function _resetThemes() {
  themes.clear();
  themeStore.set({ current: null, version: 0 });
}
