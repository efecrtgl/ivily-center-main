// file:// URIs ↔ workspace document references.

/** `C:\code\app\src\a b.rs` → `file:///c%3A/code/app/src/a%20b.rs` (VS Code style, lower-case drive). */
export function pathToUri(path) {
  let p = path.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(p)) p = `/${p[0].toLowerCase()}%3A${p.slice(2)}`;
  return `file://${p.split('/').map((seg, i) => (i === 1 && seg.endsWith('%3A') ? seg : encodeURIComponent(seg))).join('/')}`;
}

/** Inverse of `pathToUri` (accepts `file:///C:/…` and `file:///c%3A/…`). */
export function uriToPath(uri) {
  if (!uri.startsWith('file://')) return null;
  let p = decodeURIComponent(uri.slice('file://'.length));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p.replace(/\//g, '\\');
}

/** Relative path of `abs` below `root` (case-insensitive), or null. */
function relativeTo(root, abs) {
  const r = root.replace(/[\\/]+$/, '').toLowerCase();
  const a = abs.toLowerCase();
  if (a === r) return '';
  if (!a.startsWith(`${r}\\`)) return null;
  return abs.slice(r.length + 1).replace(/\\/g, '/');
}

/**
 * @param {{ root: number, path: string }} ref
 * @param {{ path: string }[]} folders
 */
export function refToUri(ref, folders) {
  const root = folders[ref.root]?.path;
  if (!root) return null;
  return pathToUri(ref.path ? `${root.replace(/[\\/]+$/, '')}\\${ref.path.replace(/\//g, '\\')}` : root);
}

/** @returns {{ root: number, path: string } | null} */
export function uriToRef(uri, folders) {
  const abs = uriToPath(uri);
  if (!abs) return null;
  for (let i = 0; i < folders.length; i++) {
    const rel = relativeTo(folders[i].path, abs);
    if (rel !== null && rel !== '') return { root: i, path: rel };
  }
  return null;
}
