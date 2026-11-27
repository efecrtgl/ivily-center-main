// Quick pick: a keyboard-first list with fuzzy filtering (used for encodings, line endings,
// languages, and later the Command Palette and Quick Open). One at a time.
import { createStore } from './store.js';

/**
 * @typedef {{ id: string, label: string, description?: string, detail?: string, keybinding?: string, icon?: string, group?: string }} PickItem
 * @typedef {{ placeholder?: string, items: PickItem[] | ((query: string) => PickItem[] | Promise<PickItem[]>), activeId?: string, matchOnDescription?: boolean }} PickRequest
 */

/** @type {import('./store.js').Store<(PickRequest & { resolve: (item: PickItem | null) => void }) | null>} */
export const quickPickStore = createStore(null);

/**
 * Show a quick pick. Resolves to the chosen item or `null` when dismissed.
 * @param {PickRequest} req
 * @returns {Promise<PickItem | null>}
 */
export function quickPick(req) {
  quickPickStore.get()?.resolve(null);
  return new Promise((resolve) => quickPickStore.set({ ...req, resolve }));
}

export function closeQuickPick(item = null) {
  const cur = quickPickStore.get();
  quickPickStore.set(null);
  cur?.resolve(item);
}

/**
 * Fuzzy score: all query characters must appear in order. Consecutive matches, word starts and
 * matches at the beginning score higher. Returns null when it does not match.
 * @param {string} query
 * @param {string} text
 * @returns {{ score: number, positions: number[] } | null}
 */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const positions = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    const wordStart = i === 0 || /[\s/\\._\-:]/.test(text[i - 1]) || (text[i] >= 'A' && text[i] <= 'Z' && text[i - 1] >= 'a' && text[i - 1] <= 'z');
    score += 1 + (i === prev + 1 ? 5 : 0) + (wordStart ? 3 : 0) + (i === 0 ? 4 : 0);
    positions.push(i);
    prev = i;
    ti = i + 1;
  }
  return { score: score - text.length * 0.01, positions };
}

/** Filter and rank items by label (and description when allowed). */
export function filterItems(items, query, matchOnDescription = false) {
  if (!query.trim()) return items.map((item) => ({ item, positions: [] }));
  const out = [];
  for (const item of items) {
    const m = fuzzyScore(query, item.label);
    const d = matchOnDescription && !m && item.description ? fuzzyScore(query, item.description) : null;
    if (m) out.push({ item, positions: m.positions, score: m.score + 10 });
    else if (d) out.push({ item, positions: [], score: d.score });
  }
  return out.sort((a, b) => b.score - a.score);
}
