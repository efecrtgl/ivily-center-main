// File explorer state: lazily loaded tree, expansion, selection, clipboard and inline editing.
//
// Keys are `"<root>:<relative path>"` (root itself is `"<root>:"`). Directory contents are loaded
// on expand and refreshed from watcher events. Pure helpers (`flattenRows`, `selectRange`, …) are
// exported for tests; side effects go through `ipc`.
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import * as ipc from '../../platform/ipc.js';
import { isCurrentEpoch, workspaceStore } from '../../workspace/store.js';
import { markSessionDirty, registerSessionParticipant } from '../../workspace/session.js';

/** @typedef {import('../../platform/ipc.js').FsEntry} FsEntry */
/** @typedef {{ entries: FsEntry[] | null, loading: boolean, error: string | null, truncated: boolean, ignored: boolean }} DirState */
/**
 * @typedef {{ key: string, root: number, rel: string, name: string, depth: number, kind: 'file' | 'dir' | 'link' | 'root',
 *             entry: FsEntry | null, expanded: boolean, ignored: boolean, editing?: boolean }} Row
 */

export const keyOf = (root, rel) => `${root}:${rel}`;
export function parseKey(key) {
  const i = key.indexOf(':');
  return { root: Number(key.slice(0, i)), rel: key.slice(i + 1) };
}
export const parentRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);
export const baseName = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

const initial = () => ({
  /** @type {Record<string, DirState>} */
  dirs: {},
  /** @type {string[]} */
  expanded: [],
  /** @type {string[]} */
  selection: [],
  anchor: /** @type {string | null} */ (null),
  focus: /** @type {string | null} */ (null),
  /** Inline input: new file/folder inside `dir`, or rename of `key`. */
  editing: /** @type {null | { mode: 'newFile' | 'newFolder', dir: string } | { mode: 'rename', key: string }} */ (null),
  /** @type {null | { mode: 'copy' | 'cut', keys: string[] }} */
  clipboard: null,
});

export const explorerStore = createStore(initial());

/**
 * Visible rows, depth-first, honouring expansion.
 * @param {{ dirs: Record<string, DirState>, expanded: string[], editing: any }} state
 * @param {{ name: string, available: boolean }[]} roots
 * @returns {Row[]}
 */
export function flattenRows(state, roots) {
  const expanded = new Set(state.expanded);
  /** @type {Row[]} */
  const rows = [];
  const walk = (root, rel, depth, inheritedIgnored) => {
    const dir = state.dirs[keyOf(root, rel)];
    if (state.editing && state.editing.mode !== 'rename' && state.editing.dir === keyOf(root, rel)) {
      rows.push({ key: `${keyOf(root, rel)}\u0000new`, root, rel, name: '', depth, kind: state.editing.mode === 'newFolder' ? 'dir' : 'file', entry: null, expanded: false, ignored: false, editing: true });
    }
    for (const e of dir?.entries ?? []) {
      const childRel = joinRel(rel, e.name);
      const key = keyOf(root, childRel);
      const isDir = e.kind === 'dir';
      const open = isDir && expanded.has(key);
      const ignored = inheritedIgnored || e.ignored;
      rows.push({ key, root, rel: childRel, name: e.name, depth, kind: e.kind, entry: e, expanded: open, ignored, editing: state.editing?.mode === 'rename' && state.editing.key === key });
      if (open) walk(root, childRel, depth + 1, ignored);
    }
  };
  roots.forEach((r, i) => {
    const key = keyOf(i, '');
    const open = expanded.has(key);
    rows.push({ key, root: i, rel: '', name: r.name, depth: 0, kind: 'root', entry: null, expanded: open, ignored: false });
    if (open && r.available) walk(i, '', 1, false);
  });
  return rows;
}

/** Keys between `a` and `b` (inclusive) in row order. */
export function selectRange(rows, a, b) {
  const ia = rows.findIndex((r) => r.key === a);
  const ib = rows.findIndex((r) => r.key === b);
  if (ia < 0 || ib < 0) return [b];
  const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
  return rows.slice(lo, hi + 1).filter((r) => !r.editing).map((r) => r.key);
}

/** Remove descendants of selected folders (operating on a folder already covers them). */
export function topLevel(keys) {
  const set = [...new Set(keys)];
  return set.filter((k) => {
    const { root, rel } = parseKey(k);
    return !set.some((o) => {
      if (o === k) return false;
      const p = parseKey(o);
      return p.root === root && (p.rel === '' ? rel !== '' : rel.startsWith(`${p.rel}/`));
    });
  });
}

// ── Loading ─────────────────────────────────────────────────────────────────

const setDir = (key, patch) =>
  explorerStore.set((s) => ({ ...s, dirs: { ...s.dirs, [key]: { entries: null, loading: false, error: null, truncated: false, ignored: false, ...s.dirs[key], ...patch } } }));

/** Load (or reload) one directory. Stale results after a workspace switch are dropped. */
export async function loadDir(key) {
  if (!ipc.isTauri()) return;
  const epoch = workspaceStore.get().epoch;
  const { root, rel } = parseKey(key);
  setDir(key, { loading: true });
  try {
    const listing = await ipc.fsList(root, rel);
    if (!isCurrentEpoch(epoch)) return;
    setDir(key, { entries: listing.entries, loading: false, error: null, truncated: listing.truncated, ignored: listing.ignored });
  } catch (e) {
    if (!isCurrentEpoch(epoch)) return;
    setDir(key, { loading: false, error: errorMessage(e), entries: [] });
  }
}

export function setExpanded(key, open) {
  const s = explorerStore.get();
  const has = s.expanded.includes(key);
  if (open === has) return;
  explorerStore.set({ ...s, expanded: open ? [...s.expanded, key] : s.expanded.filter((k) => k !== key) });
  if (open && !s.dirs[key]?.entries) loadDir(key);
  markSessionDirty();
}

export const toggleExpanded = (key) => setExpanded(key, !explorerStore.get().expanded.includes(key));

export function collapseAll() {
  explorerStore.set((s) => ({ ...s, expanded: s.expanded.filter((k) => parseKey(k).rel === '') }));
  markSessionDirty();
}

/** Reload every loaded directory (manual refresh or watcher rescan). */
export function refreshAll() {
  for (const key of Object.keys(explorerStore.get().dirs)) loadDir(key);
}

const pendingReload = new Set();
let reloadTimer = null;

/** Watcher event → reload the loaded parents of changed paths (debounced). */
export function onFsChanged(change) {
  const s = explorerStore.get();
  if (change.rescan) {
    refreshAll();
    return;
  }
  for (const rel of change.paths) {
    const dirKey = keyOf(change.root, parentRel(rel));
    if (s.dirs[dirKey]) pendingReload.add(dirKey);
    // A changed path that is itself a loaded directory (e.g. renamed away) also needs a reload.
    if (s.dirs[keyOf(change.root, rel)]) pendingReload.add(keyOf(change.root, rel));
  }
  if (!pendingReload.size) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const keys = [...pendingReload];
    pendingReload.clear();
    keys.forEach(loadDir);
  }, 80);
}

// ── Selection ───────────────────────────────────────────────────────────────

/** @param {string} key @param {{ ctrl?: boolean, shift?: boolean }} mods @param {Row[]} rows */
export function select(key, mods = {}, rows = []) {
  explorerStore.set((s) => {
    if (mods.shift && s.anchor) return { ...s, selection: selectRange(rows, s.anchor, key), focus: key };
    if (mods.ctrl) {
      const has = s.selection.includes(key);
      return { ...s, selection: has ? s.selection.filter((k) => k !== key) : [...s.selection, key], anchor: key, focus: key };
    }
    return { ...s, selection: [key], anchor: key, focus: key };
  });
}

// ── Operations ──────────────────────────────────────────────────────────────

const toRefs = (keys) => keys.map((k) => ({ root: parseKey(k).root, path: parseKey(k).rel }));
const fail = (title) => (e) => {
  notify({ severity: 'error', title, message: errorMessage(e), source: 'explorer' });
  return null;
};

/** Expand a folder and all of its ancestors (so a row inside it is visible). */
export function expandTo(dirKey) {
  const { root, rel } = parseKey(dirKey);
  setExpanded(keyOf(root, ''), true);
  let acc = '';
  for (const part of rel ? rel.split('/') : []) {
    acc = joinRel(acc, part);
    setExpanded(keyOf(root, acc), true);
  }
}

export function startCreate(mode, dirKey) {
  expandTo(dirKey);
  explorerStore.set((s) => ({ ...s, editing: { mode, dir: dirKey } }));
}
export const startRename = (key) => explorerStore.set((s) => ({ ...s, editing: { mode: 'rename', key } }));
export const cancelEdit = () => explorerStore.set((s) => ({ ...s, editing: null }));

/** Commit the inline input. Returns an error message to show inline, or null on success. */
export async function commitEdit(name) {
  const ed = explorerStore.get().editing;
  if (!ed) return null;
  const trimmed = name.trim();
  if (!trimmed) {
    cancelEdit();
    return null;
  }
  try {
    if (ed.mode === 'rename') {
      const { root, rel } = parseKey(ed.key);
      if (baseName(rel) === trimmed) {
        cancelEdit();
        return null;
      }
      const r = await ipc.fsRename(root, rel, trimmed);
      cancelEdit();
      const newKey = keyOf(r.root, r.path);
      explorerStore.set((s) => ({ ...s, selection: [newKey], focus: newKey, anchor: newKey }));
      await loadDir(keyOf(root, parentRel(rel)));
    } else {
      const { root, rel } = parseKey(ed.dir);
      // Names may contain "/" to create nested paths ("src/utils/index.js").
      const target = joinRel(rel, trimmed.replace(/\\/g, '/'));
      const r = ed.mode === 'newFolder' ? await ipc.fsCreateDir(root, target) : await createFileWithParents(root, target);
      cancelEdit();
      const key = keyOf(r.root, r.path);
      explorerStore.set((s) => ({ ...s, selection: [key], focus: key, anchor: key }));
      await loadDir(ed.dir);
      if (ed.mode === 'newFile') openFile(key);
    }
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

async function createFileWithParents(root, rel) {
  const parts = rel.split('/');
  let dir = '';
  for (const p of parts.slice(0, -1)) {
    dir = joinRel(dir, p);
    try {
      await ipc.fsCreateDir(root, dir);
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'conflict') throw e;
    }
  }
  return ipc.fsCreateFile(root, rel);
}

/** @param {string[]} keys @param {{ permanent?: boolean }} [opts] */
export async function deleteItems(keys, { permanent = false } = {}) {
  const items = topLevel(keys).filter((k) => parseKey(k).rel !== '');
  if (!items.length) return;
  await (permanent ? ipc.fsDeletePermanently(toRefs(items)) : ipc.fsTrash(toRefs(items))).catch(fail('Could not delete'));
  explorerStore.set((s) => ({ ...s, selection: [] }));
}

export const setClipboard = (mode, keys) => explorerStore.set((s) => ({ ...s, clipboard: keys.length ? { mode, keys: topLevel(keys) } : null }));

/** Paste into the folder `destKey` (copy: unique names on conflict; cut: move). */
export async function paste(destKey) {
  const clip = explorerStore.get().clipboard;
  if (!clip) return;
  const dest = toRefs([destKey])[0];
  if (clip.mode === 'copy') {
    await ipc.fsCopy(toRefs(clip.keys), dest, 'rename').catch(fail('Could not paste'));
  } else {
    const ok = await ipc.fsMove(toRefs(clip.keys), dest).catch(fail('Could not move'));
    if (ok) explorerStore.set((s) => ({ ...s, clipboard: null }));
  }
  await loadDir(destKey);
}

/** @param {string[]} keys @param {string} destKey @param {boolean} copy */
export async function dropItems(keys, destKey, copy) {
  const items = topLevel(keys).filter((k) => parseKey(k).rel !== '' && parentKeyOf(k) !== destKey);
  if (!items.length) return;
  const dest = toRefs([destKey])[0];
  await (copy ? ipc.fsCopy(toRefs(items), dest, 'rename') : ipc.fsMove(toRefs(items), dest)).catch(fail(copy ? 'Could not copy' : 'Could not move'));
  await loadDir(destKey);
}

export function parentKeyOf(key) {
  const { root, rel } = parseKey(key);
  return keyOf(root, parentRel(rel));
}

export async function duplicateItem(key) {
  const { root, rel } = parseKey(key);
  const r = await ipc.fsDuplicate(root, rel).catch(fail('Could not duplicate'));
  if (r) await loadDir(parentKeyOf(key));
}

// ── Opening files (the editor registers the handler) ────────────────────────

/** @type {(ref: { root: number, path: string }, opts: { preview: boolean }) => void} */
let opener = () => {};
export const setFileOpener = (fn) => {
  opener = fn;
};
export function openFile(key, { preview = false } = {}) {
  const { root, rel } = parseKey(key);
  opener({ root, path: rel }, { preview });
}

// ── Session ─────────────────────────────────────────────────────────────────

let registered = false;
export function registerExplorerSession() {
  if (registered) return;
  registered = true;
  registerSessionParticipant('explorer', {
    save: () => {
      const s = explorerStore.get();
      return { expanded: s.expanded.slice(0, 2000), selection: s.selection.slice(0, 200) };
    },
    restore: (data) => {
      const d = data && typeof data === 'object' ? /** @type {any} */ (data) : {};
      const roots = workspaceStore.get().current?.folders.length ?? 0;
      const valid = (k) => typeof k === 'string' && /^\d+:/.test(k) && parseKey(k).root < roots;
      const expanded = Array.isArray(d.expanded) ? d.expanded.filter(valid) : [];
      // First open: expand the (first) root.
      const exp = data === undefined ? (roots ? [keyOf(0, '')] : []) : expanded;
      explorerStore.set({ ...initial(), expanded: exp, selection: Array.isArray(d.selection) ? d.selection.filter(valid) : [] });
      // Load expanded folders top-down; missing ones simply show an error state.
      [...exp].sort((a, b) => a.length - b.length).forEach(loadDir);
    },
    reset: () => explorerStore.set(initial()),
  });
}
