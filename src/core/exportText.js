// Save generated text to a file the user picks (native dialog in the backend). Overwriting an
// existing file needs an explicit confirmation.
import * as ipc from '../platform/ipc.js';
import { confirmDialog } from './dialogs.js';
import { notify } from './notifications.js';
import { errorMessage } from './errors.js';

/**
 * @param {{ title: string, suggestedName: string, extension: string, content: string }} req
 * @returns {Promise<string | null>} saved path, or null when cancelled
 */
export async function exportText({ title, suggestedName, extension, content }) {
  if (!ipc.isTauri()) return null;
  try {
    let r = await ipc.saveTextDialog(title, suggestedName, extension, content);
    if (!r) return null;
    if (r.kind === 'confirmOverwrite') {
      const ok = await confirmDialog({ title: 'Replace the existing file?', message: 'The chosen file already exists. Its contents will be replaced.', detail: r.path, confirmLabel: 'Replace', danger: true });
      if (!ok) return null;
      r = await ipc.saveTextConfirm(r.token, content);
    }
    notify({ title: 'Saved', message: r.path, source: 'export' });
    return r.path;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not save the file', message: errorMessage(e), source: 'export' });
    return null;
  }
}
