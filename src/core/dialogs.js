// In-app modal dialogs (confirmations). One dialog at a time; requests queue.
import { createStore } from './store.js';

/**
 * @typedef {object} ConfirmRequest
 * @property {string} title
 * @property {string} [message]
 * @property {string} [detail]          Monospace detail (e.g. a path).
 * @property {string} [confirmLabel]
 * @property {string} [cancelLabel]
 * @property {boolean} [danger]
 */

/** @type {import('./store.js').Store<{ queue: (ConfirmRequest & { id: number, resolve: (ok: boolean) => void })[] }>} */
export const dialogStore = createStore({ queue: [] });
let nextId = 1;

/**
 * Ask the user to confirm. Resolves `true` only on explicit confirmation.
 * @param {ConfirmRequest} req
 * @returns {Promise<boolean>}
 */
export function confirmDialog(req) {
  return new Promise((resolve) => {
    dialogStore.set((s) => ({ queue: [...s.queue, { ...req, id: nextId++, resolve }] }));
  });
}

/** @param {number} id @param {boolean} ok */
export function answerDialog(id, ok) {
  const item = dialogStore.get().queue.find((d) => d.id === id);
  dialogStore.set((s) => ({ queue: s.queue.filter((d) => d.id !== id) }));
  item?.resolve(ok);
}
