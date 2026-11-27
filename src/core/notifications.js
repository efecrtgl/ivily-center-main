// Notifications: one store for the notification centre (history) and transient toasts.
//
// Every notification is kept in the centre (bounded). Whether it also pops up as a toast is
// decided by `shouldToast` from the user's preferences, so subsystems never need to know about
// Do Not Disturb or severity filters.
import { createStore } from './store.js';

/** @typedef {'info' | 'warning' | 'error'} Severity */

/**
 * @typedef {object} NotificationAction
 * @property {string} label
 * @property {string} [command]  Command id executed when chosen.
 * @property {unknown} [args]
 */

/**
 * @typedef {object} Notification
 * @property {number} id
 * @property {Severity} severity
 * @property {string} title
 * @property {string} [message]
 * @property {string} source       Subsystem that raised it, e.g. `settings`, `git`.
 * @property {NotificationAction[]} actions
 * @property {number} ts
 * @property {number} count        Identical notifications are collapsed and counted.
 * @property {boolean} read
 * @property {boolean} toast       Currently shown as a pop-up.
 * @property {boolean} sticky      Toast stays until dismissed.
 */

const SEVERITY_RANK = { info: 0, warning: 1, error: 2 };
const HISTORY_LIMIT = 200;
const MAX_TOASTS = 4;

/** @type {import('./store.js').Store<{ items: Notification[], prefs: { level: Severity, doNotDisturb: boolean, timeoutSeconds: number } }>} */
export const notificationStore = createStore({
  items: [],
  prefs: { level: 'info', doNotDisturb: false, timeoutSeconds: 6 },
});

let nextId = 1;
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const timers = new Map();

/**
 * Pure decision: should a notification of `severity` pop up?
 * @param {Severity} severity
 * @param {{ level: Severity, doNotDisturb: boolean }} prefs
 */
export function shouldToast(severity, prefs) {
  if (prefs.doNotDisturb) return severity === 'error';
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[prefs.level];
}

/** @param {Partial<{ level: Severity, doNotDisturb: boolean, timeoutSeconds: number }>} prefs */
export function setNotificationPrefs(prefs) {
  notificationStore.set((s) => ({ ...s, prefs: { ...s.prefs, ...prefs } }));
}

function scheduleHide(n) {
  clearTimeout(timers.get(n.id));
  if (n.sticky) return;
  const ms = notificationStore.get().prefs.timeoutSeconds * 1000;
  timers.set(n.id, setTimeout(() => hideToast(n.id), ms));
}

/**
 * Raise a notification. Returns its id.
 * @param {{ severity?: Severity, title: string, message?: string, source?: string, actions?: NotificationAction[], sticky?: boolean }} input
 */
export function notify(input) {
  const severity = /** @type {Severity} */ (SEVERITY_RANK[input.severity] !== undefined ? input.severity : 'info');
  const title = String(input.title ?? '').slice(0, 300) || 'Notification';
  const message = input.message === undefined ? undefined : String(input.message).slice(0, 4000);
  const source = input.source || 'app';
  const { prefs, items } = notificationStore.get();
  const toast = shouldToast(severity, prefs);
  const sticky = input.sticky ?? severity === 'error';

  // Collapse duplicates that are still unread.
  const dup = items.find((n) => !n.read && n.severity === severity && n.title === title && n.message === message && n.source === source);
  if (dup) {
    const updated = { ...dup, count: dup.count + 1, ts: Date.now(), toast: dup.toast || toast };
    notificationStore.set((s) => ({ ...s, items: s.items.map((n) => (n.id === dup.id ? updated : n)) }));
    if (updated.toast) scheduleHide(updated);
    return dup.id;
  }

  /** @type {Notification} */
  const n = { id: nextId++, severity, title, message, source, actions: input.actions || [], ts: Date.now(), count: 1, read: false, toast, sticky };
  notificationStore.set((s) => {
    let list = [n, ...s.items];
    // Keep at most MAX_TOASTS visible: hide the oldest non-sticky ones first.
    const visible = list.filter((x) => x.toast);
    if (visible.length > MAX_TOASTS) {
      const drop = new Set(visible.slice(MAX_TOASTS).map((x) => x.id));
      list = list.map((x) => (drop.has(x.id) ? { ...x, toast: false } : x));
    }
    return { ...s, items: list.slice(0, HISTORY_LIMIT) };
  });
  if (toast) scheduleHide(n);
  return n.id;
}

/** Hide a toast but keep the notification in the centre. */
export function hideToast(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  notificationStore.set((s) => ({ ...s, items: s.items.map((n) => (n.id === id && n.toast ? { ...n, toast: false } : n)) }));
}

/** Remove a notification entirely. */
export function dismiss(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  notificationStore.set((s) => ({ ...s, items: s.items.filter((n) => n.id !== id) }));
}

export function clearAll() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  notificationStore.set((s) => ({ ...s, items: [] }));
}

export function markAllRead() {
  notificationStore.set((s) => ({ ...s, items: s.items.map((n) => (n.read ? n : { ...n, read: true })) }));
}

/** @param {{ items: Notification[] }} s */
export const unreadCount = (s) => s.items.reduce((c, n) => c + (n.read ? 0 : 1), 0);

/** Test helper. */
export function _resetNotifications() {
  clearAll();
  nextId = 1;
  setNotificationPrefs({ level: 'info', doNotDisturb: false, timeoutSeconds: 6 });
}
