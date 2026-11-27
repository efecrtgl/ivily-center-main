// Customization: settings import/export, user themes and user icon packs.
//
// Imported files are read through a backend dialog (only the file the user picked), validated
// here (themes with the same rules as built-in themes, icon paths against an SVG path grammar)
// and stored as UI state. Nothing is applied before the user confirms.
import * as ipc from '../../platform/ipc.js';
import { confirmDialog } from '../../core/dialogs.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import { quickPick } from '../../core/quickPick.js';
import { getSetting, refreshValues, settingsStore, setSetting } from '../../core/settings.js';
import { exportText } from '../../core/exportText.js';
import { uiLog } from '../../core/output.js';
import { keybindingStore } from '../../core/keybindings.js';
import { getTheme, listThemes, registerTheme, themeStore, validateTheme } from '../../theme/engine.js';
import { hasIconPack, listIconPacks, registerIconPack } from '../../icons/registry.js';
import { setActiveTheme, DEFAULT_THEME } from '../../theme/index.js';
import { replaceUserKeybindings } from '../keybindings/model.js';

export const THEME_INDEX = 'ui.themes.user';
export const PACK_INDEX = 'ui.iconPacks.user';
const themeKey = (id) => `ui.theme.${id}`;
const packKey = (id) => `ui.iconPack.${id}`;
const MAX_USER_THEMES = 50;
const MAX_ICONS = 400;
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+\-eE]{1,4000}$/;
const VIEWBOX = /^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/;
const ICON_ID = /^[a-z][a-z0-9-]{0,47}$/;

/** Make an id user-scoped: `ocean` → `user-ocean`. */
export function userId(raw) {
  const base = String(raw ?? '')
    .toLowerCase()
    .replace(/^user-/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base ? `user-${base}` : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`The file is not valid JSON: ${e.message}`);
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

/** User-scope values (not defaults, not workspace values) and user shortcuts. */
export function buildSettingsExport(values = settingsStore.get().values, keybindings = keybindingStore.get().user) {
  const settings = {};
  for (const [key, r] of Object.entries(values)) if (r && r.userValue !== undefined && r.userValue !== null) settings[key] = r.userValue;
  return { $type: 'ivily-center-settings', version: 1, exportedAt: new Date().toISOString(), settings, keybindings };
}

export function exportSettings() {
  return exportText({ title: 'Export Settings', suggestedName: 'ivily-center-settings.json', extension: 'json', content: `${JSON.stringify(buildSettingsExport(), null, 2)}\n` });
}

/**
 * Check an imported settings file against the schema. Returns what would be applied.
 * @returns {{ settings: [string, unknown][], unknown: string[], keybindings: any[] | null }}
 */
export function analyzeSettingsImport(data, schema = settingsStore.get().schema) {
  if (!data || typeof data !== 'object' || data.$type !== 'ivily-center-settings' || typeof data.settings !== 'object' || data.settings === null) {
    throw new Error('This is not an Ivily Center settings file.');
  }
  if (data.version !== 1) throw new Error(`Unsupported settings file version ${data.version}.`);
  const known = new Set(schema.map((s) => s.key));
  const settings = [];
  const unknown = [];
  for (const [k, v] of Object.entries(data.settings)) (known.has(k) ? settings : unknown).push(known.has(k) ? [k, v] : k);
  const keybindings = Array.isArray(data.keybindings) ? data.keybindings.slice(0, 500) : null;
  return { settings, unknown: /** @type {string[]} */ (unknown), keybindings };
}

export async function importSettings() {
  const file = await ipc.openTextDialog('Import Settings', ['json']);
  if (!file) return false;
  let plan;
  try {
    plan = analyzeSettingsImport(parseJson(file.content));
  } catch (e) {
    notify({ severity: 'error', title: 'Could not import settings', message: errorMessage(e), source: 'settings' });
    return false;
  }
  const ok = await confirmDialog({
    title: `Import ${plan.settings.length} setting(s)${plan.keybindings ? ` and ${plan.keybindings.length} shortcut(s)` : ''}?`,
    message:
      'Your current user values for these settings will be replaced' +
      (plan.keybindings ? ', and your custom keyboard shortcuts will be replaced by the imported ones' : '') +
      '. Workspace settings are not changed.' +
      (plan.unknown.length ? ` Unknown settings are ignored: ${plan.unknown.slice(0, 5).join(', ')}${plan.unknown.length > 5 ? '…' : ''}.` : ''),
    detail: plan.settings.map(([k, v]) => `${k} = ${JSON.stringify(v)}`.slice(0, 160)).join('\n') || '(no settings)',
    confirmLabel: 'Import',
  });
  if (!ok) return false;
  const failed = [];
  for (const [k, v] of plan.settings) {
    try {
      await setSetting(k, v, 'user');
    } catch (e) {
      failed.push(`${k}: ${errorMessage(e)}`);
    }
  }
  if (plan.keybindings) await replaceUserKeybindings(plan.keybindings);
  await refreshValues().catch(() => {});
  notify({
    severity: failed.length ? 'warning' : 'info',
    title: `Imported ${plan.settings.length - failed.length} setting(s)`,
    message: failed.length ? `Not imported: ${failed.slice(0, 3).join('; ')}` : `From ${file.name}`,
    source: 'settings',
  });
  return true;
}

// ── User themes and icon packs ──────────────────────────────────────────────

/**
 * Validate an icon pack definition (forces a `user-` id). Returns the cleaned pack or throws.
 */
export function validateIconPack(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('An icon pack must be a JSON object.');
  const id = userId(raw.id);
  if (!id) throw new Error('The icon pack needs an id.');
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 64) : id;
  const fallback = raw.fallback === 'pixel' ? 'pixel' : 'modern';
  if (!raw.icons || typeof raw.icons !== 'object') throw new Error('The icon pack has no icons.');
  const entries = Object.entries(raw.icons);
  if (entries.length > MAX_ICONS) throw new Error(`An icon pack may contain at most ${MAX_ICONS} icons.`);
  const icons = {};
  for (const [iconId, spec] of entries) {
    if (!ICON_ID.test(iconId)) throw new Error(`Invalid icon name '${iconId}'.`);
    if (spec?.kind === 'bitmap') {
      const rows = spec.rows;
      if (!Array.isArray(rows) || !rows.length || rows.length > 64 || rows.some((r) => typeof r !== 'string' || r.length !== rows[0].length || r.length > 64 || /[^#.]/.test(r))) throw new Error(`Malformed bitmap icon '${iconId}'.`);
      icons[iconId] = { kind: 'bitmap', rows: [...rows] };
    } else if (spec?.kind === 'stroke' || spec?.d) {
      const viewBox = spec.viewBox ?? '0 0 24 24';
      if (typeof spec.d !== 'string' || !PATH_D.test(spec.d)) throw new Error(`Icon '${iconId}' has an invalid path.`);
      if (typeof viewBox !== 'string' || !VIEWBOX.test(viewBox)) throw new Error(`Icon '${iconId}' has an invalid viewBox.`);
      icons[iconId] = { kind: 'stroke', viewBox, d: spec.d };
    } else {
      throw new Error(`Icon '${iconId}' must be a stroke path or a bitmap.`);
    }
  }
  return { id, name, fallback, icons };
}

/** Validate a theme for import (forces a `user-` id; unknown packs are reported). */
export function prepareTheme(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('A theme must be a JSON object.');
  const id = userId(raw.id ?? raw.name);
  if (!id) throw new Error('The theme needs an id or name.');
  const def = { id, name: String(raw.name ?? id).slice(0, 64), description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : undefined, appearance: raw.appearance, style: raw.style ?? 'modern', iconPack: raw.iconPack ?? 'modern', tokens: raw.tokens };
  const errors = validateTheme(def);
  if (errors.length) throw new Error(`The theme is not valid: ${errors.slice(0, 4).join('; ')}${errors.length > 4 ? '…' : ''}`);
  return def;
}

async function readIndex(key) {
  const v = await ipc.uiStateGet(key).catch(() => null);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/** Register stored user icon packs and themes (startup). Broken entries are skipped and logged. */
export async function loadUserCustomizations() {
  if (!ipc.isTauri()) return;
  for (const id of await readIndex(PACK_INDEX)) {
    try {
      registerIconPack(validateIconPack(await ipc.uiStateGet(packKey(id))));
    } catch (e) {
      uiLog('warn', `user icon pack ${id} skipped: ${errorMessage(e)}`);
    }
  }
  for (const id of await readIndex(THEME_INDEX)) {
    try {
      registerTheme(prepareTheme(await ipc.uiStateGet(themeKey(id))), { replace: true });
    } catch (e) {
      uiLog('warn', `user theme ${id} skipped: ${errorMessage(e)}`);
    }
  }
}

async function storeEntry(indexKey, key, id, value) {
  await ipc.uiStateSet(key(id), value);
  const index = await readIndex(indexKey);
  if (!index.includes(id)) await ipc.uiStateSet(indexKey, [...index, id]);
}

async function confirmReplace(kind, id, exists) {
  if (!exists) return true;
  return confirmDialog({ title: `Replace the ${kind} “${id}”?`, message: `A ${kind} with this id is already installed. It will be replaced.`, confirmLabel: 'Replace' });
}

export async function importTheme() {
  const file = await ipc.openTextDialog('Import Theme', ['json']);
  if (!file) return false;
  try {
    const def = prepareTheme(parseJson(file.content));
    if ((await readIndex(THEME_INDEX)).length >= MAX_USER_THEMES && !getTheme(def.id)) throw new Error(`At most ${MAX_USER_THEMES} user themes can be installed.`);
    if (!(await confirmReplace('theme', def.id, Boolean(getTheme(def.id))))) return false;
    await storeEntry(THEME_INDEX, themeKey, def.id, def);
    registerTheme(def, { replace: true });
    const use = await confirmDialog({ title: `Theme “${def.name}” installed`, message: 'Use it now?', confirmLabel: 'Use theme', cancelLabel: 'Not now' });
    if (use) await setSetting('appearance.theme', def.id, 'user');
    else if (getSetting('appearance.theme') === def.id) setActiveTheme(def.id);
    return true;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not import the theme', message: errorMessage(e), source: 'settings' });
    return false;
  }
}

export async function importIconPack() {
  const file = await ipc.openTextDialog('Import Icon Pack', ['json']);
  if (!file) return false;
  try {
    const pack = validateIconPack(parseJson(file.content));
    if (!(await confirmReplace('icon pack', pack.id, hasIconPack(pack.id)))) return false;
    await storeEntry(PACK_INDEX, packKey, pack.id, pack);
    registerIconPack(pack);
    themeStore.set((s) => ({ ...s, version: s.version + 1 }));
    notify({ title: `Icon pack “${pack.name}” installed`, message: `Use it from a theme with "iconPack": "${pack.id}" (${Object.keys(pack.icons).length} icons; missing ones fall back to ${pack.fallback}).`, source: 'settings' });
    return true;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not import the icon pack', message: errorMessage(e), source: 'settings' });
    return false;
  }
}

/** Export the active theme as a starting point for a user theme. */
export function exportCurrentTheme() {
  const t = themeStore.get().current;
  if (!t) return null;
  const def = { id: userId(`${t.id}-copy`), name: `${t.name} (copy)`, appearance: t.appearance, style: t.style, iconPack: t.iconPack, tokens: { ...t.resolved } };
  return exportText({ title: 'Export Theme', suggestedName: `${def.id}.json`, extension: 'json', content: `${JSON.stringify(def, null, 2)}\n` });
}

export async function removeUserItem() {
  const themes = listThemes().filter((t) => t.id.startsWith('user-'));
  const packs = listIconPacks().filter((p) => p.id.startsWith('user-'));
  if (!themes.length && !packs.length) return notify({ title: 'No user themes or icon packs are installed', source: 'settings' });
  const item = await quickPick({
    placeholder: 'Select a user theme or icon pack to remove',
    items: [...themes.map((t) => ({ id: `t:${t.id}`, label: t.name, description: t.id, group: 'themes' })), ...packs.map((p) => ({ id: `p:${p.id}`, label: p.name, description: p.id, group: 'icon packs' }))],
  });
  if (!item) return;
  const [kind, id] = [item.id.slice(0, 1), item.id.slice(2)];
  const ok = await confirmDialog({ title: `Remove “${item.label}”?`, message: kind === 't' ? 'Windows using it switch to the default theme.' : 'Themes using it fall back to the Modern icons after a restart.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  const indexKey = kind === 't' ? THEME_INDEX : PACK_INDEX;
  await ipc.uiStateSet(indexKey, (await readIndex(indexKey)).filter((x) => x !== id));
  await ipc.uiStateSet(kind === 't' ? themeKey(id) : packKey(id), null).catch(() => {});
  if (kind === 't' && getSetting('appearance.theme') === id) await setSetting('appearance.theme', DEFAULT_THEME, 'user');
  notify({ title: `Removed “${item.label}”`, message: kind === 't' ? undefined : 'Restart to unload it completely.', source: 'settings' });
}
