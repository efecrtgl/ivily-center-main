// Workspace search: options, streaming results, history and confirmed replace.
//
// Searching reads files on disk (the backend walks the workspace with ripgrep's libraries).
// Replacing only touches files the user confirmed; files with unsaved editor changes are skipped
// so nothing the user typed is overwritten, and the backend refuses files that changed on disk.
import { Channel } from '@tauri-apps/api/core';
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import { confirmDialog } from '../../core/dialogs.js';
import * as ipc from '../../platform/ipc.js';
import { isCurrentEpoch, workspaceStore } from '../../workspace/store.js';
import { allDocs } from '../editor/model.js';

export const HISTORY_KEY = 'ui.search.history';
const HISTORY_LIMIT = 30;

/** @typedef {{ root: number, path: string, matches: { line: number, ranges: [number, number][], preview: string, previewOffset: number }[] }} FileMatches */

export const searchStore = createStore({
  query: '',
  replace: '',
  showReplace: false,
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: '',
  exclude: '',
  useIgnore: true,
  /** @type {FileMatches[]} */
  results: [],
  /** @type {null | { matches: number, files: number, filesSearched: number, limitHit: boolean, cancelled: boolean }} */
  summary: null,
  running: false,
  /** @type {string | null} */
  error: null,
  /** @type {Record<string, boolean>} collapsed files */
  collapsed: {},
  /** @type {string[]} */
  history: [],
});

let nextId = 1;
let currentId = 0;

/** Split a comma-separated glob list (`*.js, src/**`) into trimmed, non-empty entries. */
export function splitGlobs(text) {
  return String(text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 64);
}

/** @returns {import('../../platform/ipc.js').SearchQuery} */
export function buildQuery(s = searchStore.get()) {
  return { pattern: s.query, isRegex: s.isRegex, caseSensitive: s.caseSensitive, wholeWord: s.wholeWord, include: splitGlobs(s.include), exclude: splitGlobs(s.exclude), useIgnore: s.useIgnore };
}

export async function loadHistory() {
  if (!ipc.isTauri()) return;
  try {
    const h = await ipc.uiStateGet(HISTORY_KEY);
    if (Array.isArray(h)) searchStore.set((s) => ({ ...s, history: h.filter((x) => typeof x === 'string').slice(0, HISTORY_LIMIT) }));
  } catch {
    /* history is a convenience */
  }
}

function remember(term) {
  const history = [term, ...searchStore.get().history.filter((h) => h !== term)].slice(0, HISTORY_LIMIT);
  searchStore.set((s) => ({ ...s, history }));
  if (ipc.isTauri()) ipc.uiStateSet(HISTORY_KEY, history).catch(() => {});
}

export function clearHistory() {
  searchStore.set((s) => ({ ...s, history: [] }));
  if (ipc.isTauri()) ipc.uiStateSet(HISTORY_KEY, []).catch(() => {});
}

/** Cancel the running search (results so far stay visible). */
export function cancelSearch() {
  if (currentId && ipc.isTauri()) ipc.searchCancel(currentId).catch(() => {});
}

/** Run the search with the current options. Replaces any running search. */
export async function runSearch() {
  const s = searchStore.get();
  if (!s.query) {
    cancelSearch();
    searchStore.set((st) => ({ ...st, results: [], summary: null, error: null, running: false }));
    return;
  }
  if (!workspaceStore.get().current || !ipc.isTauri()) return;
  cancelSearch();
  const id = nextId++;
  currentId = id;
  const epoch = workspaceStore.get().epoch;
  searchStore.set((st) => ({ ...st, results: [], summary: null, error: null, running: true, collapsed: {} }));
  remember(s.query);
  const channel = new Channel();
  /** @type {FileMatches[]} */
  let pending = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (currentId !== id || !pending.length) return;
    const batch = pending;
    pending = [];
    searchStore.set((st) => ({ ...st, results: [...st.results, ...batch] }));
  };
  channel.onmessage = (batch) => {
    if (currentId !== id || !isCurrentEpoch(epoch)) return;
    pending.push(...batch);
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 50);
    }
  };
  try {
    const summary = await ipc.searchRun(id, buildQuery(s), channel);
    flush();
    if (currentId === id) searchStore.set((st) => ({ ...st, summary, running: false }));
  } catch (e) {
    if (currentId === id) searchStore.set((st) => ({ ...st, running: false, error: errorMessage(e) }));
  }
}

export const totalMatches = (results) => results.reduce((n, f) => n + f.matches.length, 0);

/** Remove a file (or one match) from the result list without touching the file. */
export function dismiss(root, path, line) {
  searchStore.set((s) => ({
    ...s,
    results: s.results
      .map((f) => (f.root === root && f.path === path ? (line === undefined ? null : { ...f, matches: f.matches.filter((m) => m.line !== line) }) : f))
      .filter((f) => f && f.matches.length),
  }));
}

/** Files among `targets` that have unsaved changes in the editor. */
export function dirtyTargets(targets) {
  const dirty = new Set(allDocs().filter((d) => d.ref && !('external' in d.ref) && !d.untitled && !d.text.eq(d.savedText)).map((d) => `${d.ref.root}:${d.ref.path}`));
  return targets.filter((t) => dirty.has(`${t.root}:${t.path}`));
}

/**
 * Replace in the given result files (all results by default), after confirmation.
 * @param {FileMatches[]} [files]
 */
export async function replaceAll(files) {
  const s = searchStore.get();
  const targets = files ?? s.results;
  if (!targets.length || !s.query) return;
  const count = totalMatches(targets);
  const dirty = dirtyTargets(targets);
  const ok = await confirmDialog({
    title: `Replace ${count} occurrence${count === 1 ? '' : 's'} in ${targets.length} file${targets.length === 1 ? '' : 's'}?`,
    message:
      `“${s.query}” will be replaced with “${s.replace}” on disk. Files that changed since the search are skipped.` +
      (dirty.length ? ` ${dirty.length} file(s) with unsaved changes will be skipped — save them first to include them.` : '') +
      ' Multi-file replace cannot be undone with Ctrl+Z; use Source Control (discard) or a backup to revert.',
    confirmLabel: 'Replace',
    danger: true,
  });
  if (!ok) return;
  const skip = new Set(dirty.map((d) => `${d.root}:${d.path}`));
  const send = targets.filter((t) => !skip.has(`${t.root}:${t.path}`)).map((t) => ({ root: t.root, path: t.path }));
  if (!send.length) return;
  try {
    const res = await ipc.searchReplace(buildQuery(s), s.replace, send);
    const failed = res.filter((r) => r.error);
    const done = res.reduce((n, r) => n + r.replacements, 0);
    notify({
      severity: failed.length ? 'warning' : 'info',
      title: `Replaced ${done} occurrence${done === 1 ? '' : 's'}`,
      message: failed.length ? `${failed.length} file(s) were not changed: ${failed.slice(0, 3).map((f) => `${f.path} (${f.error})`).join('; ')}` : undefined,
      source: 'search',
    });
  } catch (e) {
    notify({ severity: 'error', title: 'Replace failed', message: errorMessage(e), source: 'search' });
  }
  await runSearch();
}

/** Reset on workspace change. */
export function resetSearch() {
  cancelSearch();
  currentId = 0;
  searchStore.set((s) => ({ ...s, results: [], summary: null, error: null, running: false, collapsed: {} }));
}
