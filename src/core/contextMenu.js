// Context menus: one open menu at a time, rendered by shell/ContextMenu.jsx.
import { createStore } from './store.js';

/**
 * @typedef {{ label: string, run?: () => void, disabled?: boolean, danger?: boolean, keybinding?: string } | { separator: true }} MenuItem
 */

/** @type {import('./store.js').Store<{ x: number, y: number, items: MenuItem[] } | null>} */
export const contextMenuStore = createStore(null);

/**
 * @param {{ clientX: number, clientY: number, preventDefault?: () => void }} event
 * @param {MenuItem[]} items
 */
export function openContextMenu(event, items) {
  event.preventDefault?.();
  const visible = items.filter((it, i, arr) => {
    if (!('separator' in it)) return true;
    // Drop leading, trailing and duplicate separators.
    return i > 0 && i < arr.length - 1 && !('separator' in arr[i - 1]);
  });
  contextMenuStore.set({ x: event.clientX, y: event.clientY, items: visible });
}

export const closeContextMenu = () => contextMenuStore.set(null);
