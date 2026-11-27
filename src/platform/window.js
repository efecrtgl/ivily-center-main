// Window controls for the custom title bar. Outside Tauri these are no-ops.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from './ipc.js';

const win = () => (isTauri() ? getCurrentWindow() : null);

export const minimizeWindow = () => win()?.minimize();
export const toggleMaximizeWindow = () => win()?.toggleMaximize();
export const closeWindow = () => win()?.close();
export const isWindowMaximized = async () => (await win()?.isMaximized()) ?? false;
/** @param {string} title */
export const setWindowTitle = (title) => win()?.setTitle(title);

/**
 * Call `fn(maximized)` whenever the window is resized (maximize/restore changes the control icon).
 * @param {(maximized: boolean) => void} fn
 * @returns {() => void}
 */
export function onMaximizeChange(fn) {
  const w = win();
  if (!w) return () => {};
  let unlisten = null;
  let cancelled = false;
  const check = () => w.isMaximized().then(fn).catch(() => {});
  check();
  w.onResized(check).then((u) => (cancelled ? u() : (unlisten = u)));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * Run `fn` before the window closes (e.g. flush the session). The window closes afterwards even
 * if `fn` fails; `fn` is bounded by a timeout so a hung save cannot block closing.
 * @param {() => Promise<void>} fn
 * @returns {() => void}
 */
export function beforeWindowClose(fn, timeoutMs = 2000) {
  const w = win();
  if (!w) return () => {};
  let unlisten = null;
  let cancelled = false;
  w.onCloseRequested(async () => {
    await Promise.race([fn().catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
  }).then((u) => (cancelled ? u() : (unlisten = u)));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
