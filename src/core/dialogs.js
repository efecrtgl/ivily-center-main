// In-app modal dialogs (confirmations and multi-choice). One dialog at a time; requests queue.
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

/**
 * @typedef {{ id: string, label: string, primary?: boolean, danger?: boolean }} Choice
 * @typedef {{ title: string, message?: string, detail?: string, choices: Choice[] }} ChoiceRequest
 */

/** @type {import('./store.js').Store<{ queue: ((ConfirmRequest | ChoiceRequest) & { id: number, resolve: (v: any) => void })[] }>} */
export const dialogStore = createStore({ queue: [] });
let nextId = 1;

/**
 * Ask the user to confirm. Resolves `true` only on explicit confirmation.
 * @param {ConfirmRequest} req
 * @returns {Promise<boolean>}
 */
export function confirmDialog(req) {
  return choiceDialog({
    title: req.title,
    message: req.message,
    detail: req.detail,
    choices: [
      { id: 'cancel', label: req.cancelLabel ?? 'Cancel' },
      { id: 'ok', label: req.confirmLabel ?? 'OK', primary: !req.danger, danger: req.danger },
    ],
  }).then((c) => c === 'ok');
}

/**
 * Ask the user to choose. Resolves to the chosen id, or `null` when dismissed (Escape).
 * The first choice receives focus, so put the safe option first.
 * @param {ChoiceRequest} req
 * @returns {Promise<string | null>}
 */
export function choiceDialog(req) {
  return new Promise((resolve) => {
    dialogStore.set((s) => ({ queue: [...s.queue, { ...req, id: nextId++, resolve }] }));
  });
}

/** @param {number} id @param {string | null} choice */
export function answerDialog(id, choice) {
  const item = dialogStore.get().queue.find((d) => d.id === id);
  dialogStore.set((s) => ({ queue: s.queue.filter((d) => d.id !== id) }));
  item?.resolve(choice);
}

/**
 * Ask for a line of text. Resolves to the entered value, or `null` when cancelled.
 * `validate` returns an error message (shown inline) or null.
 * @param {{ title: string, message?: string, placeholder?: string, value?: string, confirmLabel?: string, validate?: (v: string) => string | null }} req
 * @returns {Promise<string | null>}
 */
export function promptDialog(req) {
  return new Promise((resolve) => {
    dialogStore.set((s) => ({
      queue: [
        ...s.queue,
        {
          title: req.title,
          message: req.message,
          input: { placeholder: req.placeholder ?? '', value: req.value ?? '', validate: req.validate },
          choices: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'ok', label: req.confirmLabel ?? 'OK', primary: true },
          ],
          id: nextId++,
          resolve,
        },
      ],
    }));
  });
}
