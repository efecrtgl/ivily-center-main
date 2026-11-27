// Explorer decorations: other features (Git status in Phase 9, problems in Phase 12) annotate rows
// without the explorer knowing about them. Each provider contributes `key → decoration`; the
// merged map is what the explorer renders.
import { createStore } from '../../core/store.js';

/** @typedef {{ badge?: string, color?: string, tooltip?: string }} Decoration */

/** @type {Map<string, Record<string, Decoration>>} */
const providers = new Map();

/** Merged decorations by row key. Later providers win for the same key. */
export const explorerDecorations = createStore(/** @type {Record<string, Decoration>} */ ({}));

/** Replace the decorations of one provider. @param {string} id @param {Record<string, Decoration>} map */
export function setDecorations(id, map) {
  if (map && Object.keys(map).length) providers.set(id, map);
  else providers.delete(id);
  explorerDecorations.set(Object.assign({}, ...providers.values()));
}
