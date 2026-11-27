import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modules = [
  { product: 'ivily-optimizer', name: 'Ivily Optimizer', description: 'Cleanup', repository: 'https://github.com/efecrtgl/ivily-optimizer', path: 'C:\\o.exe', version: '0.3.0', status: 'ok', message: null, checkedAt: 1, info: { protocol: '0.1.0', capabilities: [{ id: 'app.health', status: 'available' }, { id: 'system.insights', status: 'planned' }], health: { status: 'ok', database: 'ok' }, activity: { total: 4 } } },
  { product: 'ivily-envora', name: 'Ivily Envora', description: 'Env', repository: 'https://github.com/efecrtgl/ivily-envora', path: 'C:\\e.exe', version: '0.1.0', status: 'disabled', message: 'Ecosystem access is turned off in Ivily Envora (Settings → Ecosystem).', checkedAt: 1, info: { protocol: 'envora-1', capabilities: [{ id: 'health', status: 'notGranted' }], granted: [] } },
  { product: 'ivily-portly', name: 'Ivily Portly', description: 'Ports', repository: 'https://github.com/efecrtgl/ivily-portly', path: null, version: null, status: 'notInstalled', message: null, checkedAt: 1, info: null },
  { product: 'ivily-structura', name: 'Ivily Structura', description: 'Structure', repository: 'r', path: 'C:\\old.exe', version: null, status: 'incompatible', message: 'version 0.0.9 does not support the Ivily Ecosystem Protocol', checkedAt: 1, info: null },
];

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  modulesStatus: vi.fn(async () => modules),
  moduleRequest: vi.fn(async () => ({ status: 'ok', schemaVersion: 2 })),
  moduleOpen: vi.fn(async () => {}),
  openExternalUrl: vi.fn(async () => {}),
  settingsSet: vi.fn(async (_k, v) => v),
  settingsValues: vi.fn(async () => ({ values: {}, invalid: [] })),
}));

const ipc = await import('../../platform/ipc.js');
const { ModulesView } = await import('./ModulesView.jsx');
const { summarize, setModuleEnabled } = await import('./model.js');

afterEach(cleanup);

describe('ecosystem dashboard', () => {
  it('shows every module with an honest status and asks only on demand', async () => {
    await act(async () => { render(<ModulesView />); });
    expect(ipc.modulesStatus).toHaveBeenCalledWith(false);
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Access off in the app')).toBeTruthy();
    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.getByText('Incompatible')).toBeTruthy();
    expect(screen.getByText(/system.insights \(planned\)/)).toBeTruthy();
    // Envora capabilities that are not granted offer no summary buttons.
    expect(screen.queryByRole('button', { name: 'Profiles' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Health' })));
    expect(ipc.moduleRequest).toHaveBeenCalledWith('ivily-optimizer', 'health', null);
    expect(screen.getByText('schemaVersion')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Refresh/ })));
    expect(ipc.modulesStatus).toHaveBeenLastCalledWith(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Optimizer' })));
    expect(ipc.moduleOpen).toHaveBeenCalledWith('ivily-optimizer');
  });

  it('disabling a module stores it in the user settings', async () => {
    await act(async () => { await setModuleEnabled('ivily-portly', false); });
    expect(ipc.settingsSet).toHaveBeenCalledWith('ecosystem.disabledModules', ['ivily-portly'], 'user');
  });

  it('summarizes nested JSON', () => {
    expect(summarize({ a: 1, b: { c: [1, 2] }, d: null })).toEqual([
      { key: 'a', value: '1', depth: 0 },
      { key: 'b', value: '', depth: 0 },
      { key: 'c', value: '', depth: 1 },
      { key: '', value: '1, 2', depth: 2 },
      { key: 'd', value: '—', depth: 0 },
    ]);
  });
});
