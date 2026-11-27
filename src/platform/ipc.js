// The only module that talks to the Tauri backend. Features call these wrappers, never
// `@tauri-apps/api` directly, so the IPC surface stays auditable in one place.
import { invoke } from '@tauri-apps/api/core';

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

/** @returns {Promise<{ name: string, version: string }>} */
export const appInfo = () => call('app_info');
