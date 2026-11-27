// Git model: repositories of the workspace folders, status, explorer decorations and actions.
// Every destructive action asks first; nothing is forced.
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { choiceDialog, confirmDialog, promptDialog } from '../../core/dialogs.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { quickPick } from '../../core/quickPick.js';
import { setContext } from '../../core/context.js';
import * as ipc from '../../platform/ipc.js';
import { isCurrentEpoch, openWith, workspaceStore } from '../../workspace/store.js';
import { setDecorations } from '../explorer/decorations.js';

/** @typedef {{ path: string, orig: string | null, index: string, worktree: string, untracked: boolean, conflicted: boolean }} FileStatus */
/** @typedef {{ branch: string | null, detached: boolean, head: string | null, upstream: string | null, ahead: number, behind: number, files: FileStatus[], operation: string | null }} Status */

export const gitStore = createStore({
  /** 'idle' | 'loading' | 'ready' | 'blocked' (untrusted) | 'missing' (git not installed) | 'error' */
  state: 'idle',
  message: '',
  gitVersion: /** @type {string | null} */ (null),
  /** @type {{ root: number, top: string | null, prefix: string }[]} */
  repos: [],
  activeRoot: 0,
  /** @type {Record<number, Status>} */
  status: {},
  busy: false,
});

const repoFor = (root) => gitStore.get().repos.find((r) => r.root === root && r.top);
export const activeRepo = () => repoFor(gitStore.get().activeRoot) ?? gitStore.get().repos.find((r) => r.top) ?? null;

/** Repository-relative path → workspace-folder-relative path (null if outside the folder). */
export function toWorkspacePath(repo, path) {
  if (!repo.prefix) return path;
  return path.startsWith(`${repo.prefix}/`) ? path.slice(repo.prefix.length + 1) : null;
}
/** Workspace-folder-relative → repository-relative. */
export const toRepoPath = (repo, path) => (repo.prefix ? `${repo.prefix}/${path}` : path);

const LETTER_COLOR = {
  M: 'var(--color-warning)',
  A: 'var(--color-success)',
  U: 'var(--color-success)',
  D: 'var(--color-danger)',
  R: 'var(--color-info)',
  C: 'var(--color-danger)',
};

/** Badge for a file: conflict C, untracked U, otherwise worktree or index letter. */
export function badgeOf(f) {
  if (f.conflicted) return 'C';
  if (f.untracked) return 'U';
  const w = f.worktree !== '.' ? f.worktree : f.index;
  return w === 'T' ? 'M' : w;
}

/** Explorer decorations from all repositories (files and their parent folders). */
export function decorationsFor(repos, statusByRoot) {
  const map = {};
  for (const repo of repos) {
    const st = statusByRoot[repo.root];
    if (!st || !repo.top) continue;
    for (const f of st.files) {
      const rel = toWorkspacePath(repo, f.path);
      if (rel === null) continue;
      const badge = badgeOf(f);
      const color = LETTER_COLOR[badge] ?? 'var(--color-warning)';
      map[`${repo.root}:${rel}`] = { badge, color, tooltip: f.conflicted ? 'Merge conflict' : f.untracked ? 'Untracked' : `Modified (${f.index}${f.worktree})` };
      const parts = rel.split('/');
      for (let i = parts.length - 1; i > 0; i--) {
        const key = `${repo.root}:${parts.slice(0, i).join('/')}`;
        if (!map[key] || f.conflicted) map[key] = { badge: '•', color: f.conflicted ? LETTER_COLOR.C : color, tooltip: 'Contains changes' };
      }
    }
  }
  return map;
}

let refreshTimer = null;
let loadSeq = 0;

/** Discover repositories for the current workspace. */
export async function loadRepos() {
  const ws = workspaceStore.get().current;
  if (!ws || !ipc.isTauri()) {
    gitStore.set((s) => ({ ...s, state: 'idle', repos: [], status: {} }));
    setDecorations('git', {});
    return;
  }
  if (!ws.trust.capabilities.includes('workspaceExecutables')) {
    gitStore.set((s) => ({ ...s, state: 'blocked', repos: [], status: {}, message: '' }));
    setDecorations('git', {});
    return;
  }
  const epoch = workspaceStore.get().epoch;
  gitStore.set((s) => ({ ...s, state: 'loading' }));
  try {
    const r = await ipc.gitRepos();
    if (!isCurrentEpoch(epoch)) return;
    gitStore.set((s) => ({ ...s, state: 'ready', repos: r.repos, gitVersion: r.gitVersion, activeRoot: r.repos.find((x) => x.top)?.root ?? 0 }));
    await refreshStatus();
  } catch (e) {
    if (!isCurrentEpoch(epoch)) return;
    const code = errorCode(e);
    gitStore.set((s) => ({ ...s, state: code === 'workspace_untrusted' ? 'blocked' : code === 'not_found' ? 'missing' : 'error', message: errorMessage(e), repos: [] }));
  }
}

export async function refreshStatus() {
  const seq = ++loadSeq;
  const epoch = workspaceStore.get().epoch;
  const repos = gitStore.get().repos.filter((r) => r.top);
  const results = await Promise.allSettled(repos.map((r) => ipc.gitStatus(r.root)));
  if (seq !== loadSeq || !isCurrentEpoch(epoch)) return;
  const status = {};
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') status[repos[i].root] = res.value;
  });
  gitStore.set((s) => ({ ...s, status }));
  setDecorations('git', decorationsFor(gitStore.get().repos, status));
  const st = status[activeRepo()?.root];
  setContext('gitRepository', Boolean(st));
  setContext('gitOperation', st?.operation ?? '');
}

/** Watcher event → refresh (debounced). Any change can alter status (including inside .git). */
export function onFsChangedGit() {
  if (gitStore.get().state !== 'ready') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshStatus, 300);
}

async function act(fn, title) {
  gitStore.set((s) => ({ ...s, busy: true }));
  try {
    const r = await fn();
    return r ?? true;
  } catch (e) {
    notify({ severity: errorCode(e) === 'conflict' ? 'warning' : 'error', title, message: errorMessage(e), source: 'git', actions: [{ label: 'Show Git Output', command: 'git.showOutput' }] });
    return null;
  } finally {
    gitStore.set((s) => ({ ...s, busy: false }));
    refreshStatus();
  }
}

export const stage = (root, paths) => act(() => ipc.gitStage(root, paths), 'Could not stage');
export const unstage = (root, paths) => act(() => ipc.gitUnstage(root, paths), 'Could not unstage');

/**
 * Discard changes after confirmation. Tracked files are restored by git; untracked files are
 * moved to the Recycle Bin (never deleted permanently).
 * @param {number} root @param {FileStatus[]} files
 */
export async function discard(root, files) {
  const repo = repoFor(root);
  if (!repo || !files.length) return;
  const tracked = files.filter((f) => !f.untracked && !f.conflicted);
  const untracked = files.filter((f) => f.untracked);
  const ok = await confirmDialog({
    title: files.length === 1 ? `Discard changes in “${files[0].path}”?` : `Discard changes in ${files.length} files?`,
    message: [
      tracked.length ? `${tracked.length} tracked file(s) will be restored to their last committed/staged state. This cannot be undone.` : '',
      untracked.length ? `${untracked.length} untracked file(s) will be moved to the Recycle Bin.` : '',
    ].filter(Boolean).join(' '),
    detail: files.slice(0, 10).map((f) => f.path).join('\n') + (files.length > 10 ? `\n… and ${files.length - 10} more` : ''),
    confirmLabel: 'Discard changes',
    danger: true,
  });
  if (!ok) return;
  await act(async () => {
    if (tracked.length) await ipc.gitDiscard(root, tracked.map((f) => f.path));
    const items = untracked.map((f) => toWorkspacePath(repo, f.path)).filter((p) => p !== null).map((path) => ({ root, path }));
    if (items.length) await ipc.fsTrash(items);
  }, 'Could not discard changes');
}

export async function commit(root, message, { amend = false, all = false } = {}) {
  if (amend) {
    const ok = await confirmDialog({
      title: 'Amend the last commit?',
      message: 'The last commit is replaced. If it was already pushed, pushing the amended commit requires a force push, which Ivily Center does not do.',
      confirmLabel: 'Amend',
    });
    if (!ok) return null;
  }
  return act(() => ipc.gitCommit(root, message, amend, all), 'Commit failed');
}

export async function sync(root, action) {
  const st = gitStore.get().status[root];
  let setUpstream = false;
  if (action === 'push' && st && !st.upstream) {
    const ok = await confirmDialog({ title: `Publish branch “${st.branch}”?`, message: 'The branch has no upstream. It will be pushed to “origin” and set as its upstream.', confirmLabel: 'Publish' });
    if (!ok) return null;
    setUpstream = true;
  }
  const label = { fetch: 'Fetch', pull: 'Pull', pullRebase: 'Pull (rebase)', push: 'Push' }[action];
  const r = await act(() => ipc.gitSync(root, action, setUpstream), `${label} failed`);
  if (r) notify({ title: `${label} completed`, source: 'git' });
  return r;
}

export async function checkout(root) {
  const branches = await ipc.gitBranches(root).catch(() => []);
  const item = await quickPick({
    placeholder: 'Select a branch to switch to',
    items: [
      { id: '__new', label: '+ Create new branch…', group: 'Actions' },
      ...branches.filter((b) => !b.remote).map((b) => ({ id: `l:${b.name}`, label: b.name, description: `${b.current ? 'current · ' : ''}${b.commit}${b.track ? ` ${b.track}` : ''}`, group: 'Branches' })),
      ...branches.filter((b) => b.remote).map((b) => ({ id: `r:${b.name}`, label: b.name, description: `remote · ${b.commit}`, group: 'Remote branches' })),
    ],
  });
  if (!item) return;
  if (item.id === '__new') return createBranch(root);
  const remote = item.id.startsWith('r:');
  return act(() => ipc.gitSwitch(root, item.id.slice(2), remote), 'Could not switch branch');
}

const branchNameError = (v) => (/\s|\.\.|[~^:?*[\\]|^-|\/$|\.lock$|^\/|@\{/.test(v) ? 'Not a valid branch name' : null);

export async function createBranch(root) {
  const name = await promptDialog({ title: 'Create branch', message: 'The new branch starts at the current commit and is checked out.', placeholder: 'feature/my-change', confirmLabel: 'Create', validate: branchNameError });
  if (!name) return null;
  return act(() => ipc.gitBranchCreate(root, name, null, true), 'Could not create the branch');
}

export async function deleteBranch(root, name) {
  const ok = await confirmDialog({ title: `Delete branch “${name}”?`, message: 'Git refuses to delete a branch that is not fully merged.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await ipc.gitBranchDelete(root, name, false);
    refreshStatus();
  } catch (e) {
    if (!/not fully merged/i.test(errorMessage(e))) {
      notify({ severity: 'error', title: 'Could not delete the branch', message: errorMessage(e), source: 'git' });
      return;
    }
    const choice = await choiceDialog({
      title: `“${name}” is not fully merged`,
      message: 'Its commits are not reachable from any other branch and would be lost (recoverable only through the reflog).',
      choices: [{ id: 'cancel', label: 'Keep branch' }, { id: 'force', label: 'Delete anyway', danger: true }],
    });
    if (choice === 'force') await act(() => ipc.gitBranchDelete(root, name, true), 'Could not delete the branch');
  }
}

export async function stashPush(root) {
  const message = await promptDialog({ title: 'Stash changes', message: 'Tracked changes are saved and removed from the working tree. Untracked files are included.', placeholder: 'Message (optional)', value: 'WIP', confirmLabel: 'Stash' });
  if (message === null) return null;
  return act(() => ipc.gitStash(root, 'push', null, message, true), 'Could not stash');
}

export async function stashAction(root, name, action) {
  if (action === 'drop' && !(await confirmDialog({ title: `Drop ${name}?`, message: 'The stashed changes are deleted.', confirmLabel: 'Drop', danger: true }))) return null;
  return act(() => ipc.gitStash(root, action, name, null, null), `Stash ${action} failed`);
}

export async function historyOperation(root, action, target) {
  const confirmations = {
    revert: { title: `Revert commit ${target}?`, message: 'A new commit that undoes its changes is created.', confirmLabel: 'Revert' },
    cherryPick: { title: `Cherry-pick ${target}?`, message: 'The commit is applied on top of the current branch.', confirmLabel: 'Cherry-pick' },
    merge: { title: `Merge “${target}” into the current branch?`, confirmLabel: 'Merge' },
    rebase: { title: `Rebase the current branch onto “${target}”?`, message: 'Rewrites the commits of the current branch. Do not rebase commits that others already use.', confirmLabel: 'Rebase' },
  };
  if (confirmations[action] && !(await confirmDialog(confirmations[action]))) return null;
  return act(() => ipc.gitOperation(root, action, target ?? null, null), 'Git operation failed');
}

export async function resetTo(root, sha) {
  const choice = await choiceDialog({
    title: `Reset the current branch to ${sha}?`,
    message: 'Soft keeps all changes staged; Mixed keeps them as unstaged changes; Hard DISCARDS all uncommitted changes and cannot be undone.',
    choices: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'soft', label: 'Soft' },
      { id: 'mixed', label: 'Mixed', primary: true },
      { id: 'hard', label: 'Hard (discard changes)', danger: true },
    ],
  });
  if (!choice || choice === 'cancel') return null;
  if (choice === 'hard' && !(await confirmDialog({ title: 'Discard all uncommitted changes?', message: 'This is a hard reset. Uncommitted changes in tracked files are lost permanently.', confirmLabel: 'Hard reset', danger: true }))) return null;
  return act(() => ipc.gitOperation(root, 'reset', sha, choice), 'Reset failed');
}

export async function cloneRepository() {
  const url = await promptDialog({ title: 'Clone repository', message: 'You will choose the parent folder next. The repository opens as the workspace afterwards (in Restricted Mode until you trust it).', placeholder: 'https://github.com/owner/repo.git', confirmLabel: 'Choose folder…', validate: (v) => (/^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/.test(v) ? null : 'Use an https://, ssh:// or user@host:path URL') });
  if (!url) return null;
  notify({ title: 'Cloning…', message: url, source: 'git' });
  return openWith(() => ipc.gitClone(url), 'Clone failed');
}
