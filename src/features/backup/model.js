// Backups of Ivily Center's own data: list, create, verify, restore (staged, applied on restart),
// export/import and the automatic schedule.
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { choiceDialog, confirmDialog } from '../../core/dialogs.js';
import { getSetting } from '../../core/settings.js';
import * as ipc from '../../platform/ipc.js';
import { flushSession } from '../../workspace/session.js';

const INTERVAL = { daily: 24 * 3600 * 1000, weekly: 7 * 24 * 3600 * 1000 };

export const backupStore = createStore({
  /** @type {any[]} */
  backups: [],
  folder: '',
  restorePending: false,
  busy: /** @type {string | null} */ (null),
  /** name → 'ok' | error message */
  verified: /** @type {Record<string, string>} */ ({}),
});

export async function loadBackups() {
  if (!ipc.isTauri()) return null;
  try {
    const r = await ipc.backupList();
    backupStore.set((s) => ({ ...s, ...r }));
    return r;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not list backups', message: errorMessage(e), source: 'backup' });
    return null;
  }
}

async function busy(label, fn) {
  backupStore.set((s) => ({ ...s, busy: label }));
  try {
    return await fn();
  } finally {
    backupStore.set((s) => ({ ...s, busy: null }));
  }
}

export async function createBackup(kind = 'manual') {
  return busy('Creating a backup…', async () => {
    try {
      await flushSession();
      const name = await ipc.backupCreate(kind);
      if (kind === 'manual') notify({ title: 'Backup created', message: name, source: 'backup' });
      await loadBackups();
      return name;
    } catch (e) {
      notify({ severity: 'error', title: 'Backup failed', message: errorMessage(e), source: 'backup' });
      return null;
    }
  });
}

export async function verifyBackup(name) {
  return busy('Verifying…', async () => {
    try {
      await ipc.backupVerify(name);
      backupStore.set((s) => ({ ...s, verified: { ...s.verified, [name]: 'ok' } }));
      return true;
    } catch (e) {
      backupStore.set((s) => ({ ...s, verified: { ...s.verified, [name]: errorMessage(e) } }));
      return false;
    }
  });
}

export async function restoreBackup(b) {
  const when = b.manifest ? new Date(b.manifest.createdAt).toLocaleString() : b.name;
  const ok = await confirmDialog({
    title: `Restore the backup from ${when}?`,
    message:
      'Settings, workspaces, trust decisions, notes, extensions and drafts are replaced by the backup when Ivily Center restarts. A safety backup of the current state is made first, and the replaced files are kept in the data folder. Project files are not affected.',
    confirmLabel: 'Restore',
    danger: true,
  });
  if (!ok) return false;
  const staged = await busy('Preparing the restore…', async () => {
    try {
      await flushSession();
      await ipc.backupRestore(b.name);
      return true;
    } catch (e) {
      notify({ severity: 'error', title: 'The backup cannot be restored', message: errorMessage(e), source: 'backup' });
      return false;
    }
  });
  await loadBackups();
  if (!staged) return false;
  const choice = await choiceDialog({
    title: 'Restart to finish the restore',
    message: 'The backup was verified and will be applied when Ivily Center starts again.',
    choices: [
      { id: 'restart', label: 'Restart now', primary: true },
      { id: 'later', label: 'Later' },
    ],
  });
  if (choice === 'restart') {
    await flushSession();
    await ipc.appRestart();
  }
  return true;
}

export async function cancelRestore() {
  await ipc.backupCancelRestore().catch(() => {});
  await loadBackups();
}

export async function deleteBackup(b) {
  const ok = await confirmDialog({ title: `Delete ${b.name}?`, message: 'The backup file is deleted permanently.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await ipc.backupDelete(b.name);
  } catch (e) {
    notify({ severity: 'error', title: 'Could not delete the backup', message: errorMessage(e), source: 'backup' });
  }
  await loadBackups();
}

export async function exportBackup(b) {
  try {
    const path = await ipc.backupExport(b.name);
    if (path) notify({ title: 'Backup exported', message: path, source: 'backup' });
  } catch (e) {
    const m = errorCode(e) === 'conflict' ? /^conflict: exists:([^:]+):(.*)$/.exec(errorMessage(e)) ?? /^exists:([^:]+):(.*)$/.exec(errorMessage(e)) : null;
    if (m) {
      const ok = await confirmDialog({ title: 'Replace the existing file?', detail: m[2], confirmLabel: 'Replace', danger: true });
      if (ok) {
        const path = await ipc.backupExportConfirm(b.name, m[1]).catch((err) => notify({ severity: 'error', title: 'Export failed', message: errorMessage(err), source: 'backup' }));
        if (path) notify({ title: 'Backup exported', message: path, source: 'backup' });
      }
      return;
    }
    notify({ severity: 'error', title: 'Export failed', message: errorMessage(e), source: 'backup' });
  }
}

export async function importBackup() {
  try {
    const name = await busy('Verifying the archive…', () => ipc.backupImport());
    if (name) notify({ title: 'Backup imported', message: `${name} — restore it from the list when you are ready.`, source: 'backup' });
  } catch (e) {
    notify({ severity: 'error', title: 'The archive was not imported', message: errorMessage(e), source: 'backup' });
  }
  await loadBackups();
}

/** Startup: create an automatic backup when the schedule says it is due. */
export async function maybeAutoBackup() {
  const mode = getSetting('backup.automatic') ?? 'weekly';
  if (!INTERVAL[mode]) return;
  const r = await loadBackups();
  if (!r) return;
  const last = r.backups.filter((b) => b.manifest?.kind === 'automatic').reduce((t, b) => Math.max(t, b.manifest.createdAt), 0);
  if (Date.now() - last >= INTERVAL[mode]) await createBackup('automatic');
}
