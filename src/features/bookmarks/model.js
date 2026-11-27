// Bookmarks: marked lines in workspace files, shown in the editor gutter, following edits, saved
// with the workspace session.
import { GutterMarker, gutter, EditorView } from '@codemirror/view';
import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import { createStore } from '../../core/store.js';
import { confirmDialog } from '../../core/dialogs.js';
import { notify } from '../../core/notifications.js';
import { quickPick } from '../../core/quickPick.js';
import { markSessionDirty, registerSessionParticipant } from '../../workspace/session.js';
import { activeEditor, getDoc, registerEditorExtension, revealInDocument, viewsOf } from '../editor/model.js';

/** doc key (`root:path`) → sorted line numbers (1-based) */
export const bookmarksStore = createStore(/** @type {Record<string, number[]>} */ ({}));

const toggleEffect = StateEffect.define();
/** @internal for tests */
export const _toggleEffect = toggleEffect;
const setEffect = StateEffect.define();

class BookmarkMarker extends GutterMarker {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bookmark';
    s.title = 'Bookmark';
    s.textContent = '◆';
    return s;
  }
}
// Associate forward so a bookmark at a line start follows its text when lines are inserted above.
BookmarkMarker.prototype.startSide = 1;
BookmarkMarker.prototype.endSide = 1;
const marker = new BookmarkMarker();

const isWorkspaceKey = (key) => /^\d+:/.test(key);
export const parseKey = (key) => ({ root: Number(key.slice(0, key.indexOf(':'))), path: key.slice(key.indexOf(':') + 1) });

const normalize = (lines) => [...new Set(lines.filter((l) => Number.isInteger(l) && l >= 1))].sort((a, b) => a - b);

function fromLines(doc, lines) {
  return RangeSet.of(normalize(lines).filter((l) => l <= doc.lines).map((l) => marker.range(doc.line(l).from)));
}

function linesOf(state, field) {
  const out = [];
  const iter = state.field(field).iter();
  while (iter.value) {
    out.push(state.doc.lineAt(iter.from).number);
    iter.next();
  }
  return normalize(out);
}

function publish(key, lines) {
  const cur = bookmarksStore.get()[key] ?? [];
  if (cur.length === lines.length && cur.every((l, i) => l === lines[i])) return;
  bookmarksStore.set((s) => {
    const next = { ...s };
    if (lines.length) next[key] = lines;
    else delete next[key];
    return next;
  });
  markSessionDirty();
}

/** Editor extension for one document. */
export function bookmarkExtension(key) {
  if (!isWorkspaceKey(key)) return [];
  const field = StateField.define({
    create: (st) => fromLines(st.doc, bookmarksStore.get()[key] ?? []),
    update(set, tr) {
      let next = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setEffect)) next = fromLines(tr.state.doc, e.value);
        if (e.is(toggleEffect)) {
          const from = tr.state.doc.line(e.value).from;
          let has = false;
          next.between(from, tr.state.doc.line(e.value).to, () => {
            has = true;
          });
          next = has ? next.update({ filter: (f, t) => t < from || f > tr.state.doc.line(e.value).to }) : next.update({ add: [marker.range(from)], sort: true });
        }
      }
      return next;
    },
  });
  return [
    field,
    gutter({ class: 'cm-bookmarks', markers: (v) => v.state.field(field), initialSpacer: () => marker }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(toggleEffect)))) publish(key, linesOf(u.state, field));
    }),
  ];
}

/** Toggle a bookmark on the cursor line of the active editor. */
export function toggleBookmark() {
  const ed = activeEditor();
  if (!ed?.view || !isWorkspaceKey(ed.key)) {
    notify({ severity: 'info', title: 'Bookmarks are available for files in the workspace', source: 'bookmarks' });
    return;
  }
  const line = ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
  ed.view.dispatch({ effects: toggleEffect.of(line) });
}

/** All bookmarks in a stable order. */
export function allBookmarks(state = bookmarksStore.get()) {
  return Object.keys(state)
    .sort()
    .flatMap((key) => state[key].map((line) => ({ key, line })));
}

/** Jump to the next (+1) / previous (-1) bookmark relative to the cursor. */
export function goToBookmark(delta) {
  const list = allBookmarks();
  if (!list.length) return notify({ severity: 'info', title: 'No bookmarks', message: 'Toggle one with Ctrl+Alt+K.', source: 'bookmarks' });
  const ed = activeEditor();
  const curKey = ed?.key ?? '';
  const curLine = ed?.view ? ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number : 0;
  const cmp = (b) => (b.key === curKey ? b.line - curLine : b.key < curKey ? -1 : 1);
  const target = delta > 0 ? (list.find((b) => cmp(b) > 0) ?? list[0]) : ([...list].reverse().find((b) => cmp(b) < 0) ?? list[list.length - 1]);
  revealInDocument(parseKey(target.key), target.line);
}

export async function listBookmarks() {
  const list = allBookmarks();
  if (!list.length) return notify({ severity: 'info', title: 'No bookmarks', message: 'Toggle one with Ctrl+Alt+K.', source: 'bookmarks' });
  const item = await quickPick({
    placeholder: 'Go to bookmark',
    matchOnDescription: true,
    items: list.map((b, i) => {
      const text = getDoc(b.key)?.text;
      const preview = text && b.line <= text.lines ? text.line(b.line).text.trim().slice(0, 80) : '';
      const { path } = parseKey(b.key);
      return { id: String(i), label: `${path.slice(path.lastIndexOf('/') + 1)}:${b.line}`, description: preview || path };
    }),
  });
  if (item) {
    const b = list[Number(item.id)];
    revealInDocument(parseKey(b.key), b.line);
  }
}

function applyToViews(key, lines) {
  for (const v of viewsOf(key)) v.dispatch({ effects: setEffect.of(lines) });
}

export async function clearBookmarks() {
  if (!allBookmarks().length) return;
  const ok = await confirmDialog({ title: 'Remove all bookmarks?', message: 'All bookmarks of this workspace will be removed.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  const keys = Object.keys(bookmarksStore.get());
  bookmarksStore.set({});
  for (const k of keys) applyToViews(k, []);
  markSessionDirty();
}

let installed = false;
export function installBookmarks() {
  if (installed) return;
  installed = true;
  registerEditorExtension((key) => bookmarkExtension(key));
  registerSessionParticipant('bookmarks', {
    save: () => bookmarksStore.get(),
    restore: (data) => {
      const clean = {};
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) if (isWorkspaceKey(k) && Array.isArray(v)) clean[k] = normalize(v).slice(0, 1000);
      }
      bookmarksStore.set(clean);
      for (const [k, v] of Object.entries(clean)) applyToViews(k, v);
    },
    reset: () => bookmarksStore.set({}),
  });
}
