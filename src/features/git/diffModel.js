// Diff page state and the actions that open it (kept apart from the heavy diff view so the view
// and @codemirror/merge load only when a diff is shown).
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { showPage } from '../../workspace/store.js';
import { activeRepo, gitStore, toWorkspacePath } from './model.js';

/** @typedef {{ title: string, root: number, path: string, original: string, modified: string, openRef?: { root: number, path: string } | null }} DiffData */
export const diffStore = createStore(/** @type {DiffData | null} */ (null));

/**
 * Show the diff of a status entry. `staged`: HEAD ↔ index; otherwise index ↔ working tree.
 * @param {number} root @param {import('./model.js').FileStatus} f @param {boolean} staged
 */
export async function openStatusDiff(root, f, staged) {
  const repo = gitStore.get().repos.find((r) => r.root === root);
  if (!repo) return;
  const wsPath = toWorkspacePath(repo, f.path);
  try {
    let original = '';
    let modified = '';
    if (staged) {
      original = (await ipc.gitShow(root, 'HEAD', f.orig ?? f.path)) ?? '';
      modified = (await ipc.gitShow(root, ':0', f.path)) ?? '';
    } else {
      if (!f.untracked) original = (await ipc.gitShow(root, ':0', f.path)) ?? (await ipc.gitShow(root, 'HEAD', f.path)) ?? '';
      if (f.worktree !== 'D' && wsPath !== null) modified = (await ipc.docRead({ root, path: wsPath })).content;
    }
    diffStore.set({
      title: `${f.path} (${staged ? 'staged' : f.untracked ? 'untracked' : 'working tree'})`,
      root,
      path: f.path,
      original: original.replace(/\r\n/g, '\n'),
      modified: modified.replace(/\r\n/g, '\n'),
      openRef: wsPath !== null && f.worktree !== 'D' ? { root, path: wsPath } : null,
    });
    showPage('diff');
  } catch (e) {
    notify({ severity: 'error', title: 'Could not show the diff', message: errorMessage(e), source: 'git' });
  }
}

/** Diff of one file in a commit (parent ↔ commit). */
export async function openCommitDiff(root, sha, file) {
  const repo = gitStore.get().repos.find((r) => r.root === root) ?? activeRepo();
  try {
    const original = file.status === 'A' ? '' : ((await ipc.gitShow(root, `${sha}^`, file.orig ?? file.path)) ?? '');
    const modified = file.status === 'D' ? '' : ((await ipc.gitShow(root, sha, file.path)) ?? '');
    const wsPath = repo ? toWorkspacePath(repo, file.path) : null;
    diffStore.set({ title: `${file.path} @ ${sha.slice(0, 8)}`, root, path: file.path, original, modified, openRef: wsPath !== null ? { root, path: wsPath } : null });
    showPage('diff');
  } catch (e) {
    notify({ severity: 'error', title: 'Could not show the diff', message: errorMessage(e), source: 'git' });
  }
}
