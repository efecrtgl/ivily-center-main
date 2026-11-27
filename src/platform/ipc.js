// The only module that talks to the Tauri backend. Features call these wrappers, never
// `@tauri-apps/api` directly, so the IPC surface stays auditable in one place.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** True when running inside the Tauri webview (false in unit tests / plain browser). */
export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Invoke a backend command. Errors arrive as `{ code, message }` (see src-tauri/src/error.rs).
 * @template T
 * @param {string} command
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<T>}
 */
export async function call(command, args) {
  return invoke(command, args);
}

/**
 * Subscribe to a backend event. Returns an unsubscribe function (sync; safe in effects).
 * @param {string} event
 * @param {(payload: any) => void} handler
 */
export function onEvent(event, handler) {
  if (!isTauri()) return () => {};
  let unlisten = null;
  let cancelled = false;
  listen(event, (e) => handler(e.payload)).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}

export const events = {
  settingsChanged: 'settings://changed',
  outputEntry: 'output://entry',
};

/**
 * @typedef {{ mode: 'persistent' | 'memory', path: string | null, schemaVersion: number, expectedSchemaVersion: number }} DbHealth
 * @typedef {{ severity: 'info' | 'warning' | 'error', code: string, message: string }} StartupIssue
 * @returns {Promise<{ name: string, version: string, database: DbHealth, startupIssues: StartupIssue[] }>}
 */
export const appInfo = () => call('app_info');

// ── Settings ─────────────────────────────────────────────────────────────────
/** `workspace` always means the workspace open in this window (resolved by the backend). */
/** @typedef {'user' | 'workspace'} SettingScope */

export const settingsSchema = () => call('settings_schema');
/** Resolved values for this window: default < user < its workspace. */
export const settingsValues = () => call('settings_values');
/** @param {string} key @param {unknown} value @param {SettingScope} [scope] */
export const settingsSet = (key, value, scope = 'user') => call('settings_set', { key, value, scope });
/** @param {string} key @param {SettingScope} [scope] */
export const settingsReset = (key, scope = 'user') => call('settings_reset', { key, scope });

// ── Output ───────────────────────────────────────────────────────────────────
export const outputChannels = () => call('output_channels');
/** @param {string} channel @param {number} [after] */
export const outputRead = (channel, after = 0) => call('output_read', { channel, after });
/** @param {string} channel */
export const outputClear = (channel) => call('output_clear', { channel });
/** @param {string} channel @param {'trace'|'info'|'warn'|'error'} level @param {string} message */
export const outputAppend = (channel, level, message) => call('output_append', { channel, level, message });

// ── UI state ─────────────────────────────────────────────────────────────────
/** @param {string} key `ui.*` */
export const uiStateGet = (key) => call('ui_state_get', { key });
/** @param {string} key `ui.*` @param {unknown} value */
export const uiStateSet = (key, value) => call('ui_state_set', { key, value });

// ── Workspaces ───────────────────────────────────────────────────────────────
// The UI never passes filesystem paths: locations come from native dialogs opened by the backend,
// from known workspace ids, or from opaque tokens returned by the backend.

/**
 * @typedef {{ id: string, kind: 'folder' | 'file', path: string, name: string, favorite: boolean, group: string,
 *             createdAt: number, lastOpenedAt: number, openCount: number }} WorkspaceRecord
 * @typedef {'taskExecution' | 'processLaunch' | 'languageServers' | 'extensions' | 'debugging' | 'workspaceExecutables'} Capability
 * @typedef {{ path: string, pathKey: string, decision: 'trusted' | 'denied' | null, capabilities: Capability[],
 *             source: { kind: 'none' | 'folder' | 'session' } | { kind: 'parent', path: string } }} FolderTrust
 * @typedef {{ level: 'trusted' | 'partial' | 'restricted', capabilities: Capability[], folders: FolderTrust[], needsDecision: boolean }} WorkspaceTrust
 * @typedef {{ name: string, path: string, available: boolean, problem?: string }} WorkspaceFolder
 * @typedef {{ record: WorkspaceRecord, folders: WorkspaceFolder[], file: string | null, trust: WorkspaceTrust }} WorkspaceInfo
 */

/** @returns {Promise<WorkspaceRecord[]>} */
export const workspaceList = () => call('workspace_list');
/** @param {string[]} ids @returns {Promise<{ id: string, status: 'available' | 'missing' | 'inaccessible' | 'unreachable' }[]>} */
export const workspaceAvailability = (ids) => call('workspace_availability', { ids });
/** @returns {Promise<WorkspaceInfo | null>} */
export const workspaceCurrent = () => call('workspace_current');
/** Native dialog; resolves to null when cancelled. @param {'folder' | 'file'} kind @returns {Promise<WorkspaceInfo | null>} */
export const workspaceOpenDialog = (kind) => call('workspace_open_dialog', { kind });
/** @param {string} id @returns {Promise<WorkspaceInfo>} */
export const workspaceOpenRecent = (id) => call('workspace_open_recent', { id });
/** @param {string} token @returns {Promise<WorkspaceInfo>} */
export const workspaceOpenDiscovered = (token) => call('workspace_open_discovered', { token });
export const workspaceClose = () => call('workspace_close');
/** @returns {Promise<{ show: 'workspace' | 'launcher' | 'welcome', workspace: WorkspaceInfo | null,
 *   health: { previousCrashed: boolean, safeMode: boolean }, problem: string | null }>} */
export const workspaceStartup = () => call('workspace_startup');
/** @param {string} id @param {{ name?: string, favorite?: boolean, group?: string }} patch @returns {Promise<WorkspaceRecord>} */
export const workspaceUpdateMeta = (id, patch) => call('workspace_update_meta', { id, patch });
/** @param {string} id */
export const workspaceRemove = (id) => call('workspace_remove', { id });
/** Native dialog; null when cancelled. @param {string} id @returns {Promise<WorkspaceRecord | null>} */
export const workspaceRelocate = (id) => call('workspace_relocate', { id });
/** Native dialog; null when cancelled.
 * @returns {Promise<{ root: string, projects: { token: string, name: string, path: string, markers: string[], knownWorkspaceId: string | null }[] } | null>} */
export const workspaceDiscover = () => call('workspace_discover');
/** Native save dialog; null when cancelled.
 * @returns {Promise<{ status: 'saved', workspace: WorkspaceInfo } | { status: 'confirmOverwrite', token: string, path: string } | null>} */
export const workspaceSaveAs = () => call('workspace_save_as');
/** @param {string} token */
export const workspaceSaveAsConfirm = (token) => call('workspace_save_as_confirm', { token });
/** @returns {Promise<WorkspaceInfo>} */
export const workspaceReloadFile = () => call('workspace_reload_file');

// ── Trust ────────────────────────────────────────────────────────────────────
/** @returns {Promise<WorkspaceTrust | null>} */
export const trustCurrent = () => call('trust_current');
/** @param {{ scope: 'folder' | 'parent', capabilities?: Capability[] | null, remember: boolean }} request @returns {Promise<WorkspaceTrust>} */
export const trustGrant = (request) => call('trust_grant', { request });
/** @returns {Promise<WorkspaceTrust>} */
export const trustDeny = () => call('trust_deny');
/** @returns {Promise<{ path: string, pathKey: string, decision: 'trusted' | 'denied', includeChildren: boolean,
 *   capabilities: Capability[], persistent: boolean, updatedAt: number }[]>} */
export const trustList = () => call('trust_list');
/** @param {string} pathKey */
export const trustRevoke = (pathKey) => call('trust_revoke', { pathKey });

// ── Session ──────────────────────────────────────────────────────────────────
/** @returns {Promise<{ state: Record<string, unknown> | null, recovered: boolean }>} */
export const sessionLoad = () => call('session_load');
/** @param {Record<string, unknown>} session */
export const sessionSave = (session) => call('session_save', { session });
export const sessionReady = () => call('session_ready');
