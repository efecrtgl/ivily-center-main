// Which status-bar popover is open (shared with commands such as "Show Notifications").
import { createStore } from '../core/store.js';
import { setContext } from '../core/context.js';

/** @type {import('../core/store.js').Store<{ popover: null | 'theme' | 'notifications' }>} */
export const statusUi = createStore({ popover: null });

/** @param {null | 'theme' | 'notifications'} popover */
export function setStatusPopover(popover) {
  statusUi.set({ popover });
  setContext('notificationCenterOpen', popover === 'notifications');
}
