// Ivily modules (Optimizer, Envora, Portly, Structura) seen through the Ivily Ecosystem Protocol.
// Nothing is queried in the background: status is read when the dashboard opens or on Refresh.
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { getSetting, setSetting } from '../../core/settings.js';
import * as ipc from '../../platform/ipc.js';

export const modulesStore = createStore({
  /** @type {any[]} */
  modules: [],
  loading: false,
  /** @type {string | null} */
  error: null,
  /** product → { method → { at, result | error } } */
  details: /** @type {Record<string, Record<string, { at: number, result?: any, error?: string }>>} */ ({}),
});

/** Read-only summaries the dashboard can request, per module (all allowlisted in the backend). */
export const SUMMARIES = {
  'ivily-optimizer': [{ method: 'health', label: 'Health' }],
  'ivily-portly': [
    { method: 'ports.summary', label: 'Ports' },
    { method: 'projects.summary', label: 'Projects' },
  ],
  'ivily-structura': [
    { method: 'projects.list', label: 'Projects' },
    { method: 'analysis.summary', label: 'Analysis of the workspace folder', needsRoot: true },
  ],
  'ivily-envora': [
    { method: 'envora.health', label: 'Health', capability: 'health' },
    { method: 'envora.profiles.summary', label: 'Profiles', capability: 'profiles.summary' },
    { method: 'envora.path.summary', label: 'PATH', capability: 'path.summary' },
    { method: 'envora.analysis.summary', label: 'Analysis', capability: 'analysis.summary' },
    { method: 'envora.workspace.projects', label: 'Projects', capability: 'workspace.projects' },
  ],
};

export const STATUS_LABEL = {
  ok: 'Connected',
  degraded: 'Degraded',
  disabled: 'Access off in the app',
  incompatible: 'Incompatible',
  notInstalled: 'Not installed',
  error: 'Not responding',
  off: 'Disabled in Ivily Center',
};

export async function loadModules(refresh = false) {
  if (!ipc.isTauri()) return;
  modulesStore.set((s) => ({ ...s, loading: true, error: null }));
  try {
    const modules = await ipc.modulesStatus(refresh);
    modulesStore.set((s) => ({ ...s, modules, loading: false }));
  } catch (e) {
    modulesStore.set((s) => ({ ...s, loading: false, error: errorCode(e) === 'ecosystem_disabled' ? 'The Ivily ecosystem integration is turned off in Settings (Ecosystem).' : errorMessage(e) }));
  }
}

export async function requestSummary(product, method, params) {
  const set = (entry) => modulesStore.set((s) => ({ ...s, details: { ...s.details, [product]: { ...(s.details[product] ?? {}), [method]: entry } } }));
  set({ at: Date.now(), loading: true });
  try {
    set({ at: Date.now(), result: await ipc.moduleRequest(product, method, params ?? null) });
  } catch (e) {
    set({ at: Date.now(), error: errorMessage(e) });
  }
}

export async function openModule(product) {
  try {
    await ipc.moduleOpen(product);
  } catch (e) {
    notify({ severity: 'error', title: 'Could not open the app', message: errorMessage(e), source: 'modules' });
  }
}

/** Turn a module on/off for Ivily Center (it is never started while off). */
export async function setModuleEnabled(product, enabled) {
  const cur = /** @type {string[]} */ (getSetting('ecosystem.disabledModules') ?? []);
  const next = enabled ? cur.filter((p) => p !== product) : [...new Set([...cur, product])];
  try {
    await setSetting('ecosystem.disabledModules', next, 'user');
    await loadModules(true);
  } catch (e) {
    notify({ severity: 'error', title: 'Could not change the module', message: errorMessage(e), source: 'modules' });
  }
}

/** Render a JSON summary as compact key/value lines for the dashboard. */
export function summarize(value, depth = 0) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) return [{ key: '', value: value.join(', ') || '—', depth }];
    return value.slice(0, 50).flatMap((v, i) => [{ key: `#${i + 1}`, value: '', depth }, ...summarize(v, depth + 1)]);
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => (v !== null && typeof v === 'object' && depth < 3 ? [{ key: k, value: '', depth }, ...summarize(v, depth + 1)] : [{ key: k, value: v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v), depth }]));
  }
  return [{ key: '', value: String(value), depth }];
}
