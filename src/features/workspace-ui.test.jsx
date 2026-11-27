import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

vi.mock('../platform/ipc.js', () => ({
  isTauri: () => true,
  onEvent: () => () => {},
  events: {},
  outputAppend: vi.fn(async () => {}),
  trustGrant: vi.fn(async (request) => ({
    level: request.capabilities ? 'partial' : 'trusted',
    capabilities: request.capabilities ?? ['taskExecution', 'processLaunch', 'languageServers', 'extensions', 'debugging', 'workspaceExecutables'],
    folders: [],
    needsDecision: false,
  })),
  trustDeny: vi.fn(async () => ({ level: 'restricted', capabilities: [], folders: [], needsDecision: false })),
  settingsSet: vi.fn(async (_k, v) => v),
  settingsReset: vi.fn(async () => {}),
  settingsValues: vi.fn(async () => ({ values: {}, invalid: [] })),
}));

const ipc = await import('../platform/ipc.js');
const { workspaceStore } = await import('../workspace/store.js');
const { TrustDialog } = await import('./trust/TrustDialog.jsx');
const { ConfirmDialog } = await import('../shell/ConfirmDialog.jsx');
const { confirmDialog } = await import('../core/dialogs.js');
const { filterRecords } = await import('./launcher/LauncherView.jsx');
const { SettingsView } = await import('./settings/SettingsView.jsx');
const { settingsStore } = await import('../core/settings.js');

const folder = (path, decision = null) => ({ path, pathKey: path.toLowerCase(), decision, capabilities: [], source: { kind: 'none' } });
const workspace = (folders) => ({
  record: { id: 'ws_0000000000000001', kind: 'folder', path: folders[0].path, name: 'shop', favorite: false, group: '', createdAt: 0, lastOpenedAt: 0, openCount: 1 },
  folders: folders.map((f) => ({ name: 'shop', path: f.path, available: true })),
  file: null,
  trust: { level: 'restricted', capabilities: [], folders, needsDecision: folders.some((f) => f.decision === null) },
});

describe('trust dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceStore.set({ current: workspace([folder('C:\\code\\shop')]), epoch: 1, busy: false, page: 'welcome', trustPrompt: true });
  });

  it('explains Restricted Mode and grants nothing until the user clicks', async () => {
    render(<TrustDialog />);
    expect(screen.getByRole('dialog', { name: /trust the authors/ })).toBeTruthy();
    expect(screen.getByText('C:\\code\\shop')).toBeTruthy();
    expect(ipc.trustGrant).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Trust this folder' })));
    expect(ipc.trustGrant).toHaveBeenCalledWith({ scope: 'folder', capabilities: null, remember: true });
    expect(workspaceStore.get().current.trust.level).toBe('trusted');
    expect(workspaceStore.get().trustPrompt).toBe(false);
  });

  it('offers parent, session-only and granular trust', async () => {
    render(<TrustDialog />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Trust everything in C:\\code' })));
    expect(ipc.trustGrant).toHaveBeenLastCalledWith({ scope: 'parent', capabilities: null, remember: true });

    await act(async () => workspaceStore.set((s) => ({ ...s, trustPrompt: true })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Trust for this session' })));
    expect(ipc.trustGrant).toHaveBeenLastCalledWith({ scope: 'folder', capabilities: null, remember: false });

    await act(async () => workspaceStore.set((s) => ({ ...s, trustPrompt: true })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Customize…' })));
    fireEvent.click(screen.getByRole('checkbox', { name: /Run workspace tasks/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Remember this decision/ }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply' })));
    const req = ipc.trustGrant.mock.calls.at(-1)[0];
    expect(req.remember).toBe(false);
    expect(req.capabilities).not.toContain('taskExecution');
    expect(req.capabilities).toContain('languageServers');
  });

  it('"Stay restricted" records a denial; Escape decides nothing', async () => {
    render(<TrustDialog />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(workspaceStore.get().trustPrompt).toBe(false);
    expect(ipc.trustDeny).not.toHaveBeenCalled();
    expect(ipc.trustGrant).not.toHaveBeenCalled();

    await act(async () => workspaceStore.set((s) => ({ ...s, trustPrompt: true })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stay restricted' })));
    expect(ipc.trustDeny).toHaveBeenCalledTimes(1);
  });

  it('a drive-root folder offers no parent trust', () => {
    workspaceStore.set((s) => ({ ...s, current: workspace([folder('D:\\proj')]) }));
    render(<TrustDialog />);
    expect(screen.queryByRole('button', { name: /Trust everything in/ })).toBeNull();
  });
});

describe('confirmation dialog', () => {
  it('resolves true only on explicit confirmation; Escape cancels', async () => {
    render(<ConfirmDialog />);
    let p;
    await act(async () => {
      p = confirmDialog({ title: 'Replace the existing file?', detail: 'C:\\x.ivily-workspace', confirmLabel: 'Replace', danger: true });
    });
    expect(document.activeElement?.textContent).toBe('Cancel');
    await act(async () => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(await p).toBe(false);

    await act(async () => {
      p = confirmDialog({ title: 'Remove?', confirmLabel: 'Remove' });
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove' })));
    expect(await p).toBe(true);
  });
});

describe('launcher', () => {
  const r = (name, path, group = '') => ({ id: name, name, path, group });
  it('filters by name, path and group', () => {
    const list = [r('shop', 'C:\\code\\shop', 'Work'), r('blog', 'D:\\sites\\blog'), r('api', 'C:\\code\\api', 'Work')];
    expect(filterRecords(list, 'work').map((x) => x.name)).toEqual(['shop', 'api']);
    expect(filterRecords(list, 'code api').map((x) => x.name)).toEqual(['api']);
    expect(filterRecords(list, 'sites')).toHaveLength(1);
    expect(filterRecords(list, '')).toHaveLength(3);
  });
});

describe('settings scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsStore.set({
      loaded: true,
      schema: [
        { key: 'appearance.theme', title: 'Theme', description: 'd', category: 'Appearance', type: 'enum', options: [{ value: 'glass', label: 'Glass' }, { value: 'pixel-dark', label: 'Pixel Dark' }], default: 'modern-dark', scopes: ['user', 'workspace'] },
        { key: 'appearance.uiFontSize', title: 'Interface font size', description: 'd', category: 'Appearance', type: 'integer', min: 10, max: 20, default: 13, scopes: ['user'] },
      ],
      values: { 'appearance.theme': { value: 'pixel-dark', source: 'workspace', userValue: 'glass', workspaceValue: 'pixel-dark' } },
    });
  });

  it('shows only workspace-capable settings in the Workspace tab and writes to that scope', async () => {
    workspaceStore.set({ current: workspace([folder('C:\\code\\shop', 'trusted')]), epoch: 1, busy: false, page: 'welcome', trustPrompt: false });
    render(<SettingsView />);
    expect(screen.getByText('Overridden in this workspace')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Workspace' })));
    expect(screen.queryByText('Interface font size')).toBeNull();
    await act(async () => fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'glass' } }));
    expect(ipc.settingsSet).toHaveBeenCalledWith('appearance.theme', 'glass', 'workspace');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use user value' })));
    expect(ipc.settingsReset).toHaveBeenCalledWith('appearance.theme', 'workspace');
  });

  it('has no Workspace tab without a workspace', () => {
    workspaceStore.set({ current: null, epoch: 2, busy: false, page: 'launcher', trustPrompt: false });
    render(<SettingsView />);
    expect(screen.queryByRole('tab', { name: 'Workspace' })).toBeNull();
  });
});
