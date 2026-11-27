// Editor ↔ language registry bridge.
import { languageById, languageForName, listLanguages, loadLanguage, TIER_LABEL } from '../../languages/registry.js';
import { registerBuiltinLanguages } from '../../languages/builtin.js';

registerBuiltinLanguages();

/**
 * Resolve and load the syntax support for a file name. Returns null for plain text.
 * @param {string} fileName
 * @returns {Promise<{ id: string, name: string, support: import('@codemirror/state').Extension } | null>}
 */
export async function languageForFile(fileName) {
  const p = languageForName(fileName);
  if (!p) return null;
  return { id: p.id, name: p.name, support: await loadLanguage(p) };
}

/** All languages (for the language picker). */
export function availableLanguages() {
  return listLanguages().map((p) => ({
    id: p.id,
    name: p.name,
    tier: TIER_LABEL[p.tier],
    load: () => loadLanguage(p).then((support) => ({ id: p.id, name: p.name, support })),
  }));
}

export { languageById };
