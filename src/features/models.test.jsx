import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  gitShow: vi.fn(async (_root, rev, path) => (rev === 'HEAD' ? `old ${path}\r\n` : rev === ':0' ? `index ${path}\n` : rev.endsWith('^') ? 'parent\n' : 'commit\n')),
  docRead: vi.fn(async () => ({ content: 'working\r\n' })),
  openExternalUrl: vi.fn(async () => {}),
}));
vi.mock('./editor/model.js', () => ({
  activeEditor: vi.fn(() => null),
  openDocument: vi.fn(async () => 'k'),
  revealInDocument: vi.fn(async () => 'k'),
}));

const ipc = await import('../platform/ipc.js');
const editor = await import('./editor/model.js');
const { diffStore, openCommitDiff, openStatusDiff } = await import('./git/diffModel.js');
const { gitStore } = await import('./git/model.js');
const { followLink, openPreview, previewKind, previewStore } = await import('./preview/model.js');
const { workspaceStore } = await import('../workspace/store.js');
const { notificationStore } = await import('../core/notifications.js');

beforeEach(() => vi.clearAllMocks());

describe('diff model', () => {
  it('opens working-tree, staged and commit diffs with normalized line endings', async () => {
    gitStore.set((s) => ({ ...s, repos: [{ root: 0, top: 'C:\\repo', prefix: '' }] }));
    const f = { path: 'a.txt', orig: null, index: 'M', worktree: 'M', untracked: false, conflicted: false };
    await openStatusDiff(0, f, false);
    expect(diffStore.get()).toMatchObject({ original: 'index a.txt\n', modified: 'working\n', openRef: { root: 0, path: 'a.txt' } });
    expect(workspaceStore.get().page).toBe('diff');
    await openStatusDiff(0, f, true);
    expect(diffStore.get()).toMatchObject({ original: 'old a.txt\n', modified: 'index a.txt\n' });
    await openStatusDiff(0, { ...f, untracked: true, worktree: '?' }, false);
    expect(diffStore.get().original).toBe('');
    await openCommitDiff(0, 'abcdef123456', { path: 'b.txt', status: 'M' });
    expect(diffStore.get()).toMatchObject({ title: 'b.txt @ abcdef12', original: 'parent\n', modified: 'commit\n' });
    await openCommitDiff(0, 'abcdef123456', { path: 'new.txt', status: 'A' });
    expect(diffStore.get().original).toBe('');
  });

  it('reports failures without changing the page', async () => {
    ipc.gitShow.mockRejectedValueOnce({ code: 'io', message: 'boom' });
    await openCommitDiff(0, 'abc', { path: 'x', status: 'M' });
    expect(notificationStore.get().items[0]).toMatchObject({ title: 'Could not show the diff' });
  });
});

describe('preview model', () => {
  it('detects previewable files and opens the page only for them', () => {
    expect(previewKind('README.md')).toBe('markdown');
    expect(previewKind('index.HTML')).toBe('html');
    expect(previewKind('main.rs')).toBeNull();
    editor.activeEditor.mockReturnValueOnce({ key: 'k1', doc: { name: 'main.rs' } });
    openPreview();
    expect(previewStore.get().key).toBeNull();
    editor.activeEditor.mockReturnValueOnce({ key: 'k2', doc: { name: 'GUIDE.md' } });
    openPreview();
    expect(previewStore.get().key).toBe('k2');
    expect(workspaceStore.get().page).toBe('preview');
  });

  it('follows links safely', async () => {
    const doc = { ref: { root: 0, path: 'docs/GUIDE.md' } };
    const container = document.createElement('div');
    container.innerHTML = '<h2 id="install">Install</h2>';
    followLink('https://example.org/x', doc, container);
    expect(ipc.openExternalUrl).toHaveBeenCalledWith('https://example.org/x');
    followLink('../src/a.rs#L7', doc, container);
    expect(editor.revealInDocument).toHaveBeenCalledWith({ root: 0, path: 'src/a.rs' }, 7);
    followLink('notes.md', doc, container);
    expect(editor.openDocument).toHaveBeenCalledWith({ root: 0, path: 'docs/notes.md' });
    followLink('../../outside.md', doc, container);
    followLink('file:///C:/Windows/win.ini', doc, container);
    followLink('#install', doc, container);
    expect(editor.openDocument).toHaveBeenCalledTimes(1);
    expect(ipc.openExternalUrl).toHaveBeenCalledTimes(1);
  });
});
