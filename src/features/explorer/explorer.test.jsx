import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsData = vi.hoisted(() => ({
  '0:': [
    { name: 'src', kind: 'dir', size: 0, modified: 0, hidden: false, ignored: false, readonly: false },
    { name: 'target', kind: 'dir', size: 0, modified: 0, hidden: false, ignored: true, readonly: false },
    { name: 'README.md', kind: 'file', size: 10, modified: 0, hidden: false, ignored: false, readonly: false },
  ],
  '0:src': [
    { name: 'main.rs', kind: 'file', size: 10, modified: 0, hidden: false, ignored: false, readonly: false },
    { name: 'lib.rs', kind: 'file', size: 10, modified: 0, hidden: false, ignored: false, readonly: false },
  ],
}));

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  onEvent: () => () => {},
  events: {},
  outputAppend: vi.fn(async () => {}),
  fsList: vi.fn(async (root, path) => ({ entries: fsData[`${root}:${path}`] ?? [], truncated: false, ignored: false })),
  fsTrash: vi.fn(async () => {}),
  fsDeletePermanently: vi.fn(async () => {}),
  fsRename: vi.fn(async (root, path, name) => ({ root, path: path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/${name}` : name })),
  fsCreateFile: vi.fn(async (root, path) => ({ root, path })),
  fsCreateDir: vi.fn(async (root, path) => ({ root, path })),
  fsCopy: vi.fn(async () => []),
  fsMove: vi.fn(async () => []),
}));

const ipc = await import('../../platform/ipc.js');
const model = await import('./model.js');
const { workspaceStore } = await import('../../workspace/store.js');
const { ExplorerView } = await import('./ExplorerView.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { fileTypeOf, folderTypeOf } = await import('../../icons/fileTypes.js');

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const roots = [{ name: 'shop', available: true }];

beforeEach(async () => {
  vi.clearAllMocks();
  workspaceStore.set({
    current: { record: { id: 'ws_0000000000000001', kind: 'folder', path: 'C:\\shop', name: 'shop' }, folders: [{ name: 'shop', path: 'C:\\shop', available: true }], file: null, trust: { level: 'restricted', capabilities: [], folders: [], needsDecision: false } },
    epoch: 1, busy: false, page: 'welcome', trustPrompt: false,
  });
  model.explorerStore.set({ dirs: {}, expanded: [], selection: [], anchor: null, focus: null, editing: null, clipboard: null });
});
afterEach(cleanup);

describe('explorer model', () => {
  it('loads lazily and flattens expanded folders depth-first', async () => {
    model.setExpanded('0:', true);
    await flush();
    let rows = model.flattenRows(model.explorerStore.get(), roots);
    expect(rows.map((r) => r.name)).toEqual(['shop', 'src', 'target', 'README.md']);
    expect(ipc.fsList).toHaveBeenCalledTimes(1);
    model.setExpanded('0:src', true);
    await flush();
    rows = model.flattenRows(model.explorerStore.get(), roots);
    expect(rows.map((r) => `${r.depth}${r.name}`)).toEqual(['0shop', '1src', '2main.rs', '2lib.rs', '1target', '1README.md']);
    expect(rows.find((r) => r.name === 'target').ignored).toBe(true);
  });

  it('range and toggle selection; top-level reduction', async () => {
    model.setExpanded('0:', true);
    model.setExpanded('0:src', true);
    await flush();
    const rows = model.flattenRows(model.explorerStore.get(), roots);
    model.select('0:src', {}, rows);
    model.select('0:src/lib.rs', { shift: true }, rows);
    expect(model.explorerStore.get().selection).toEqual(['0:src', '0:src/main.rs', '0:src/lib.rs']);
    model.select('0:README.md', { ctrl: true }, rows);
    expect(model.explorerStore.get().selection).toHaveLength(4);
    expect(model.topLevel(model.explorerStore.get().selection)).toEqual(['0:src', '0:README.md']);
  });

  it('reloads only loaded parents of changed paths', async () => {
    vi.useFakeTimers();
    try {
      model.setExpanded('0:', true);
      await vi.runAllTimersAsync();
      ipc.fsList.mockClear();
      model.onFsChanged({ root: 0, paths: ['new.txt', 'deep/unloaded/x.txt'], rescan: false, git: false });
      await vi.advanceTimersByTimeAsync(100);
      expect(ipc.fsList).toHaveBeenCalledTimes(1);
      expect(ipc.fsList).toHaveBeenCalledWith(0, '');
    } finally {
      vi.useRealTimers();
    }
  });

  it('inline create commits through the backend; rename keeps selection on the new name', async () => {
    model.startCreate('newFile', '0:src');
    await flush();
    expect(model.flattenRows(model.explorerStore.get(), roots).some((r) => r.editing)).toBe(true);
    expect(await model.commitEdit('utils/helpers.js')).toBeNull();
    expect(ipc.fsCreateDir).toHaveBeenCalledWith(0, 'src/utils');
    expect(ipc.fsCreateFile).toHaveBeenCalledWith(0, 'src/utils/helpers.js');
    model.startRename('0:src/main.rs');
    expect(await model.commitEdit('app.rs')).toBeNull();
    expect(ipc.fsRename).toHaveBeenCalledWith(0, 'src/main.rs', 'app.rs');
    expect(model.explorerStore.get().selection).toEqual(['0:src/app.rs']);
  });

  it('copy/cut/paste use non-overwriting backend operations', async () => {
    model.setClipboard('copy', ['0:README.md']);
    await model.paste('0:src');
    expect(ipc.fsCopy).toHaveBeenCalledWith([{ root: 0, path: 'README.md' }], { root: 0, path: 'src' }, 'rename');
    model.setClipboard('cut', ['0:src/lib.rs']);
    await model.paste('0:');
    expect(ipc.fsMove).toHaveBeenCalledWith([{ root: 0, path: 'src/lib.rs' }], { root: 0, path: '' });
    expect(model.explorerStore.get().clipboard).toBeNull();
  });

  it('session restore expands saved folders and drops invalid keys', async () => {
    const { restoreSession } = await import('../../workspace/session.js');
    model.registerExplorerSession();
    restoreSession({ version: 1, participants: { explorer: { expanded: ['0:', '0:src', '5:x', 42], selection: ['0:src/main.rs'] } } });
    expect(model.explorerStore.get().expanded).toEqual(['0:', '0:src']);
    await flush();
    expect(ipc.fsList).toHaveBeenCalledWith(0, 'src');
  });
});

describe('explorer view', () => {
  it('renders the tree and deletes to the Recycle Bin only after confirmation', async () => {
    model.setExpanded('0:', true);
    await flush();
    render(<><ExplorerView /><ConfirmDialog /></>);
    expect(screen.getByRole('treeitem', { name: /README\.md/ })).toBeTruthy();
    const tree = screen.getByRole('tree');
    fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }));
    await act(async () => fireEvent.keyDown(tree, { key: 'Delete' }));
    expect(screen.getByRole('alertdialog', { name: /Recycle Bin/ })).toBeTruthy();
    expect(ipc.fsTrash).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move to Recycle Bin' })));
    expect(ipc.fsTrash).toHaveBeenCalledWith([{ root: 0, path: 'README.md' }]);
  });

  it('Shift+Delete asks for permanent deletion; Escape cancels', async () => {
    model.setExpanded('0:', true);
    await flush();
    render(<><ExplorerView /><ConfirmDialog /></>);
    fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }));
    await act(async () => fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete', shiftKey: true }));
    expect(screen.getByRole('alertdialog', { name: /Permanently delete/ })).toBeTruthy();
    await act(async () => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(ipc.fsDeletePermanently).not.toHaveBeenCalled();
  });

  it('keyboard navigation expands folders', async () => {
    model.setExpanded('0:', true);
    await flush();
    render(<ExplorerView />);
    const tree = screen.getByRole('tree');
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }));
    await act(async () => fireEvent.keyDown(tree, { key: 'ArrowRight' }));
    await flush();
    expect(model.explorerStore.get().expanded).toContain('0:src');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(model.explorerStore.get().focus).toBe('0:src/main.rs');
  });
});

describe('file types', () => {
  it('resolves names, compound and simple extensions', () => {
    expect(fileTypeOf('Cargo.toml').id).toBe('cargo');
    expect(fileTypeOf('main.rs').id).toBe('rust');
    expect(fileTypeOf('types.d.ts').id).toBe('typescript-def');
    expect(fileTypeOf('app.test.tsx').id).toBe('test');
    expect(fileTypeOf('.env.staging').id).toBe('env');
    expect(fileTypeOf('Dockerfile.dev').id).toBe('docker');
    expect(fileTypeOf('weird.unknownext').id).toBe('file');
    expect(folderTypeOf('node_modules').variant).toBe('deps');
    expect(folderTypeOf('random')).toBeNull();
  });
});
