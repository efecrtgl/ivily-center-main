import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const now = Date.now();
const list = () => ({
  folder: 'C:\\data\\app-backups',
  restorePending: false,
  backups: [
    { name: 'ivily-center-manual-20261127-100000.zip', size: 40960, manifest: { createdAt: now - 1000, kind: 'manual', files: [{ path: 'center.db' }], schemaVersion: 2, appVersion: '0.1.0' }, error: null },
    { name: 'ivily-center-automatic-20261120-100000.zip', size: 40960, manifest: { createdAt: globalThis.__lastAuto ?? now - 8 * 86400000, kind: 'automatic', files: [], schemaVersion: 2, appVersion: '0.1.0' }, error: null },
  ],
});

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  sessionSave: vi.fn(async () => {}),
  backupList: vi.fn(async () => list()),
  backupCreate: vi.fn(async (kind) => `ivily-center-${kind}-x.zip`),
  backupVerify: vi.fn(async () => ({})),
  backupRestore: vi.fn(async () => ({})),
  appRestart: vi.fn(async () => {}),
  backupDelete: vi.fn(async () => {}),
}));

const ipc = await import('../../platform/ipc.js');
const m = await import('./model.js');
const { BackupsView } = await import('./BackupsView.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { settingsStore } = await import('../../core/settings.js');

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__lastAuto = undefined;
});

describe('backups', () => {
  it('lists backups and restores only after confirmation, then offers a restart', async () => {
    await act(async () => { render(<><BackupsView /><ConfirmDialog /></>); });
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.getByText('Automatic')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Restore…' })[0]));
    expect(screen.getByRole('alertdialog', { name: /Restore the backup/ })).toBeTruthy();
    expect(ipc.backupRestore).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Restore' })));
    expect(ipc.backupRestore).toHaveBeenCalledWith('ivily-center-manual-20261127-100000.zip');
    expect(screen.getByRole('alertdialog', { name: /Restart to finish/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Later' })));
    expect(ipc.appRestart).not.toHaveBeenCalled();
  });

  it('verifies on request and shows the result', async () => {
    await act(async () => { render(<BackupsView />); });
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Verify' })[0]));
    expect(screen.getByText('Verified')).toBeTruthy();
  });

  it('creates automatic backups only when due', async () => {
    settingsStore.set({ loaded: true, schema: [], values: { 'backup.automatic': { value: 'weekly' } } });
    await m.maybeAutoBackup();
    expect(ipc.backupCreate).toHaveBeenCalledWith('automatic');
    vi.clearAllMocks();
    globalThis.__lastAuto = Date.now() - 3600000;
    await m.maybeAutoBackup();
    expect(ipc.backupCreate).not.toHaveBeenCalled();
    settingsStore.set({ loaded: true, schema: [], values: { 'backup.automatic': { value: 'off' } } });
    globalThis.__lastAuto = 0;
    await m.maybeAutoBackup();
    expect(ipc.backupCreate).not.toHaveBeenCalled();
  });
});
