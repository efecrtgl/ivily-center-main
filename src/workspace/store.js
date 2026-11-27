// Workspace context for this window.
//
// Switching protocol (open, switch, close all go through `transition`):
//   1. flush the current workspace's session (so nothing is lost),
//   2. perform the backend operation (which may be cancelled by the user in a dialog),
//   3. reset every session participant (drop the previous workspace's state),
//   4. bump `epoch` — async work started for the old workspace checks `isCurrentEpoch` and is
//      discarded, so results can never leak into the new workspace,
//   5. publish the new workspace (context keys, title), reload settings for it,
//   6. restore the new workspace's session.
// Transitions are serialized: a second open while one is running is ignored.
import { createStore } from '../core/store.js';
import { setContext } from '../core/context.js';
import { titleStore } from '../core/title.js';
import { notify } from '../core/notifications.js';
import { errorCode, errorMessage } from '../core/errors.js';
import { confirmDialog } from '../core/dialogs.js';
import { refreshValues } from '../core/settings.js';
import { uiLog } from '../core/output.js';
import * as ipc from '../platform/ipc.js';
import { flushSession, resetParticipants, restoreSession, setSessionSink } from './session.js';

/** @typedef {import('../platform/ipc.js').WorkspaceInfo} WorkspaceInfo */
/** @typedef {'launcher' | 'welcome' | 'trust' | 'editor' | 'tools' | 'diff' | 'keybindings' | 'preview' | 'modules'} EditorPage */

/** @type {import('../core/store.js').Store<{ current: WorkspaceInfo | null, epoch: number, busy: boolean, page: EditorPage, trustPrompt: boolean }>} */
export const workspaceStore = createStore({ current: null, epoch: 0, busy: false, page: 'launcher', trustPrompt: false });

/** Recents changed (opened, renamed, removed): launcher lists re-fetch. */
export const recentsVersion = createStore(0);
const bumpRecents = () => recentsVersion.set((v) => v + 1);

export const isCurrentEpoch = (epoch) => epoch === workspaceStore.get().epoch;
export const currentWorkspace = () => workspaceStore.get().current;

/** @param {EditorPage} page */
export function showPage(page) {
  workspaceStore.set((s) => (s.page === page ? s : { ...s, page }));
}

setSessionSink({
  canSave: () => ipc.isTauri() && workspaceStore.get().current !== null && !workspaceStore.get().busy,
  save: (doc) => ipc.sessionSave(doc),
  onError: (e) => uiLog('warn', `session save failed: ${errorMessage(e)}`),
});

/** Update context keys and title for the current workspace/trust. */
function publishContext(ws) {
  const trust = ws?.trust;
  setContext('workspaceOpen', Boolean(ws));
  setContext('workspaceKind', ws?.record.kind ?? '');
  setContext('workspaceFavorite', Boolean(ws?.record.favorite));
  setContext('workspaceTrustLevel', trust?.level ?? '');
  setContext('workspaceTrusted', trust?.level === 'trusted');
  for (const cap of ['taskExecution', 'processLaunch', 'languageServers', 'extensions', 'debugging', 'workspaceExecutables']) {
    setContext(`workspaceTrust.${cap}`, Boolean(trust?.capabilities.includes(cap)));
  }
  titleStore.set((t) => ({ ...t, workspace: ws ? ws.record.name : null, file: null, dirty: false }));
}

/** Replace the current workspace's info (e.g. after a trust change or rename) without switching. */
export function updateCurrent(patch) {
  workspaceStore.set((s) => (s.current ? { ...s, current: { ...s.current, ...patch } } : s));
  publishContext(workspaceStore.get().current);
}

const OPEN_ERRORS = {
  not_found: 'The folder or file no longer exists.',
  permission_denied: 'Access was denied.',
  not_a_directory: 'The selected item is not a folder.',
  invalid_workspace_file: 'The workspace file is invalid.',
  unsupported: 'The workspace file was created by a newer version of Ivily Center.',
};

function reportOpenError(e, title = 'Could not open workspace') {
  const code = errorCode(e);
  notify({ severity: 'error', title, message: OPEN_ERRORS[code] ? `${OPEN_ERRORS[code]}\n${errorMessage(e)}` : errorMessage(e), source: 'workspace' });
}

/**
 * Activate a workspace the backend has opened. Exported for startup and save-as.
 * @param {WorkspaceInfo | null} info
 */
export async function activate(info) {
  resetParticipants();
  workspaceStore.set((s) => ({
    ...s,
    current: info,
    epoch: s.epoch + 1,
    page: info ? 'welcome' : 'launcher',
    trustPrompt: false,
  }));
  publishContext(info);
  try {
    await refreshValues();
  } catch (e) {
    uiLog('error', `settings reload failed: ${errorMessage(e)}`);
  }
  if (info && ipc.isTauri()) {
    const epoch = workspaceStore.get().epoch;
    try {
      const s = await ipc.sessionLoad();
      if (!isCurrentEpoch(epoch)) return;
      restoreSession(s.state);
      if (s.recovered) notify({ severity: 'warning', title: 'Session partly restored', message: 'The latest session state was damaged; the previous one was used.', source: 'workspace' });
    } catch (e) {
      restoreSession(null);
      uiLog('warn', `session load failed: ${errorMessage(e)}`);
    }
  } else {
    restoreSession(null);
  }
  if (info) {
    const unavailable = info.folders.filter((f) => !f.available);
    if (unavailable.length) {
      notify({
        severity: 'warning',
        title: `${unavailable.length} workspace folder(s) unavailable`,
        message: unavailable.map((f) => `${f.name}: ${f.problem ?? f.path}`).join('\n'),
        source: 'workspace',
      });
    }
    if (info.trust.needsDecision) workspaceStore.set((s) => ({ ...s, trustPrompt: true }));
  }
  bumpRecents();
}

/**
 * Serialized open/switch/close.
 * @param {() => Promise<WorkspaceInfo | null | undefined>} op  resolves to the new workspace,
 *   `null` to close, or `undefined` when the user cancelled (nothing changes).
 */
let inFlight = false;

async function transition(op, errorTitle) {
  // Claimed synchronously, before any await, so two quick requests cannot both proceed.
  if (inFlight) return false;
  inFlight = true;
  try {
    await flushSession();
  } catch {
    /* reported by the session sink */
  }
  workspaceStore.set((s) => ({ ...s, busy: true }));
  try {
    const result = await op();
    if (result === undefined) return false;
    await activate(result);
    return true;
  } catch (e) {
    reportOpenError(e, errorTitle);
    bumpRecents();
    return false;
  } finally {
    workspaceStore.set((s) => ({ ...s, busy: false }));
    inFlight = false;
  }
}

const orUndefined = (v) => (v === null ? undefined : v);

export const openFolder = () => transition(async () => orUndefined(await ipc.workspaceOpenDialog('folder')));
export const openWorkspaceFile = () => transition(async () => orUndefined(await ipc.workspaceOpenDialog('file')));
/** @param {string} id */
export const openRecent = (id) => transition(() => ipc.workspaceOpenRecent(id));
/** @param {string} token */
export const openDiscovered = (token) => transition(() => ipc.workspaceOpenDiscovered(token));
export const closeWorkspace = () =>
  transition(async () => {
    if (!workspaceStore.get().current) return undefined;
    await ipc.workspaceClose();
    return null;
  });

/** Reload the workspace file after an external change or a write conflict. */
export const reloadWorkspaceFile = () => transition(() => ipc.workspaceReloadFile(), 'Could not reload the workspace file');

/** Startup result from the backend → initial UI state. */
export async function applyStartup(result) {
  if (result.workspace) {
    await activate(result.workspace);
  } else {
    showPage(result.show === 'welcome' ? 'welcome' : 'launcher');
    publishContext(null);
  }
  if (result.health.safeMode) {
    notify({
      severity: 'warning',
      title: 'Started in safe mode',
      message: 'Ivily Center did not finish starting the last times, so the last workspace was not reopened automatically.',
      source: 'workspace',
      sticky: true,
    });
  } else if (result.health.previousCrashed) {
    notify({ severity: 'info', title: 'Ivily Center did not shut down cleanly', message: 'The workspace session was restored from its last save.', source: 'workspace' });
  }
  if (result.problem) {
    notify({ severity: 'warning', title: 'Could not reopen the last workspace', message: result.problem, source: 'workspace' });
  }
}

/**
 * Save the open workspace as a `*.ivily-workspace` file (native save dialog). An existing file
 * is only replaced after explicit confirmation. The window then switches to the file workspace,
 * carrying the session over.
 */
export const saveWorkspaceAs = () =>
  transition(async () => {
    if (!workspaceStore.get().current) return undefined;
    let result = await ipc.workspaceSaveAs();
    if (!result) return undefined;
    if (result.status === 'confirmOverwrite') {
      const ok = await confirmDialog({
        title: 'Replace the existing file?',
        message: 'A file with this name already exists. Replacing it overwrites its contents.',
        detail: result.path,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return undefined;
      result = await ipc.workspaceSaveAsConfirm(result.token);
    }
    notify({ title: 'Workspace file saved', message: result.workspace.file ?? '', source: 'workspace' });
    return result.workspace;
  }, 'Could not save the workspace file');

/** Toggle the favorite flag of the open workspace. */
export async function toggleCurrentFavorite() {
  const ws = workspaceStore.get().current;
  if (!ws) return;
  try {
    const record = await ipc.workspaceUpdateMeta(ws.record.id, { favorite: !ws.record.favorite });
    updateCurrent({ record });
    bumpRecents();
  } catch (e) {
    notify({ severity: 'error', title: 'Could not update the workspace', message: errorMessage(e), source: 'workspace' });
  }
}

/**
 * Open a workspace produced by another operation (e.g. cloning) through the serialized
 * transition. `op` resolves to the WorkspaceInfo, or null when the user cancelled.
 * @param {() => Promise<WorkspaceInfo | null>} op
 */
export const openWith = (op, errorTitle) => transition(async () => orUndefined(await op()), errorTitle);
