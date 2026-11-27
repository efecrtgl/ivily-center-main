// Settings client. The schema and validation live in Rust (single source of truth); this module
// caches the schema and resolved values, applies optimistic UI updates and exposes search.
import { createStore, useStore } from './store.js';
import * as ipc from '../platform/ipc.js';

/**
 * @typedef {object} SettingSchema
 * @property {string} key
 * @property {string} title
 * @property {string} description
 * @property {string} category
 * @property {'boolean' | 'enum' | 'integer' | 'string'} type
 * @property {{ value: string, label: string }[]} [options]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [maxLength]
 * @property {unknown} default
 * @property {('user' | 'workspace')[]} scopes
 */

/** @typedef {{ value: unknown, source: 'default' | 'user' | 'workspace', userValue?: unknown, workspaceValue?: unknown }} ResolvedValue */
/** @typedef {'user' | 'workspace'} SettingScope */

/** @type {import('./store.js').Store<{ loaded: boolean, schema: SettingSchema[], values: Record<string, ResolvedValue> }>} */
export const settingsStore = createStore({ loaded: false, schema: [], values: {} });

/** Default values from the schema (used before load and outside Tauri). */
function defaultsFrom(schema) {
  return Object.fromEntries(schema.map((s) => [s.key, { value: s.default, source: 'default' }]));
}

/** Load schema and values. Outside Tauri (tests, browser preview) only `fallbackSchema` is used. */
export async function loadSettings(fallbackSchema = []) {
  if (!ipc.isTauri()) {
    settingsStore.set({ loaded: true, schema: fallbackSchema, values: defaultsFrom(fallbackSchema) });
    return;
  }
  const [schema, resolved] = await Promise.all([ipc.settingsSchema(), ipc.settingsValues()]);
  settingsStore.set({ loaded: true, schema, values: { ...defaultsFrom(schema), ...resolved.values } });
  return resolved;
}

/** Re-read values (after an external change, e.g. another window). */
export async function refreshValues() {
  if (!ipc.isTauri()) return;
  const resolved = await ipc.settingsValues();
  settingsStore.set((s) => ({ ...s, values: { ...s.values, ...resolved.values } }));
}

/** @param {string} key */
export const getSetting = (key) => settingsStore.get().values[key]?.value;

/** React hook for one setting value. @param {string} key */
export const useSetting = (key) => useStore(settingsStore, (s) => s.values[key]?.value);

/**
 * Set a value in the user scope or in the current window's workspace. The backend validates
 * (and, for workspace files, refuses to overwrite external changes); errors (`{ code, message }`)
 * are rethrown for the caller to display. Resolved values are re-read afterwards because a
 * workspace value may still override a changed user value.
 * @param {string} key @param {unknown} value @param {SettingScope} [scope]
 */
export async function setSetting(key, value, scope = 'user') {
  if (!ipc.isTauri()) {
    settingsStore.set((s) => ({ ...s, values: { ...s.values, [key]: { value, source: scope } } }));
    return value;
  }
  const normalized = await ipc.settingsSet(key, value, scope);
  await refreshValues();
  return normalized;
}

/** Remove a value from a scope so the next lower layer applies. @param {string} key @param {SettingScope} [scope] */
export async function resetSetting(key, scope = 'user') {
  if (ipc.isTauri()) {
    await ipc.settingsReset(key, scope);
    await refreshValues();
    return;
  }
  const def = settingsStore.get().schema.find((s) => s.key === key);
  if (def) settingsStore.set((s) => ({ ...s, values: { ...s.values, [key]: { value: def.default, source: 'default' } } }));
}

/** Settings that may be set per workspace. @param {SettingSchema[]} schema */
export const workspaceScoped = (schema) => schema.filter((s) => s.scopes.includes('workspace'));

/**
 * Search settings. Every whitespace-separated term must match the key, title, description,
 * category or an option label (case-insensitive). `@modified` limits to non-default values.
 * @param {SettingSchema[]} schema
 * @param {string} query
 * @param {Record<string, ResolvedValue>} [values]
 */
export function searchSettings(schema, query, values = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const modifiedOnly = terms.includes('@modified');
  const words = terms.filter((t) => t !== '@modified');
  return schema.filter((s) => {
    if (modifiedOnly && (values[s.key]?.source ?? 'default') === 'default') return false;
    const hay = [s.key, s.title, s.description, s.category, ...(s.options || []).map((o) => o.label)].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Group settings by category, preserving schema order. @param {SettingSchema[]} list */
export function groupByCategory(list) {
  /** @type {Map<string, SettingSchema[]>} */
  const groups = new Map();
  for (const s of list) groups.set(s.category, [...(groups.get(s.category) || []), s]);
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}
