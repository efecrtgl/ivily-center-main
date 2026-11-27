// Workbench layout state (region visibility, sizes, active views), persisted to the app
// database under `ui.layout`. Context keys are kept in sync for `when` clauses.
import { createStore } from './store.js';
import { setContext } from './context.js';
import * as ipc from '../platform/ipc.js';

export const LAYOUT_KEY = 'ui.layout';
export const LIMITS = { sidebarWidth: [170, 640], panelHeight: [100, 900] };

/** @typedef {{ sidebarVisible: boolean, sidebarWidth: number, sidebarView: string, panelVisible: boolean, panelHeight: number, panelView: string }} Layout */

/** @type {Layout} */
export const DEFAULT_LAYOUT = {
  sidebarVisible: true,
  sidebarWidth: 260,
  sidebarView: 'explorer',
  panelVisible: false,
  panelHeight: 240,
  panelView: 'output',
};

export const layoutStore = createStore({ ...DEFAULT_LAYOUT });

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * Accept only known keys with valid types/ranges (the stored value may be from another version).
 * @param {unknown} raw
 * @returns {Layout}
 */
export function sanitizeLayout(raw) {
  const out = { ...DEFAULT_LAYOUT };
  if (!raw || typeof raw !== 'object') return out;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (typeof r.sidebarVisible === 'boolean') out.sidebarVisible = r.sidebarVisible;
  if (typeof r.panelVisible === 'boolean') out.panelVisible = r.panelVisible;
  if (Number.isFinite(r.sidebarWidth)) out.sidebarWidth = clamp(Number(r.sidebarWidth), LIMITS.sidebarWidth);
  if (Number.isFinite(r.panelHeight)) out.panelHeight = clamp(Number(r.panelHeight), LIMITS.panelHeight);
  if (typeof r.sidebarView === 'string' && r.sidebarView.length < 64) out.sidebarView = r.sidebarView;
  if (typeof r.panelView === 'string' && r.panelView.length < 64) out.panelView = r.panelView;
  return out;
}

/** @param {Partial<Layout>} patch */
export function updateLayout(patch) {
  layoutStore.set((l) => {
    const next = sanitizeLayout({ ...l, ...patch });
    return Object.keys(next).every((k) => next[k] === l[k]) ? l : next;
  });
}

function syncContext(l) {
  setContext('sidebarVisible', l.sidebarVisible);
  setContext('panelVisible', l.panelVisible);
  setContext('activeSidebarView', l.sidebarVisible ? l.sidebarView : '');
  setContext('activePanel', l.panelVisible ? l.panelView : '');
}

let saveTimer = null;

/** Load the persisted layout and start persisting changes (debounced). */
export async function initLayout() {
  if (ipc.isTauri()) {
    try {
      layoutStore.set(sanitizeLayout(await ipc.uiStateGet(LAYOUT_KEY)));
    } catch {
      /* keep defaults */
    }
  }
  syncContext(layoutStore.get());
  return layoutStore.subscribe(() => {
    const l = layoutStore.get();
    syncContext(l);
    if (!ipc.isTauri()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => ipc.uiStateSet(LAYOUT_KEY, l).catch(() => {}), 400);
  });
}

/** Show a sidebar view; toggles the sidebar off when that view is already visible. */
export function toggleSidebarView(id) {
  const l = layoutStore.get();
  if (l.sidebarVisible && l.sidebarView === id) updateLayout({ sidebarVisible: false });
  else updateLayout({ sidebarVisible: true, sidebarView: id });
}

/** Show (never hide) a panel view. */
export function showPanelView(id) {
  updateLayout({ panelVisible: true, panelView: id });
}
