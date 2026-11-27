// Icon pack registry.
//
// UI code asks for an icon by semantic id (`settings`, `close`, ...) and never knows which pack
// draws it. A pack provides render specs:
//   - { kind: 'stroke', viewBox, d }   vector outline icons (Modern)
//   - { kind: 'bitmap', rows }         pixel bitmaps ('#' = on), drawn with crisp edges (Pixel)
// Missing icons fall back to the pack's `fallback` (default 'modern'). File-type and folder
// icon mappings are added to the same packs in Phase 4.

/**
 * @typedef {{ kind: 'stroke', viewBox: string, d: string } | { kind: 'bitmap', rows: string[] }} IconSpec
 * @typedef {{ id: string, name: string, fallback?: string, icons: Record<string, IconSpec> }} IconPack
 */

/** @type {Map<string, IconPack>} */
const packs = new Map();

/** @param {IconPack} pack */
export function registerIconPack(pack) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(pack.id)) throw new Error(`Invalid icon pack id: ${pack.id}`);
  for (const [id, spec] of Object.entries(pack.icons)) {
    if (spec.kind === 'bitmap') {
      const w = spec.rows[0]?.length;
      if (!w || spec.rows.some((r) => r.length !== w || /[^#.]/.test(r))) throw new Error(`Malformed bitmap icon ${pack.id}/${id}`);
    } else if (spec.kind !== 'stroke' || typeof spec.d !== 'string') {
      throw new Error(`Malformed icon ${pack.id}/${id}`);
    }
  }
  packs.set(pack.id, pack);
}

export const hasIconPack = (id) => packs.has(id);
/** Remove a user/extension icon pack (built-in packs cannot be removed). */
export function unregisterIconPack(id) {
  if (String(id).startsWith('user-')) packs.delete(id);
}
export const listIconPacks = () => [...packs.values()];

/**
 * Resolve an icon id in a pack, following fallbacks (cycle-safe).
 * @param {string} packId
 * @param {string} iconId
 * @returns {IconSpec | null}
 */
export function resolveIcon(packId, iconId) {
  const seen = new Set();
  let id = packId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const pack = packs.get(id);
    if (!pack) break;
    if (pack.icons[iconId]) return pack.icons[iconId];
    id = pack.fallback ?? (id === 'modern' ? '' : 'modern');
  }
  return null;
}

/**
 * Convert a bitmap into one SVG path made of horizontal runs (`M x y h n v 1 h -n z`).
 * @param {string[]} rows
 */
export function bitmapToPath(rows) {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === '#') end++;
      d += `M${x} ${y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  });
  return d;
}
