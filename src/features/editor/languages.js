// Language loading for the editor. Phase 5 uses @codemirror/language-data directly (lazy-loaded
// grammars); Phase 6 replaces this with Ivily's language provider registry.
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';

/**
 * Resolve and load the syntax support for a file name. Returns null for plain text.
 * @param {string} fileName
 * @returns {Promise<{ name: string, support: import('@codemirror/state').Extension } | null>}
 */
export async function languageForFile(fileName) {
  const desc = LanguageDescription.matchFilename(languages, fileName);
  if (!desc) return null;
  const support = await desc.load();
  return { name: desc.name, support };
}

/** All loadable languages (for the language picker). */
export function availableLanguages() {
  return languages.map((l) => ({ name: l.name, load: () => l.load().then((support) => ({ name: l.name, support })) }));
}
