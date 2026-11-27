// Keeps the Git model in sync with the workspace (switches, trust changes) and file changes.
import * as ipc from '../../platform/ipc.js';
import { workspaceStore } from '../../workspace/store.js';
import { gitStore, loadRepos, onFsChangedGit } from './model.js';

let installed = false;
export function installGit() {
  if (installed) return;
  installed = true;
  ipc.onEvent(ipc.events.fsChanged, onFsChangedGit);
  let key = '';
  workspaceStore.subscribe(() => {
    const ws = workspaceStore.get().current;
    const next = ws ? `${ws.record.id}|${ws.trust.capabilities.includes('workspaceExecutables')}` : '';
    if (next === key) return;
    key = next;
    gitStore.set((s) => ({ ...s, state: 'idle', repos: [], status: {} }));
    loadRepos();
  });
}
