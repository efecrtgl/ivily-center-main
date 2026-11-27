import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage = null;
  },
  invoke: vi.fn(),
}));

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  uiStateGet: vi.fn(async () => null),
  uiStateSet: vi.fn(async () => {}),
  searchRun: vi.fn(async (_id, _q, channel) => {
    channel.onmessage([{ root: 0, path: 'src/a.js', matches: [{ line: 3, ranges: [[4, 7]], preview: 'let foo = 1;', previewOffset: 0 }] }]);
    return { matches: 1, files: 1, filesSearched: 5, limitHit: false, cancelled: false };
  }),
  searchCancel: vi.fn(async () => {}),
  searchReplace: vi.fn(async () => [{ root: 0, path: 'src/a.js', replacements: 1, error: null }]),
  quickOpen: vi.fn(async () => [{ root: 0, path: 'src/features/editor/model.js' }]),
}));

const ipc = await import('../../platform/ipc.js');
const model = await import('./model.js');
const { SearchView } = await import('./SearchView.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { workspaceStore } = await import('../../workspace/store.js');
const qo = await import('../palette/quickOpen.js');
const commands = await import('../../core/commands.js');
const kb = await import('../keybindings/model.js');
const core = await import('../../core/keybindings.js');

const ws = { record: { id: 'ws_0000000000000001', name: 'w' }, folders: [{ name: 'w', path: 'C:\\w', available: true }], trust: { level: 'trusted', capabilities: [], folders: [], needsDecision: false } };

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  workspaceStore.set({ current: ws, epoch: 1, busy: false, page: 'editor', trustPrompt: false });
});

describe('search model', () => {
  it('splits glob lists and builds the backend query', () => {
    expect(model.splitGlobs(' src/**, *.js ,, ')).toEqual(['src/**', '*.js']);
    model.searchStore.set((s) => ({ ...s, query: 'foo', isRegex: true, include: '*.js', exclude: '', useIgnore: false }));
    expect(model.buildQuery()).toEqual({ pattern: 'foo', isRegex: true, caseSensitive: false, wholeWord: false, include: ['*.js'], exclude: [], useIgnore: false });
  });

  it('streams results, records history and shows a summary', async () => {
    model.searchStore.set((s) => ({ ...s, query: 'foo', isRegex: false, include: '', useIgnore: true }));
    await act(async () => { await model.runSearch(); });
    const s = model.searchStore.get();
    expect(s.results).toHaveLength(1);
    expect(s.summary.matches).toBe(1);
    expect(s.history[0]).toBe('foo');
    expect(ipc.uiStateSet).toHaveBeenCalledWith(model.HISTORY_KEY, expect.arrayContaining(['foo']));
    await act(async () => { render(<SearchView />); });
    expect(screen.getByText('1 result in 1 file')).toBeTruthy();
    expect(screen.getByText('foo').tagName).toBe('MARK');
  });

  it('replace asks first and does nothing when cancelled', async () => {
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.replaceAll(); });
    expect(screen.getByRole('alertdialog', { name: /Replace 1 occurrence in 1 file/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    await p;
    expect(ipc.searchReplace).not.toHaveBeenCalled();
  });

  it('replace sends only the confirmed files', async () => {
    model.searchStore.set((s) => ({ ...s, replace: 'bar' }));
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.replaceAll(); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Replace' })));
    await act(async () => { await p; });
    expect(ipc.searchReplace).toHaveBeenCalledWith(expect.objectContaining({ pattern: 'foo' }), 'bar', [{ root: 0, path: 'src/a.js' }]);
  });
});

describe('quick open', () => {
  it('parses line suffixes', () => {
    expect(qo.parseLineSuffix('model.js:12:4')).toEqual({ text: 'model.js', line: 12, col: 4 });
    expect(qo.parseLineSuffix('model.js')).toEqual({ text: 'model.js', line: null, col: null });
  });

  it('routes prefixes to files, commands and help', async () => {
    const files = await qo.provideItems('edmod');
    expect(ipc.quickOpen).toHaveBeenCalledWith('edmod', 60);
    expect(files[0]).toMatchObject({ label: 'model.js', description: 'src/features/editor' });
    const dispose = commands.registerCommand({ id: 'test.hello', title: 'Say Hello', category: 'Test', run: () => {} });
    const cmds = await qo.provideItems('>hello');
    expect(cmds[0]).toMatchObject({ id: 'cmd:test.hello', label: 'Test: Say Hello' });
    dispose();
    const help = await qo.provideItems('?');
    expect(help.map((h) => h.label)).toContain('Go to Line');
    const line = await qo.provideItems(':10');
    expect(line[0].label).toMatch(/Open a file first/);
  });
});

describe('user keybindings', () => {
  it('changing a default records a removal and persists; reset restores it', async () => {
    core.keybindingStore.set({ defaults: [{ key: 'Ctrl+B', command: 'workbench.toggleSidebar' }], user: [] });
    const def = core.effectiveKeybindings()[0];
    await kb.assignKeybinding('workbench.toggleSidebar', 'Ctrl+Alt+B', def);
    expect(core.effectiveKeybindings().map((b) => b.key)).toEqual(['Ctrl+Alt+B']);
    expect(ipc.uiStateSet).toHaveBeenLastCalledWith(kb.USER_KEY, [{ key: 'Ctrl+B', command: '-workbench.toggleSidebar' }, { key: 'Ctrl+Alt+B', command: 'workbench.toggleSidebar' }]);
    expect(kb.isModified('workbench.toggleSidebar')).toBe(true);
    await kb.resetKeybindings('workbench.toggleSidebar');
    expect(core.effectiveKeybindings().map((b) => b.key)).toEqual(['Ctrl+B']);
  });
});
