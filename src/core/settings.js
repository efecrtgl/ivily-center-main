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

/** @typedef {{ value: unknown, source: 'default' | 'user' | 'workspace' }} ResolvedValue */

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
 * Set a user-scope value. The backend validates; on error the previous value is restored and
 * the error (`{ code, message }`) is rethrown for the caller to display.
 * @param {string} key @param {unknown} value
 */
export async function setSetting(key, value) {
  const prev = settingsStore.get().values[key];
  settingsStore.set((s) => ({ ...s, values: { ...s.values, [key]: { value, source: 'user' } } }));
  if (!ipc.isTauri()) return value;
  try {
    const normalized = await ipc.settingsSet(key, value);
    settingsStore.set((s) => ({ ...s, values: { ...s.values, [key]: { value: normalized, source: 'user' } } }));
    return normalized;
  } catch (err) {
    settingsStore.set((s) => ({ ...s, values: { ...s.values, [key]: prev } }));
    throw err;
  }
}

/** Reset a user-scope value to its default. @param {string} key */
export async function resetSetting(key) {
  const def = settingsStore.get().schema.find((s) => s.key === key);
  if (ipc.isTauri()) await ipc.settingsReset(key);
  if (ipc.isTauri()) await refreshValues();
  else if (def) settingsStore.set((s) => ({ ...s, values: { ...s.values, [key]: { value: def.default, source: 'default' } } }));
}

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
