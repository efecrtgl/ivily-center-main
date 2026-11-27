import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  sessionSave: vi.fn(async () => {}),
  updateInfo: vi.fn(async () => ({ currentVersion: '0.1.0', lastCheck: null, history: globalThis.__history ?? [], manifestUrl: 'x' })),
  updateCheck: vi.fn(async () => ({ currentVersion: '0.1.0', available: true, version: '0.2.0', notes: '## New\n\n- faster <script>x</script>', date: '2027-01-01', checkedAt: 1 })),
  updateInstall: vi.fn(async () => {}),
  openExternalUrl: vi.fn(async () => {}),
}));

const ipc = await import('../../platform/ipc.js');
const m = await import('./model.js');
const { UpdatesView } = await import('./UpdatesView.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { settingsStore } = await import('../../core/settings.js');

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__history = [];
  m.updateStore.set((s) => ({ ...s, result: null, error: null, checking: false, progress: null }));
});

describe('updates', () => {
  it('checks, shows sanitized notes and installs only after confirmation', async () => {
    await act(async () => { render(<><UpdatesView /><ConfirmDialog /></>); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Check for Updates/ })));
    expect(screen.getByText('Ivily Center 0.2.0')).toBeTruthy();
    expect(screen.getByText('faster')).toBeTruthy();
    expect(document.querySelector('.update-notes script')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download and Install' })));
    expect(screen.getByRole('alertdialog', { name: /Install Ivily Center 0.2.0/ })).toBeTruthy();
    expect(ipc.updateInstall).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download and install' })));
    expect(ipc.updateInstall).toHaveBeenCalledWith('0.2.0');
  });

  it('startup check respects the setting and runs at most once a day', async () => {
    settingsStore.set({ loaded: true, schema: [], values: { 'updates.checkOnStartup': { value: false } } });
    await m.maybeCheckOnStartup();
    expect(ipc.updateCheck).not.toHaveBeenCalled();
    settingsStore.set({ loaded: true, schema: [], values: { 'updates.checkOnStartup': { value: true } } });
    globalThis.__history = [{ kind: 'check', at: Date.now() - 1000 }];
    await m.maybeCheckOnStartup();
    expect(ipc.updateCheck).not.toHaveBeenCalled();
    globalThis.__history = [{ kind: 'check', at: Date.now() - 2 * 86400000 }];
    await m.maybeCheckOnStartup();
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
  });

  it('reports a missing release calmly', async () => {
    ipc.updateCheck.mockRejectedValueOnce({ code: 'not_found', message: 'no release has been published yet' });
    await m.checkForUpdates({ quiet: true });
    expect(m.updateStore.get().error).toBe('No release has been published yet.');
  });
});
