// Application updates: check (manual, or once a day at startup when enabled), show what is
// available, and install only after an explicit confirmation. Verification of the download's
// signature happens in the backend (embedded public key).
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { confirmDialog } from '../../core/dialogs.js';
import { getSetting } from '../../core/settings.js';
import * as ipc from '../../platform/ipc.js';
import { flushSession } from '../../workspace/session.js';
import { hasDirty } from '../editor/model.js';

const DAY = 24 * 60 * 60 * 1000;

export const updateStore = createStore({
  /** @type {null | { currentVersion: string, lastCheck: any, history: any[], manifestUrl: string }} */
  info: null,
  checking: false,
  /** @type {null | { currentVersion: string, available: boolean, version?: string, notes?: string, date?: string, checkedAt: number }} */
  result: null,
  /** @type {string | null} */
  error: null,
  /** @type {null | { stage: string, downloaded: number, total: number }} */
  progress: null,
});

export async function loadUpdateInfo() {
  if (!ipc.isTauri()) return null;
  try {
    const info = await ipc.updateInfo();
    updateStore.set((s) => ({ ...s, info, result: s.result ?? info.lastCheck ?? null }));
    return info;
  } catch {
    return null;
  }
}

/** @param {{ quiet?: boolean }} [opts] quiet: startup check — no notification unless an update exists */
export async function checkForUpdates({ quiet = false } = {}) {
  if (!ipc.isTauri() || updateStore.get().checking) return null;
  updateStore.set((s) => ({ ...s, checking: true, error: null }));
  try {
    const result = await ipc.updateCheck();
    updateStore.set((s) => ({ ...s, checking: false, result }));
    if (result.available) {
      notify({ title: `Ivily Center ${result.version} is available`, message: 'Review the release notes and install it when convenient.', source: 'updates', actions: [{ label: 'Show update', command: 'app.showUpdates' }] });
    } else if (!quiet) {
      notify({ title: 'Ivily Center is up to date', message: `Version ${result.currentVersion}.`, source: 'updates' });
    }
    loadUpdateInfo();
    return result;
  } catch (e) {
    const message = errorCode(e) === 'not_found' ? 'No release has been published yet.' : errorMessage(e);
    updateStore.set((s) => ({ ...s, checking: false, error: message }));
    if (!quiet) notify({ severity: 'warning', title: 'Could not check for updates', message, source: 'updates' });
    loadUpdateInfo();
    return null;
  }
}

/** Startup: check at most once a day when the setting allows it. */
export async function maybeCheckOnStartup() {
  if (getSetting('updates.checkOnStartup') === false) return;
  const info = await loadUpdateInfo();
  const last = info?.history?.find((h) => h.kind === 'check')?.at ?? 0;
  if (Date.now() - last < DAY) return;
  await checkForUpdates({ quiet: true });
}

export async function installUpdate() {
  const r = updateStore.get().result;
  if (!r?.available || !r.version) return false;
  const dirty = hasDirty();
  const ok = await confirmDialog({
    title: `Install Ivily Center ${r.version}?`,
    message:
      'The update is downloaded from GitHub Releases and its signature is verified before anything is installed. Ivily Center then closes and the installer runs; your settings, workspaces and data are kept.' +
      (dirty ? ' You have unsaved changes: they are kept as recoverable drafts, but saving them first is recommended.' : ''),
    confirmLabel: 'Download and install',
  });
  if (!ok) return false;
  try {
    await flushSession();
    await ipc.updateInstall(r.version);
    return true;
  } catch (e) {
    updateStore.set((s) => ({ ...s, progress: null, error: errorMessage(e) }));
    notify({ severity: 'error', title: 'The update was not installed', message: errorMessage(e), source: 'updates' });
    loadUpdateInfo();
    return false;
  }
}

let installed = false;
export function installUpdates() {
  if (installed) return;
  installed = true;
  ipc.onEvent('update://progress', (p) => updateStore.set((s) => ({ ...s, progress: p })));
}
