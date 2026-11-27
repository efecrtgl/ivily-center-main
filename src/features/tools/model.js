// Toolchain detection results and per-language intelligence status, shared with other features
// (LSP, status bar) without loading the Languages & Tools page.
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';

/** Detection results shared with other features (e.g. LSP server discovery). */
export const toolsStore = createStore(/** @type {null | { tools: any[], relevant: string[], detectedAt: number }} */ (null));

/** Language intelligence status per language id, filled by the LSP manager (Phase 7). */
export const languageIntelStore = createStore(/** @type {Record<string, { server: string, state: string }>} */ ({}));

export async function detectTools(refresh = false) {
  if (!ipc.isTauri()) return null;
  try {
    const r = await ipc.toolchainsDetect(refresh);
    toolsStore.set(r);
    return r;
  } catch (e) {
    notify({ severity: 'error', title: 'Tool detection failed', message: errorMessage(e), source: 'tools' });
    return null;
  }
}
