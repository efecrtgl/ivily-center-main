// Language provider registry.
//
// A provider describes one language: how files are recognised, how its syntax support is loaded
// (lazily), its LSP language id and — honestly — what level of support Ivily Center has for it:
//
//   'structure' — full incremental parser (Lezer): highlighting, folding, indentation, bracket and
//                 structure awareness.
//   'syntax'    — token-based highlighting (CodeMirror stream mode); indentation is heuristic.
//   'basic'     — keyword/string/comment highlighting written for Ivily (no full grammar).
//
// Code intelligence (completion, diagnostics, navigation) is a separate dimension provided by a
// language server (Phase 7) and is reported at runtime, never implied by these tiers.

/**
 * @typedef {'structure' | 'syntax' | 'basic'} Tier
 * @typedef {object} LanguageProvider
 * @property {string} id                 Stable id (also the LSP languageId when `lspId` is not set).
 * @property {string} name
 * @property {string[]} [extensions]     Lower-case, without dot (compound allowed: "d.ts").
 * @property {string[]} [filenames]      Exact lower-case file names.
 * @property {RegExp} [pattern]          Tested against the lower-case file name.
 * @property {string} [lspId]
 * @property {Tier} tier
 * @property {string} [note]             Shown in the language list (e.g. "approximate").
 * @property {() => Promise<import('@codemirror/state').Extension>} load
 */

/** @type {LanguageProvider[]} */
const providers = [];
/** @type {Map<string, Promise<import('@codemirror/state').Extension>>} */
const loaded = new Map();

/** @param {LanguageProvider} p */
export function registerLanguage(p) {
  if (!/^[a-z][\w+#.-]*$/.test(p.id)) throw new Error(`Invalid language id: ${p.id}`);
  const i = providers.findIndex((x) => x.id === p.id);
  if (i >= 0) providers.splice(i, 1, p);
  else providers.push(p);
}

export const listLanguages = () => [...providers].sort((a, b) => a.name.localeCompare(b.name));
export const languageById = (id) => providers.find((p) => p.id === id) ?? null;

/**
 * Find the provider for a file name: exact names, then patterns, then the longest matching
 * (compound) extension.
 * @param {string} fileName
 */
export function languageForName(fileName) {
  const lower = fileName.toLowerCase();
  const exact = providers.find((p) => p.filenames?.includes(lower));
  if (exact) return exact;
  const pat = providers.find((p) => p.pattern?.test(lower));
  if (pat) return pat;
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    const p = providers.find((x) => x.extensions?.includes(ext));
    if (p) return p;
  }
  return null;
}

/** Load (once) the editor extension of a provider. */
export function loadLanguage(p) {
  let promise = loaded.get(p.id);
  if (!promise) {
    promise = p.load().catch((e) => {
      loaded.delete(p.id);
      throw e;
    });
    loaded.set(p.id, promise);
  }
  return promise;
}

export const TIER_LABEL = {
  structure: 'Syntax + structure',
  syntax: 'Syntax highlighting',
  basic: 'Basic highlighting',
};
