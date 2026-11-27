import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  gitRepos: vi.fn(async () => ({ gitVersion: '2.54.0', repos: [{ root: 0, top: 'C:\\repo', prefix: '' }] })),
  gitStatus: vi.fn(async () => ({ branch: 'main', detached: false, head: 'abc', upstream: null, ahead: 0, behind: 0, operation: null, files: [] })),
  gitDiscard: vi.fn(async () => {}),
  fsTrash: vi.fn(async () => {}),
  gitSync: vi.fn(async () => ''),
  gitBranchDelete: vi.fn(async (_r, _n, force) => {
    if (!force) throw { code: 'io', message: "error: the branch 'x' is not fully merged" };
  }),
}));

const ipc = await import('../../platform/ipc.js');
const model = await import('./model.js');
const { ScmView } = await import('./ScmView.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { workspaceStore } = await import('../../workspace/store.js');

const file = (path, extra = {}) => ({ path, orig: null, index: '.', worktree: 'M', untracked: false, conflicted: false, ...extra });
afterEach(cleanup);

describe('git model', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps repository paths to workspace folders and decorates parents', () => {
    const repos = [{ root: 0, top: 'C:\\repo', prefix: 'app' }];
    expect(model.toWorkspacePath(repos[0], 'app/src/a.js')).toBe('src/a.js');
    expect(model.toWorkspacePath(repos[0], 'other/b.js')).toBeNull();
    const d = model.decorationsFor(repos, { 0: { files: [file('app/src/a.js'), file('app/new.txt', { untracked: true, worktree: '?' }), file('app/c.txt', { conflicted: true })] } });
    expect(d['0:src/a.js']).toMatchObject({ badge: 'M' });
    expect(d['0:new.txt']).toMatchObject({ badge: 'U' });
    expect(d['0:c.txt']).toMatchObject({ badge: 'C' });
    expect(d['0:src']).toMatchObject({ badge: '•' });
  });

  it('discard asks first, restores tracked files and sends untracked ones to the Recycle Bin', async () => {
    model.gitStore.set((s) => ({ ...s, repos: [{ root: 0, top: 'C:\\repo', prefix: '' }] }));
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.discard(0, [file('a.txt'), file('new.txt', { untracked: true, worktree: '?' })]); });
    expect(screen.getByRole('alertdialog', { name: /Discard changes in 2 files/ })).toBeTruthy();
    expect(ipc.gitDiscard).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })));
    await p;
    expect(ipc.gitDiscard).toHaveBeenCalledWith(0, ['a.txt']);
    expect(ipc.fsTrash).toHaveBeenCalledWith([{ root: 0, path: 'new.txt' }]);
  });

  it('pushing a branch without upstream asks to publish', async () => {
    model.gitStore.set((s) => ({ ...s, status: { 0: { branch: 'feature', upstream: null } } }));
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.sync(0, 'push'); });
    expect(screen.getByRole('alertdialog', { name: /Publish branch/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Publish' })));
    await p;
    expect(ipc.gitSync).toHaveBeenCalledWith(0, 'push', true);
  });

  it('deleting an unmerged branch needs a second, explicit confirmation', async () => {
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.deleteBranch(0, 'x'); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete' })));
    await act(async () => {});
    expect(screen.getByRole('alertdialog', { name: /not fully merged/ })).toBeTruthy();
    expect(ipc.gitBranchDelete).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Keep branch' })));
    await p;
    expect(ipc.gitBranchDelete).toHaveBeenCalledTimes(1);
  });
});

describe('source control view', () => {
  it('explains Restricted Mode instead of running git', async () => {
    workspaceStore.set({ current: { record: { id: 'ws_0000000000000001' }, folders: [{ name: 'r', path: 'C:\\repo', available: true }], trust: { level: 'restricted', capabilities: [], folders: [], needsDecision: false } }, epoch: 3, busy: false, page: 'editor', trustPrompt: false });
    model.gitStore.set((s) => ({ ...s, state: 'idle' }));
    await act(async () => { render(<ScmView />); });
    expect(screen.getByText('Git is disabled in Restricted Mode')).toBeTruthy();
    expect(ipc.gitRepos).not.toHaveBeenCalled();
  });
});
