// User keyboard shortcuts: persisted in the UI state database (`ui.keybindings`) and layered on
// top of the defaults. Changing a default records a removal (`-command`) plus the new binding,
// so resetting a command restores its default exactly.
import { keybindingStore, setUserKeybindings } from '../../core/keybindings.js';
import { notify } from '../../core/notifications.js';
import { uiLog } from '../../core/output.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';

export const USER_KEY = 'ui.keybindings';
const MAX_USER = 500;

export async function loadUserKeybindings() {
  if (!ipc.isTauri()) return;
  try {
    const raw = await ipc.uiStateGet(USER_KEY);
    if (raw == null) return;
    const { rejected } = setUserKeybindings(raw);
    if (rejected.length) uiLog('warn', `ignored ${rejected.length} invalid user keybinding(s)`);
  } catch (e) {
    uiLog('warn', `could not load user keybindings: ${errorMessage(e)}`);
  }
}

/** @param {import('../../core/keybindings.js').Keybinding[]} list */
async function saveUser(list) {
  const clean = list.slice(0, MAX_USER).map(({ key, command, when, args }) => ({ key, command, ...(when ? { when } : {}), ...(args !== undefined ? { args } : {}) }));
  setUserKeybindings(clean);
  if (!ipc.isTauri()) return;
  try {
    await ipc.uiStateSet(USER_KEY, clean);
  } catch (e) {
    notify({ severity: 'error', title: 'Could not save keyboard shortcuts', message: errorMessage(e), source: 'keybindings' });
  }
}

const user = () => keybindingStore.get().user;
const same = (a, b) => a.key === b.key && a.command === b.command && (a.when || '') === (b.when || '');

/**
 * Bind `chord` to `command`, replacing `previous` (an effective binding) when given.
 * @param {string} command
 * @param {string} chord normalized chord
 * @param {{ key: string, command: string, when?: string, source: 'default' | 'user' } | null} [previous]
 */
export function assignKeybinding(command, chord, previous = null) {
  let list = [...user()];
  if (previous) list = removalOf(list, previous);
  list.push({ key: chord, command, when: previous?.when });
  return saveUser(list);
}

function removalOf(list, b) {
  if (b.source === 'user') return list.filter((u) => !same(u, b));
  return [...list.filter((u) => !(u.command === `-${b.command}` && u.key === b.key)), { key: b.key, command: `-${b.command}` }];
}

/** Remove one effective binding (a default is disabled, a user binding deleted). */
export function removeKeybinding(b) {
  return saveUser(removalOf([...user()], b));
}

/** Replace all user shortcuts (settings import). Invalid entries are dropped. */
export function replaceUserKeybindings(list) {
  const { accepted } = setUserKeybindings(list);
  return saveUser(accepted);
}

/** Drop all user changes for a command (restores its defaults). */
export function resetKeybindings(command) {
  return saveUser(user().filter((u) => u.command !== command && u.command !== `-${command}`));
}

/** True when the user changed anything for `command`. */
export const isModified = (command, list = user()) => list.some((u) => u.command === command || u.command === `-${command}`);
