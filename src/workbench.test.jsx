// Workbench integration: all contributions registered, the real shell rendered, driven through
// keyboard shortcuts, the Command Palette, menus and notifications (backend mocked).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./platform/ipc.js', () => {
  const known = {
    isTauri: () => true,
    events: { fsChanged: 'fs://changed', outputEntry: 'output://entry' },
    onEvent: () => () => {},
    uiStateGet: async () => null,
    outputChannels: async () => [{ id: 'app', label: 'Application' }],
    outputRead: async () => [],
    settingsSchema: async () => [],
    settingsValues: async () => ({ values: {}, invalid: [] }),
    settingsSet: vi.fn(async (_k, v) => v),
    tasksList: async () => ({ tasks: [], issues: [], canRun: false }),
    dapInfo: async () => ({ configs: [], adapters: [], issues: [], canRun: false }),
    terminalProfiles: async () => [],
    gitRepos: async () => ({ gitVersion: null, repos: [] }),
    lspServers: async () => [],
    quickOpen: async (q) => (q ? [{ root: 0, path: 'src/main.rs' }] : []),
  };
  const fns = {};
  return new Proxy(known, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string' || k === 'then') return undefined;
      fns[k] ??= vi.fn(async () => null);
      return fns[k];
    },
    has: () => true,
  });
});

vi.mock('./platform/window.js', () => ({
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  isWindowMaximized: vi.fn(async () => false),
  setWindowTitle: vi.fn(),
  onMaximizeChange: () => () => {},
  beforeWindowClose: vi.fn(),
}));

const ipc = await import('./platform/ipc.js');
const { Workbench } = await import('./shell/Workbench.jsx');
const { registerWorkbenchContributions } = await import('./app/contributions.js');
const { installKeybindingDispatcher } = await import('./core/keybindings.js');
const { layoutStore } = await import('./core/layout.js');
const { notify, notificationStore } = await import('./core/notifications.js');
const { openContextMenu } = await import('./core/contextMenu.js');
const { executeCommand, hasCommand, listCommands } = await import('./core/commands.js');
const { workspaceStore } = await import('./workspace/store.js');
const { registerBuiltinThemes } = await import('./theme/index.js');
const { themeStore } = await import('./theme/engine.js');

let uninstall;
beforeAll(() => {
  registerBuiltinThemes();
  registerWorkbenchContributions();
  uninstall = installKeybindingDispatcher(window);
  workspaceStore.set({ current: { record: { id: 'ws_0000000000000001', name: 'demo', kind: 'folder', path: 'C:\\demo', favorite: false }, folders: [{ name: 'demo', path: 'C:\\demo', available: true }], trust: { level: 'restricted', capabilities: [], folders: [], needsDecision: false } }, epoch: 1, busy: false, page: 'welcome', trustPrompt: false });
});
afterAll(() => {
  uninstall?.();
  cleanup();
});

const key = (code, k, mods = {}) => act(async () => { fireEvent.keyDown(window, { code, key: k, ...mods }); });
const typeInPicker = async (text) => {
  const input = document.querySelector('.quick-pick__input');
  await act(async () => fireEvent.change(input, { target: { value: text } }));
  await act(async () => {});
  return input;
};

describe('workbench', () => {
  it('registers a consistent set of commands', () => {
    const all = listCommands();
    expect(all.length).toBeGreaterThan(100);
    for (const id of ['workbench.commandPalette', 'workbench.quickOpen', 'search.show', 'tasks.run', 'debug.start', 'backup.show', 'ecosystem.showDashboard', 'window.new', 'app.checkForUpdates']) expect(hasCommand(id)).toBe(true);
  });

  it('renders the shell and toggles the side bar with Ctrl+B', async () => {
    await act(async () => { render(<Workbench />); });
    expect(screen.getByRole('contentinfo', { name: 'Status bar' })).toBeTruthy();
    const before = layoutStore.get().sidebarVisible;
    await key('KeyB', 'b', { ctrlKey: true });
    expect(layoutStore.get().sidebarVisible).toBe(!before);
    await key('KeyB', 'b', { ctrlKey: true });
    expect(layoutStore.get().sidebarVisible).toBe(before);
  });

  it('runs a command from the Command Palette', async () => {
    await key('KeyP', 'P', { ctrlKey: true, shiftKey: true });
    expect(document.querySelector('.quick-pick')).toBeTruthy();
    const input = await typeInPicker('>toggle panel');
    const before = layoutStore.get().panelVisible;
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(document.querySelector('.quick-pick')).toBeNull();
    expect(layoutStore.get().panelVisible).toBe(!before);
  });

  it('Quick Open lists files and Escape closes it', async () => {
    await key('KeyP', 'p', { ctrlKey: true });
    await typeInPicker('main');
    expect(screen.getByText('main.rs')).toBeTruthy();
    const input = document.querySelector('.quick-pick__input');
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }));
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }));
    expect(document.querySelector('.quick-pick')).toBeNull();
  });

  it('opens views and pages through commands', async () => {
    await act(async () => { await executeCommand('search.show'); });
    expect(layoutStore.get().sidebarView).toBe('search');
    await act(async () => { await executeCommand('workbench.showProblems'); });
    expect(layoutStore.get().panelView).toBe('problems');
    await act(async () => { await executeCommand('preferences.openKeybindings'); });
    expect(workspaceStore.get().page).toBe('keybindings');
    expect(await screen.findByRole('heading', { name: /Keyboard Shortcuts/ })).toBeTruthy();
  });

  it('switches themes from the command palette', async () => {
    await key('KeyP', 'P', { ctrlKey: true, shiftKey: true });
    const input = await typeInPicker('>Preferences: Theme: Pixel Dark');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await act(async () => {});
    // The choice is stored as the user's theme setting (applied by the settings effects at runtime).
    expect(ipc.settingsSet).toHaveBeenCalledWith('appearance.theme', 'pixel-dark', 'user');
  });

  it('shows notifications with actions and context menus', async () => {
    await act(async () => { notify({ title: 'Hello there', message: 'Body', source: 'test', actions: [{ label: 'Open Settings', command: 'preferences.openSettings' }] }); });
    const toast = await screen.findByText('Hello there');
    const region = toast.closest('[role="status"], [role="alert"], .toast') ?? document.body;
    await act(async () => fireEvent.click(within(/** @type {HTMLElement} */ (region)).getByRole('button', { name: 'Open Settings' })));
    expect(layoutStore.get().sidebarView).toBe('settings');
    // Running an action dismisses the notification.
    expect(notificationStore.get().items.some((n) => n.title === 'Hello there')).toBe(false);

    const run = vi.fn();
    await act(async () => openContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, [{ label: 'Do it', run }, { separator: true }, { label: 'Disabled', disabled: true, run }]));
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Do it' })));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
