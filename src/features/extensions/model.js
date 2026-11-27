// Declarative extensions: installed copies live in the app data folder (backend); this module
// validates and applies their contributions — themes, icon packs, snippets, keyboard shortcuts for
// existing commands and file associations. Extensions never run code.
import { EditorState } from '@codemirror/state';
import { snippetCompletion } from '@codemirror/autocomplete';
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import { confirmDialog } from '../../core/dialogs.js';
import { uiLog } from '../../core/output.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { normalizeChord, registerDefaultKeybindings } from '../../core/keybindings.js';
import { hasCommand } from '../../core/commands.js';
import * as ipc from '../../platform/ipc.js';
import { getTheme, registerTheme, unregisterTheme } from '../../theme/engine.js';
import { DEFAULT_THEME, setActiveTheme } from '../../theme/index.js';
import { registerIconPack, unregisterIconPack } from '../../icons/registry.js';
import { languageById, registerLanguage } from '../../languages/registry.js';
import { getDoc, registerEditorExtension } from '../editor/model.js';
import { prepareTheme, validateIconPack } from '../customize/model.js';

export const extensionsStore = createStore({
  /** @type {any[]} */
  installed: [],
  /** @type {string[]} */
  issues: [],
  /** @type {string[]} */
  recommendations: [],
  /** extension id → contribution problems */
  problems: /** @type {Record<string, string[]>} */ ({}),
  loaded: false,
});

/** language id → snippets */
const snippets = new Map();
/** Disposers of applied contributions. */
let disposers = [];

const slug = (id) => id.replace(/\./g, '-');

/** Convert a VS Code snippet body to CodeMirror template syntax. */
export function toTemplate(body) {
  const text = Array.isArray(body) ? body.join('\n') : String(body ?? '');
  return text
    .replace(/\$\{(\d+)\|([^|}]*)[^}]*\|\}/g, (_, n, first) => `\${${n}:${first.split(',')[0]}}`) // choices → first option
    .replace(/\$\{([A-Z_]+)(?::([^}]*))?\}/g, (_, _v, def) => def ?? '') // variables → default
    .replace(/\$([A-Z_]+)/g, '') // bare variables
    .replace(/\$(\d+)/g, (_, n) => `\${${n}}`);
}

/** Parse a snippets file into `{ prefix, template, description }[]`. */
export function parseSnippets(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  for (const [name, s] of Object.entries(json).slice(0, 2000)) {
    if (!s || typeof s !== 'object' || s.body == null) continue;
    const prefixes = Array.isArray(s.prefix) ? s.prefix : [s.prefix ?? name];
    const template = toTemplate(s.body);
    if (template.length > 20000) continue;
    for (const p of prefixes) if (typeof p === 'string' && p.trim() && p.length <= 60) out.push({ prefix: p.trim(), template, description: typeof s.description === 'string' ? s.description.slice(0, 200) : name });
  }
  return out;
}

function snippetSource(key) {
  return (ctx) => {
    const lang = getDoc(key)?.languageId;
    const list = lang ? snippets.get(lang) : null;
    if (!list?.length) return null;
    const word = ctx.matchBefore(/[\w.@-]+/);
    if (!word && !ctx.explicit) return null;
    return {
      from: word ? word.from : ctx.pos,
      options: list.map((s) => snippetCompletion(s.template, { label: s.prefix, detail: s.description, type: 'text', boost: -1 })),
      validFor: /^[\w.@-]*$/,
    };
  };
}

/** Summary of what an extension contributes (for the install dialog and the view). */
export function describeContributions(c = {}) {
  const parts = [];
  if (c.themes?.length) parts.push(`${c.themes.length} theme(s)`);
  if (c.iconPacks?.length) parts.push(`${c.iconPacks.length} icon pack(s)`);
  if (c.snippets?.length) parts.push(`snippets for ${[...new Set(c.snippets.map((s) => s.language))].join(', ')}`);
  if (c.keybindings?.length) parts.push(`${c.keybindings.length} keyboard shortcut(s): ${c.keybindings.slice(0, 4).map((k) => `${k.key} → ${k.command}`).join(', ')}${c.keybindings.length > 4 ? '…' : ''}`);
  if (c.languages?.length) parts.push(`file associations: ${c.languages.map((l) => `${l.extensions.join(' ')} → ${l.id}`).join(', ')}`);
  return parts.length ? parts : ['nothing'];
}

function parseFile(ext, rel) {
  const text = ext.files[rel];
  if (text == null) throw new Error(`missing ${rel}`);
  return JSON.parse(text.replace(/^﻿/, ''));
}

/** Apply the contributions of one enabled extension. Returns problems (never throws). */
function apply(ext) {
  const m = ext.manifest;
  const c = m.contributes ?? {};
  const problems = [];
  const s = slug(m.id);
  for (const rel of c.iconPacks ?? []) {
    try {
      const raw = parseFile(ext, rel);
      const pack = validateIconPack({ ...raw, id: `${s}-${raw.id ?? 'icons'}` });
      registerIconPack(pack);
      disposers.push(() => unregisterIconPack(pack.id));
    } catch (e) {
      problems.push(`${rel}: ${errorMessage(e)}`);
    }
  }
  for (const rel of c.themes ?? []) {
    try {
      const raw = parseFile(ext, rel);
      const iconPack = typeof raw.iconPack === 'string' && !['modern', 'pixel'].includes(raw.iconPack) && !raw.iconPack.startsWith('user-') ? `user-${s}-${raw.iconPack}` : raw.iconPack;
      const def = prepareTheme({ ...raw, id: `${s}-${raw.id ?? raw.name}`, iconPack });
      registerTheme({ ...def, description: def.description ?? `From ${m.name}` }, { replace: true });
      disposers.push(() => unregisterTheme(def.id));
    } catch (e) {
      problems.push(`${rel}: ${errorMessage(e)}`);
    }
  }
  for (const sn of c.snippets ?? []) {
    try {
      const list = parseSnippets(parseFile(ext, sn.path));
      const cur = snippets.get(sn.language) ?? [];
      snippets.set(sn.language, [...cur, ...list]);
      disposers.push(() => snippets.set(sn.language, (snippets.get(sn.language) ?? []).filter((x) => !list.includes(x))));
    } catch (e) {
      problems.push(`${sn.path}: ${errorMessage(e)}`);
    }
  }
  const keys = [];
  for (const k of c.keybindings ?? []) {
    const chord = normalizeChord(k.key);
    if (!chord) problems.push(`invalid shortcut '${k.key}'`);
    else if (!hasCommand(k.command)) problems.push(`shortcut ${k.key}: unknown command '${k.command}'`);
    else keys.push({ key: chord, command: k.command, ...(k.when ? { when: k.when } : {}) });
  }
  if (keys.length) disposers.push(registerDefaultKeybindings(keys));
  for (const l of c.languages ?? []) {
    const p = languageById(l.id);
    if (!p) {
      problems.push(`unknown language '${l.id}'`);
      continue;
    }
    const exts = l.extensions.map((e) => e.replace(/^\./, '').toLowerCase()).filter((e) => !(p.extensions ?? []).includes(e));
    if (!exts.length) continue;
    registerLanguage({ ...p, extensions: [...(p.extensions ?? []), ...exts] });
    disposers.push(() => {
      const cur = languageById(l.id);
      if (cur) registerLanguage({ ...cur, extensions: (cur.extensions ?? []).filter((e) => !exts.includes(e)) });
    });
  }
  return problems;
}

/** (Re)load installed extensions and apply the enabled ones. */
export async function loadExtensions() {
  if (!ipc.isTauri()) return;
  let r;
  try {
    r = await ipc.extensionsList();
  } catch (e) {
    uiLog('warn', `extensions could not be listed: ${errorMessage(e)}`);
    return;
  }
  for (const d of disposers.reverse()) {
    try {
      d();
    } catch {
      /* best effort */
    }
  }
  disposers = [];
  const problems = {};
  for (const ext of r.installed) if (ext.enabled) {
    const p = apply(ext);
    if (p.length) {
      problems[ext.manifest.id] = p;
      uiLog('warn', `extension ${ext.manifest.id}: ${p.join('; ')}`);
    }
  }
  extensionsStore.set({ installed: r.installed, issues: r.issues, recommendations: r.recommendations, problems, loaded: true });
  // A theme that disappeared falls back to the default.
  const theme = getSetting('appearance.theme');
  if (typeof theme === 'string' && theme.startsWith('user-') && !getTheme(theme)) setActiveTheme(DEFAULT_THEME);
}

export async function installExtension() {
  try {
    const preview = await ipc.extensionsInstallDialog();
    if (!preview) return false;
    const m = preview.manifest;
    const ok = await confirmDialog({
      title: `${preview.replaces ? 'Update' : 'Install'} “${m.name}” ${m.version}?`,
      message:
        `${m.publisher ? `Publisher: ${m.publisher}. ` : ''}${m.description ? `${m.description} ` : ''}` +
        (preview.replaces ? `Replaces version ${preview.replaces}. ` : '') +
        'Extensions are declarative: they cannot run code, access files or the network. It contributes:',
      detail: [...describeContributions(m.contributes), '', `Files copied: ${preview.files.length ? preview.files.join(', ') : 'manifest only'}`].join('\n'),
      confirmLabel: preview.replaces ? 'Update' : 'Install',
    });
    if (!ok) return false;
    await ipc.extensionsInstallConfirm(preview.token);
    await loadExtensions();
    notify({ title: `Installed “${m.name}”`, source: 'extensions' });
    return true;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not install the extension', message: errorMessage(e), source: 'extensions' });
    return false;
  }
}

export async function setExtensionEnabled(id, enabled) {
  try {
    await ipc.extensionsSetEnabled(id, enabled);
    await loadExtensions();
  } catch (e) {
    notify({ severity: 'error', title: 'Could not change the extension', message: errorMessage(e), source: 'extensions' });
  }
}

export async function uninstallExtension(ext) {
  const ok = await confirmDialog({ title: `Remove “${ext.manifest.name}”?`, message: 'The installed copy is deleted from Ivily Center; the folder you installed it from is not touched.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  try {
    await ipc.extensionsUninstall(ext.manifest.id);
    if (String(getSetting('appearance.theme')).startsWith(`user-${slug(ext.manifest.id)}-`)) await setSetting('appearance.theme', DEFAULT_THEME, 'user');
    await loadExtensions();
  } catch (e) {
    notify({ severity: 'error', title: 'Could not remove the extension', message: errorMessage(e), source: 'extensions' });
  }
}

let installed = false;
export function installExtensions() {
  if (installed) return;
  installed = true;
  registerEditorExtension((key) => EditorState.languageData.of(() => [{ autocomplete: snippetSource(key) }]));
}

/** @internal for tests */
export const _snippetsFor = (lang) => snippets.get(lang) ?? [];
