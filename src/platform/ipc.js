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
  fsChanged: 'fs://changed',
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

// ── Files (workspace-scoped: root index + relative path) ─────────────────────
/**
 * @typedef {{ root: number, path: string }} ItemRef
 * @typedef {{ name: string, kind: 'file' | 'dir' | 'link', size: number, modified: number, hidden: boolean, ignored: boolean, readonly: boolean }} FsEntry
 */
/** @returns {Promise<{ entries: FsEntry[], truncated: boolean, ignored: boolean }>} */
export const fsList = (root, path) => call('fs_list', { root, path });
export const fsCreateFile = (root, path) => call('fs_create_file', { root, path });
export const fsCreateDir = (root, path) => call('fs_create_dir', { root, path });
export const fsRename = (root, path, newName) => call('fs_rename', { root, path, newName });
/** @param {ItemRef[]} items @param {ItemRef} dest @param {'fail' | 'rename'} onConflict */
export const fsCopy = (items, dest, onConflict) => call('fs_copy', { items, dest, onConflict });
/** @param {ItemRef[]} items @param {ItemRef} dest */
export const fsMove = (items, dest) => call('fs_move', { items, dest });
export const fsDuplicate = (root, path) => call('fs_duplicate', { root, path });
/** @param {ItemRef[]} items */
export const fsTrash = (items) => call('fs_trash', { items });
/** @param {ItemRef[]} items */
export const fsDeletePermanently = (items) => call('fs_delete_permanently', { items });
export const fsProperties = (root, path) => call('fs_properties', { root, path });
export const fsReveal = (root, path) => call('fs_reveal', { root, path });

// ── Editor documents ─────────────────────────────────────────────────────────
/**
 * @typedef {{ root: number, path: string } | { external: string }} DocRef
 * @typedef {'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252'} TextEncoding
 * @typedef {{ ref: DocRef, name: string, location: string, content: string, encoding: TextEncoding, eol: 'lf' | 'crlf',
 *             mixedEol: boolean, hash: string, size: number, readonly: boolean, modified: number }} OpenedDoc
 */
/** @returns {Promise<OpenedDoc>} */
export const docRead = (doc) => call('doc_read', { doc });
/** @returns {Promise<{ hash: string, size: number, modified: number }>} */
export const docWrite = (doc, content, encoding, eol, expectedHash, create = false) =>
  call('doc_write', { doc, content, encoding, eol, expectedHash: expectedHash ?? null, create });
/** @returns {Promise<DocRef[] | null>} */
export const docOpenDialog = () => call('doc_open_dialog');
export const docSaveAsDialog = (suggestedName, content, encoding, eol) => call('doc_save_as_dialog', { suggestedName, content, encoding, eol });
export const docSaveAsConfirm = (token, content, encoding, eol) => call('doc_save_as_confirm', { token, content, encoding, eol });
export const draftSave = (draft) => call('draft_save', { draft });
/** @returns {Promise<{ key: string, content: string, encoding: TextEncoding, eol: 'lf' | 'crlf', baseHash: string | null, savedAt: number }[]>} */
export const draftList = () => call('draft_list');
export const draftDelete = (key) => call('draft_delete', { key });

// ── Toolchains ───────────────────────────────────────────────────────────────
/** @returns {Promise<{ tools: { id: string, name: string, category: string, status: 'available' | 'notFound' | 'storeAlias' | 'unverified',
 *   version: string | null, path: string | null, homepage: string, winget: string | null }[], relevant: string[], detectedAt: number }>} */
export const toolchainsDetect = (refresh = false) => call('toolchains_detect', { refresh });
/** Opens the official download page of a known tool (by id). */
export const toolchainsOpenHomepage = (id) => call('toolchains_open_homepage', { id });

// ── Language servers ─────────────────────────────────────────────────────────
export const lspServers = () => call('lsp_servers');
/** Starts (or reuses) a server for this window's workspace; requires the languageServers trust capability. */
export const lspStart = (server) => call('lsp_start', { server });
export const lspSend = (id, message) => call('lsp_send', { id, message });
export const lspStop = (id) => call('lsp_stop', { id });

// ── Terminal ─────────────────────────────────────────────────────────────────
/** @returns {Promise<{ id: string, name: string, path: string, args: string[], source: string }[]>} */
export const terminalProfiles = (refresh = false) => call('terminal_profiles', { refresh });
/** Starts a shell; output arrives on `onData` (a Tauri Channel delivering ArrayBuffers). */
export const terminalCreate = (profile, root, cols, rows, onData) => call('terminal_create', { profile, root, cols, rows, onData });
export const terminalWrite = (id, data) => call('terminal_write', { id, data });
export const terminalResize = (id, cols, rows) => call('terminal_resize', { id, cols, rows });
export const terminalKill = (id) => call('terminal_kill', { id });
/** Opens an http(s) link in the default browser (validated by the backend). */
export const openExternalUrl = (url) => call('open_external_url', { url });

// ── Search ───────────────────────────────────────────────────────────────────
/**
 * @typedef {{ pattern: string, isRegex?: boolean, caseSensitive?: boolean, wholeWord?: boolean, include?: string[], exclude?: string[], useIgnore?: boolean, maxResults?: number }} SearchQuery
 */
/** Streams `{ root, path, matches }[]` batches on `onResults` (a Channel); resolves to the summary. */
export const searchRun = (id, query, onResults) => call('search_run', { id, query, onResults });
export const searchCancel = (id) => call('search_cancel', { id });
/** Replace in confirmed files; returns per-file results (files that changed are skipped). */
export const searchReplace = (query, replacement, files) => call('search_replace', { query, replacement, files });
/** Fuzzy file search over the cached workspace index. */
export const quickOpen = (query, limit) => call('quick_open', { query, limit });

// ── Git (requires the workspaceExecutables trust capability) ─────────────────
export const gitRepos = () => call('git_repos');
export const gitStatus = (root) => call('git_status', { root });
export const gitStage = (root, paths) => call('git_stage', { root, paths });
export const gitUnstage = (root, paths) => call('git_unstage', { root, paths });
export const gitDiscard = (root, paths) => call('git_discard', { root, paths });
export const gitCommit = (root, message, amend, all) => call('git_commit', { root, message, amend, all });
export const gitBranches = (root) => call('git_branches', { root });
export const gitBranchCreate = (root, name, start, checkout) => call('git_branch_create', { root, name, start, checkout });
export const gitSwitch = (root, name, remote) => call('git_switch', { root, name, remote });
export const gitBranchDelete = (root, name, force) => call('git_branch_delete', { root, name, force });
export const gitLog = (root, rev, path, skip, limit) => call('git_log', { root, rev, path, skip, limit });
export const gitCommitFiles = (root, sha) => call('git_commit_files', { root, sha });
export const gitShow = (root, rev, path) => call('git_show', { root, rev, path });
/** @param {'fetch' | 'pull' | 'pullRebase' | 'push'} action */
export const gitSync = (root, action, setUpstream) => call('git_sync', { root, action, setUpstream });
export const gitStashes = (root) => call('git_stashes', { root });
export const gitStash = (root, action, name, message, includeUntracked) => call('git_stash', { root, action, name, message, includeUntracked });
export const gitRemotes = (root) => call('git_remotes', { root });
export const gitRemote = (root, action, name, url) => call('git_remote', { root, action, name, url });
export const gitTags = (root) => call('git_tags', { root });
export const gitTag = (root, action, name, message, sha) => call('git_tag', { root, action, name, message, sha });
export const gitOperation = (root, action, target, mode) => call('git_operation', { root, action, target, mode });
export const gitInit = (root) => call('git_init', { root });
export const gitIgnore = (root, pattern) => call('git_ignore', { root, pattern });
export const gitClone = (url) => call('git_clone', { url });
