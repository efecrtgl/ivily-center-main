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
/** @typedef {{ kind: 'user' } | { kind: 'workspace', workspaceId: string }} SettingScope */
const USER = /** @type {SettingScope} */ ({ kind: 'user' });

export const settingsSchema = () => call('settings_schema');
/** @param {string} [workspaceId] */
export const settingsValues = (workspaceId) => call('settings_values', { workspaceId: workspaceId ?? null });
/** @param {string} key @param {unknown} value @param {SettingScope} [scope] */
export const settingsSet = (key, value, scope = USER) => call('settings_set', { key, value, scope });
/** @param {string} key @param {SettingScope} [scope] */
export const settingsReset = (key, scope = USER) => call('settings_reset', { key, scope });

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
