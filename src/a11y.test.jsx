// Accessibility audit: every interactive element in the main views and pages must have an
// accessible name, and images must be hidden or labelled.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAccessibleName } from 'dom-accessibility-api';

vi.mock('./platform/ipc.js', () => {
  const resolve = (v) => vi.fn(async () => v);
  return {
    isTauri: () => true,
    events: {},
    onEvent: () => () => {},
    outputAppend: resolve(),
    outputChannels: resolve([{ id: 'app', label: 'Application' }]),
    outputRead: resolve([]),
    uiStateGet: resolve(null),
    uiStateSet: resolve(),
    sessionSave: resolve(),
    modulesStatus: resolve([{ product: 'ivily-portly', name: 'Ivily Portly', description: 'Ports', repository: 'https://x', path: null, version: null, status: 'notInstalled', message: null, checkedAt: 1, info: null }]),
    updateInfo: resolve({ currentVersion: '0.1.0', lastCheck: null, history: [{ at: 1, kind: 'check', outcome: 'upToDate' }], manifestUrl: 'x' }),
    backupList: resolve({ folder: 'C:\\b', restorePending: false, backups: [{ name: 'ivily-center-manual-1.zip', size: 1, manifest: { createdAt: 1, kind: 'manual', files: [], schemaVersion: 2, appVersion: '0.1.0' }, error: null }] }),
    extensionsList: resolve({ installed: [{ manifest: { id: 'a.b', name: 'Ext', version: '1', contributes: {} }, enabled: true, files: {} }], issues: [], recommendations: [] }),
    dapInfo: resolve({ configs: [{ id: 'c', name: 'Run', type: 'python', request: 'launch', adapter: 'Python' }], adapters: [], issues: [], canRun: true }),
    notesRead: resolve(''),
    tasksList: resolve({ tasks: [], issues: [], canRun: true }),
  };
});

const { workspaceStore } = await import('./workspace/store.js');
const views = {
  SearchView: (await import('./features/search/SearchView.jsx')).SearchView,
  DebugView: (await import('./features/debug/DebugView.jsx')).DebugView,
  DebugConsoleView: (await import('./features/debug/DebugView.jsx')).DebugConsoleView,
  ExtensionsView: (await import('./features/extensions/ExtensionsView.jsx')).ExtensionsView,
  NotesView: (await import('./features/notes/NotesView.jsx')).NotesView,
  ProblemsView: (await import('./features/problems/ProblemsView.jsx')).ProblemsView,
  OutputView: (await import('./features/output/OutputView.jsx')).OutputView,
  ModulesView: (await import('./features/modules/ModulesView.jsx')).ModulesView,
  UpdatesView: (await import('./features/update/UpdatesView.jsx')).UpdatesView,
  BackupsView: (await import('./features/backup/BackupsView.jsx')).BackupsView,
  KeybindingsView: (await import('./features/keybindings/KeybindingsView.jsx')).KeybindingsView,
  WelcomeView: (await import('./features/welcome/WelcomeView.jsx')).WelcomeView,
};

afterEach(cleanup);

function unnamed(container) {
  const out = [];
  for (const el of container.querySelectorAll('button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=option], [role=treeitem], a[href]')) {
    if (el.closest('[aria-hidden="true"]')) continue;
    const name = computeAccessibleName(el).trim();
    if (!name) out.push(el.outerHTML.slice(0, 140));
  }
  for (const svg of container.querySelectorAll('svg')) {
    if (svg.getAttribute('aria-hidden') !== 'true' && !svg.getAttribute('aria-label') && svg.getAttribute('role') !== 'img') out.push(`svg: ${svg.outerHTML.slice(0, 80)}`);
  }
  return out;
}

describe('accessibility', () => {
  it('the audit itself detects unlabelled controls', () => {
    const { container } = render(<div><button type="button"><svg /></button><input /><button type="button" aria-label="ok"><svg aria-hidden="true" /></button></div>);
    expect(unnamed(container)).toHaveLength(3);
  });
  workspaceStore.set({ current: { record: { id: 'ws_0000000000000001', name: 'w', kind: 'folder', path: 'C:\\w' }, folders: [{ name: 'w', path: 'C:\\w', available: true }], trust: { level: 'trusted', capabilities: ['debugging', 'taskExecution'], folders: [], needsDecision: false } }, epoch: 1, busy: false, page: 'editor', trustPrompt: false });
  for (const [name, View] of Object.entries(views)) {
    it(`${name}: every control has an accessible name`, async () => {
      let container;
      await act(async () => {
        ({ container } = render(<View />));
      });
      await act(async () => {});
      expect(unnamed(container)).toEqual([]);
    });
  }
});
