// Workspace Trust actions and descriptions. The backend is authoritative: it evaluates trust
// and every subsystem that would execute workspace-controlled content checks it there. The UI
// only explains the state and records the user's explicit decisions.
import { notify } from '../core/notifications.js';
import { errorMessage } from '../core/errors.js';
import * as ipc from '../platform/ipc.js';
import { updateCurrent, workspaceStore } from './store.js';

/** @type {{ id: import('../platform/ipc.js').Capability, title: string, description: string }[]} */
export const CAPABILITIES = [
  { id: 'taskExecution', title: 'Run workspace tasks', description: 'Build, test and script tasks defined by the workspace.' },
  { id: 'processLaunch', title: 'Start workspace-defined processes', description: 'Terminal profiles, launch configurations and other programs configured by the workspace.' },
  { id: 'languageServers', title: 'Start workspace-configured language servers', description: 'Language servers whose command or arguments come from workspace configuration.' },
  { id: 'extensions', title: 'Activate workspace extensions', description: 'Extensions recommended or configured by the workspace.' },
  { id: 'debugging', title: 'Start debug sessions', description: 'Debugger launch configurations defined by the workspace.' },
  { id: 'workspaceExecutables', title: 'Use executables from workspace settings', description: 'Settings in the workspace that point to programs or scripts.' },
];

export const LEVEL_LABEL = { trusted: 'Trusted', partial: 'Partially trusted', restricted: 'Restricted Mode' };

/** Parent folder of a path for display (`C:\code\app` → `C:\code`). */
export function parentOf(path) {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (i <= 0) return null;
  const parent = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? null : parent; // a drive root cannot be trusted with children
}

/**
 * @param {{ scope: 'folder' | 'parent', capabilities?: import('../platform/ipc.js').Capability[] | null, remember: boolean }} request
 */
export async function grantTrust(request) {
  try {
    const trust = await ipc.trustGrant(request);
    updateCurrent({ trust });
    workspaceStore.set((s) => ({ ...s, trustPrompt: false }));
    notify({
      title: trust.level === 'trusted' ? 'Workspace trusted' : 'Workspace partially trusted',
      message: request.remember ? 'You can revoke this at any time in Manage Workspace Trust.' : 'Trust applies until Ivily Center is closed.',
      source: 'trust',
    });
    return trust;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not change trust', message: errorMessage(e), source: 'trust' });
    return null;
  }
}

/** "Stay restricted" — remembered, so the user is not asked again for these folders. */
export async function denyTrust() {
  try {
    const trust = await ipc.trustDeny();
    updateCurrent({ trust });
    workspaceStore.set((s) => ({ ...s, trustPrompt: false }));
    return trust;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not change trust', message: errorMessage(e), source: 'trust' });
    return null;
  }
}

/** Revoke a stored or session decision, then re-evaluate the current workspace. */
export async function revokeTrust(pathKey) {
  try {
    await ipc.trustRevoke(pathKey);
    await refreshTrust();
    return true;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not revoke trust', message: errorMessage(e), source: 'trust' });
    return false;
  }
}

export async function refreshTrust() {
  if (!workspaceStore.get().current || !ipc.isTauri()) return;
  const trust = await ipc.trustCurrent();
  if (trust) updateCurrent({ trust });
}

/** Folders of the current workspace whose decision comes from an exact folder or session record. */
export function revocableDecisions(trust) {
  return (trust?.folders ?? []).filter((f) => f.source.kind === 'folder' || f.source.kind === 'session');
}
