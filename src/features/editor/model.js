// Editor model: documents, editor groups and tabs.
//
// * A *document* is one file (or untitled buffer): text, saved text, encoding, line ending, disk
//   hash, read-only flag. Metadata the UI renders lives in `docsStore` (updated only when it
//   changes, never per keystroke).
// * Each *(group, tab)* has its own EditorState (selection, undo history). The active tab's state
//   lives in the group's EditorView; inactive ones are kept in `tabStates`. Edits in one view are
//   mirrored into every other state of the same document.
// * Saving is hash-checked by the backend; external changes reload clean documents silently and
//   flag dirty ones. Unsaved content is written to recovery drafts (hot exit).
import { Annotation, EditorState, Facet, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { choiceDialog, confirmDialog } from '../../core/dialogs.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { getSetting } from '../../core/settings.js';
import { titleStore } from '../../core/title.js';
import { setContext } from '../../core/context.js';
import { uiLog } from '../../core/output.js';
import * as ipc from '../../platform/ipc.js';
import { isCurrentEpoch, workspaceStore } from '../../workspace/store.js';
import { markSessionDirty, registerFlushHook, registerSessionParticipant } from '../../workspace/session.js';
import { buildExtensions, compartments, editorTheme, featuresExt, gutterExt, readOnlyExt, tabsExt, whitespaceExt, wrapExt } from './cm.js';
import { languageForFile } from './languages.js';
import { themeStore } from '../../theme/engine.js';

/** Changes mirrored from another view of the same document. */
const syncAnnotation = Annotation.define();

/**
 * @typedef {object} Doc
 * @property {string} key
 * @property {import('../../platform/ipc.js').DocRef | null} ref
 * @property {string} name
 * @property {string} location
 * @property {import('../../platform/ipc.js').TextEncoding} encoding
 * @property {'lf' | 'crlf'} eol
 * @property {boolean} mixedEol
 * @property {string | null} hash
 * @property {boolean} readonly
 * @property {boolean} large
 * @property {boolean} untitled
 * @property {import('@codemirror/state').Text} text
 * @property {import('@codemirror/state').Text} savedText
 * @property {boolean} metaDirty   Encoding / line ending changed since the last save.
 * @property {'ok' | 'changed' | 'deleted'} disk
 * @property {boolean} saving
 * @property {import('@codemirror/state').Extension} language
 * @property {string} languageName
 */

/**
 * @typedef {{ name: string, location: string, dirty: boolean, disk: string, readonly: boolean, large: boolean, untitled: boolean,
 *             encoding: string, eol: string, mixedEol: boolean, languageName: string }} DocMeta
 * @typedef {{ key: string, pinned: boolean, preview: boolean }} Tab
 * @typedef {{ id: number, tabs: Tab[], active: string | null }} Group
 */

/** @type {Map<string, Doc>} */
const docs = new Map();
/** @type {Map<string, EditorState>} key: `${groupId}|${docKey}` */
const tabStates = new Map();
/** @type {Map<number, EditorView>} */
const views = new Map();
/** @type {Map<string, any>} scroll snapshots per tab */
const scrolls = new Map();

export const docsStore = createStore(/** @type {Record<string, DocMeta>} */ ({}));
export const editorStore = createStore({
  /** @type {Group[]} */
  groups: [{ id: 1, tabs: [], active: null }],
  activeGroup: 1,
  /** @type {'horizontal' | 'vertical'} */
  orientation: 'horizontal',
  /** Recently closed documents (for "Reopen Closed Editor"). @type {import('../../platform/ipc.js').DocRef[]} */
  closed: [],
});
/** Cursor info of the active editor, for the status bar. */
export const cursorStore = createStore({ line: 1, col: 1, selections: 1, selected: 0 });

let nextGroupId = 2;
let untitledCounter = 1;
export const MAX_GROUPS = 4;

const stateKey = (groupId, key) => `${groupId}|${key}`;
export const keyForRef = (ref) => ('external' in ref ? `ext:${ref.external}` : `${ref.root}:${ref.path}`);
export const getDoc = (key) => docs.get(key);
export const getView = (groupId) => views.get(groupId);
export const allDocs = () => [...docs.values()];

// ── Options from settings ───────────────────────────────────────────────────

/** @returns {import('./cm.js').EditorOptions} */
export function editorOptions(doc) {
  return {
    tabSize: Number(getSetting('editor.tabSize') ?? 4),
    insertSpaces: getSetting('editor.insertSpaces') !== false,
    wordWrap: getSetting('editor.wordWrap') === 'on',
    whitespace: /** @type {any} */ (getSetting('editor.renderWhitespace') ?? 'none'),
    lineNumbers: getSetting('editor.lineNumbers') !== false,
    readOnly: Boolean(doc?.readonly),
    large: Boolean(doc?.large),
    dark: themeStore.get().current?.appearance !== 'light',
  };
}

function reconfigureEffects(doc) {
  const o = editorOptions(doc);
  return [
    compartments.tabs.reconfigure(tabsExt(o)),
    compartments.wrap.reconfigure(wrapExt(o)),
    compartments.whitespace.reconfigure(whitespaceExt(o)),
    compartments.readOnly.reconfigure(readOnlyExt(o)),
    compartments.gutter.reconfigure(gutterExt(o)),
    compartments.features.reconfigure(featuresExt(o)),
    compartments.font.reconfigure(editorTheme(o.dark)),
    compartments.language.reconfigure(o.large ? [] : doc.language),
  ];
}

/** Re-apply settings/theme to every open editor state (views and stored tab states). */
export function applyOptionsToAll() {
  for (const [k, st] of tabStates) {
    const doc = docs.get(k.slice(k.indexOf('|') + 1));
    if (doc) tabStates.set(k, st.update({ effects: reconfigureEffects(doc) }).state);
  }
  for (const [gid, view] of views) {
    const g = groupById(gid);
    const doc = g?.active ? docs.get(g.active) : null;
    if (doc) view.dispatch({ effects: reconfigureEffects(doc) });
  }
}

// ── Metadata ────────────────────────────────────────────────────────────────

const isDirty = (doc) => doc.untitled ? doc.text.length > 0 || doc.metaDirty : doc.metaDirty || !doc.text.eq(doc.savedText);

function publishMeta(doc) {
  /** @type {DocMeta} */
  const meta = {
    name: doc.name,
    location: doc.location,
    dirty: isDirty(doc),
    disk: doc.disk,
    readonly: doc.readonly,
    large: doc.large,
    untitled: doc.untitled,
    encoding: doc.encoding,
    eol: doc.eol,
    mixedEol: doc.mixedEol,
    languageName: doc.languageName,
  };
  const prev = docsStore.get()[doc.key];
  if (prev && Object.keys(meta).every((k) => prev[k] === meta[k])) return;
  docsStore.set((s) => ({ ...s, [doc.key]: meta }));
  syncTitle();
}

function syncTitle() {
  const { groups, activeGroup } = editorStore.get();
  const key = groups.find((g) => g.id === activeGroup)?.active;
  const meta = key ? docsStore.get()[key] : null;
  titleStore.set((t) => ({ ...t, file: meta?.name ?? null, dirty: Boolean(meta?.dirty) }));
  setContext('editorFocus', Boolean(meta));
  setContext('activeEditorDirty', Boolean(meta?.dirty));
  setContext('activeEditorUntitled', Boolean(meta?.untitled));
}

// ── Groups ──────────────────────────────────────────────────────────────────

const groupById = (id) => editorStore.get().groups.find((g) => g.id === id);
const updateGroup = (id, fn) => editorStore.set((s) => ({ ...s, groups: s.groups.map((g) => (g.id === id ? fn(g) : g)) }));

export function activeEditor() {
  const s = editorStore.get();
  const g = s.groups.find((x) => x.id === s.activeGroup);
  return g?.active ? { groupId: g.id, key: g.active, doc: docs.get(g.active), view: views.get(g.id) } : null;
}

export function focusGroup(id) {
  if (!groupById(id)) return;
  editorStore.set((s) => ({ ...s, activeGroup: id }));
  syncTitle();
  requestAnimationFrame?.(() => views.get(id)?.focus());
}

/** Open the active document in a new group to the right/bottom. */
export function splitEditor(orientation) {
  const s = editorStore.get();
  if (s.groups.length >= MAX_GROUPS) return;
  const src = groupById(s.activeGroup);
  const id = nextGroupId++;
  const tab = src?.active ? { key: src.active, pinned: true, preview: false } : null;
  if (tab) {
    const st = views.get(src.id)?.state ?? tabStates.get(stateKey(src.id, src.active));
    if (st) tabStates.set(stateKey(id, src.active), cloneState(st, id));
  }
  editorStore.set({
    ...s,
    orientation: orientation ?? s.orientation,
    groups: [...s.groups, { id, tabs: tab ? [tab] : [], active: tab?.key ?? null }],
    activeGroup: id,
  });
  markSessionDirty();
}

function cloneState(st, groupId) {
  const doc = docs.get(st.facet(docKeyFacet) ?? '');
  return EditorState.create({ doc: st.doc, selection: st.selection, extensions: doc ? extensionsFor(doc, groupId) : [] });
}

// ── States ──────────────────────────────────────────────────────────────────

const docKeyFacet = Facet.define({ combine: (v) => v[0] });

function extensionsFor(doc, groupId) {
  return buildExtensions(editorOptions(doc), doc.language, [
    docKeyFacet.of(doc.key),
    EditorView.updateListener.of((u) => onUpdate(groupId, doc.key, u)),
    EditorView.domEventHandlers({ blur: () => onBlur(doc.key) }),
  ]);
}

function stateFor(groupId, key, selection) {
  const sk = stateKey(groupId, key);
  let st = tabStates.get(sk);
  if (!st) {
    const doc = docs.get(key);
    st = EditorState.create({ doc: doc.text, selection: clampSelection(selection, doc.text.length), extensions: extensionsFor(doc, groupId) });
    tabStates.set(sk, st);
  }
  return st;
}

function clampSelection(sel, len) {
  if (!sel || typeof sel.anchor !== 'number') return undefined;
  const c = (n) => Math.max(0, Math.min(len, n | 0));
  return { anchor: c(sel.anchor), head: c(sel.head ?? sel.anchor) };
}

/** Called by the CodeView when it shows `key` in `groupId`. */
export function attachView(groupId, view) {
  views.set(groupId, view);
}
export function detachView(groupId) {
  const v = views.get(groupId);
  const g = groupById(groupId);
  if (v && g?.active) {
    tabStates.set(stateKey(groupId, g.active), v.state);
    scrolls.set(stateKey(groupId, g.active), v.scrollSnapshot());
  }
  views.delete(groupId);
}

/** Swap the view's state when the group's active tab changes. */
export function showInView(groupId, prevKey, key) {
  const view = views.get(groupId);
  if (!view) return;
  if (prevKey && docs.has(prevKey)) {
    tabStates.set(stateKey(groupId, prevKey), view.state);
    scrolls.set(stateKey(groupId, prevKey), view.scrollSnapshot());
  }
  if (!key || !docs.has(key)) return;
  view.setState(stateFor(groupId, key));
  const snap = scrolls.get(stateKey(groupId, key));
  if (snap) view.dispatch({ effects: snap });
  updateCursor(view.state);
}

function updateCursor(state) {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  cursorStore.set({ line: line.number, col: main.head - line.from + 1, selections: state.selection.ranges.length, selected: state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0) });
}

function onUpdate(groupId, key, u) {
  if (u.selectionSet || u.docChanged) {
    const s = editorStore.get();
    if (s.activeGroup === groupId && groupById(groupId)?.active === key) updateCursor(u.state);
  }
  if (u.focusChanged && u.view.hasFocus && editorStore.get().activeGroup !== groupId) {
    editorStore.set((s) => ({ ...s, activeGroup: groupId }));
    syncTitle();
  }
  if (!u.docChanged) return;
  const doc = docs.get(key);
  if (!doc) return;
  doc.text = u.state.doc;
  if (!u.transactions.some((tr) => tr.annotation(syncAnnotation))) {
    mirror(groupId, key, u.changes);
    // Editing a preview tab keeps it open.
    updateGroup(groupId, (g) => ({ ...g, tabs: g.tabs.map((t) => (t.key === key && t.preview ? { ...t, preview: false } : t)) }));
  }
  publishMeta(doc);
  scheduleDraft(doc);
  scheduleAutoSave(doc);
}

/** Apply changes made in one view to every other state of the same document. */
function mirror(fromGroup, key, changes) {
  const annotations = [syncAnnotation.of(true), Transaction.addToHistory.of(false)];
  for (const g of editorStore.get().groups) {
    if (g.id === fromGroup) continue;
    const v = views.get(g.id);
    if (v && g.active === key) v.dispatch({ changes, annotations });
    else {
      const sk = stateKey(g.id, key);
      const st = tabStates.get(sk);
      if (st) tabStates.set(sk, st.update({ changes, annotations }).state);
    }
  }
}

/** Replace the whole content of a document in every view/state (reload, revert). */
function replaceContent(doc, text) {
  const annotations = [syncAnnotation.of(true)];
  for (const g of editorStore.get().groups) {
    const v = views.get(g.id);
    if (v && g.active === doc.key) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, annotations });
    } else {
      const sk = stateKey(g.id, doc.key);
      const st = tabStates.get(sk);
      if (st) tabStates.set(sk, st.update({ changes: { from: 0, to: st.doc.length, insert: text }, annotations }).state);
    }
  }
  doc.text = doc.text.replace(0, doc.text.length, EditorState.create({ doc: text }).doc);
}

// ── Opening ─────────────────────────────────────────────────────────────────

function largeThreshold() {
  return Number(getSetting('editor.largeFileThresholdMB') ?? 4) * 1024 * 1024;
}

/** Create a document from a backend read (optionally overriding content from a draft). */
function createDoc(key, opened, draft) {
  const base = EditorState.create({ doc: opened.content }).doc;
  /** @type {Doc} */
  const doc = {
    key,
    ref: opened.ref,
    name: opened.name,
    location: opened.location,
    encoding: draft?.encoding ?? opened.encoding,
    eol: draft?.eol ?? opened.eol,
    mixedEol: opened.mixedEol,
    hash: opened.hash,
    readonly: opened.readonly,
    large: opened.size > largeThreshold(),
    untitled: false,
    text: draft ? EditorState.create({ doc: draft.content }).doc : base,
    savedText: base,
    metaDirty: Boolean(draft && (draft.encoding !== opened.encoding || draft.eol !== opened.eol)),
    disk: draft?.baseHash && draft.baseHash !== opened.hash ? 'changed' : 'ok',
    saving: false,
    language: [],
    languageName: 'Plain Text',
  };
  docs.set(key, doc);
  publishMeta(doc);
  loadLanguage(doc);
  return doc;
}

async function loadLanguage(doc) {
  const lang = await languageForFile(doc.name).catch(() => null);
  if (!lang || !docs.has(doc.key)) return;
  doc.language = lang.support;
  doc.languageName = lang.name;
  publishMeta(doc);
  if (doc.large) return;
  const effects = compartments.language.reconfigure(lang.support);
  for (const [k, st] of tabStates) if (k.endsWith(`|${doc.key}`)) tabStates.set(k, st.update({ effects }).state);
  for (const g of editorStore.get().groups) if (g.active === doc.key) views.get(g.id)?.dispatch({ effects });
}

/** Set the language of a document explicitly (status bar picker). */
export async function setDocLanguage(key, lang) {
  const doc = docs.get(key);
  if (!doc) return;
  doc.language = lang.support;
  doc.languageName = lang.name;
  publishMeta(doc);
  const effects = compartments.language.reconfigure(doc.large ? [] : lang.support);
  for (const [k, st] of tabStates) if (k.endsWith(`|${key}`)) tabStates.set(k, st.update({ effects }).state);
  for (const g of editorStore.get().groups) if (g.active === key) views.get(g.id)?.dispatch({ effects });
}

function addTab(groupId, key, preview) {
  updateGroup(groupId, (g) => {
    if (g.tabs.some((t) => t.key === key)) {
      return { ...g, active: key, tabs: preview ? g.tabs : g.tabs.map((t) => (t.key === key ? { ...t, preview: false } : t)) };
    }
    let tabs = g.tabs;
    // A new preview tab replaces the existing (clean) preview tab.
    if (preview) {
      const old = tabs.find((t) => t.preview && !docsStore.get()[t.key]?.dirty);
      if (old) {
        tabs = tabs.filter((t) => t !== old);
        dropTabState(groupId, old.key);
      }
    }
    const i = g.active ? tabs.findIndex((t) => t.key === g.active) + 1 : tabs.length;
    const tab = { key, pinned: false, preview };
    return { ...g, active: key, tabs: [...tabs.slice(0, i), tab, ...tabs.slice(i)] };
  });
  editorStore.set((s) => ({ ...s, activeGroup: groupId }));
  syncTitle();
  markSessionDirty();
}

function dropTabState(groupId, key) {
  tabStates.delete(stateKey(groupId, key));
  scrolls.delete(stateKey(groupId, key));
  if (!editorStore.get().groups.some((g) => g.tabs.some((t) => t.key === key))) {
    docs.delete(key);
    docsStore.set((s) => {
      const { [key]: _gone, ...rest } = s;
      return rest;
    });
  }
}

const OPEN_ERRORS = { binary: 'The file appears to be binary and cannot be opened as text.', too_large: 'The file is too large to open in the editor.' };

/**
 * Open a document in a group.
 * @param {import('../../platform/ipc.js').DocRef} ref
 * @param {{ preview?: boolean, groupId?: number, selection?: { anchor: number, head?: number }, focus?: boolean }} [opts]
 */
export async function openDocument(ref, opts = {}) {
  const key = keyForRef(ref);
  const groupId = opts.groupId ?? editorStore.get().activeGroup;
  const epoch = workspaceStore.get().epoch;
  if (!docs.has(key)) {
    if (!ipc.isTauri()) return null;
    try {
      const opened = await ipc.docRead(ref);
      if (!isCurrentEpoch(epoch)) return null;
      if (!docs.has(key)) createDoc(key, opened, null);
    } catch (e) {
      const code = errorCode(e);
      notify({ severity: code === 'binary' || code === 'too_large' ? 'warning' : 'error', title: 'Could not open the file', message: OPEN_ERRORS[code] ?? errorMessage(e), source: 'editor' });
      return null;
    }
  }
  if (opts.selection) stateFor(groupId, key, opts.selection);
  addTab(groupId, key, Boolean(opts.preview));
  workspaceStore.set((s) => (s.page === 'editor' ? s : { ...s, page: 'editor' }));
  if (opts.focus !== false) requestAnimationFrame?.(() => views.get(groupId)?.focus());
  return key;
}

export function newUntitled(content = '', name) {
  const key = `untitled:${untitledCounter++}`;
  const text = EditorState.create({ doc: content }).doc;
  docs.set(key, {
    key, ref: null, name: name ?? `Untitled-${untitledCounter - 1}`, location: '', encoding: 'utf-8',
    eol: getSetting('files.eol') === 'lf' ? 'lf' : 'crlf', mixedEol: false, hash: null, readonly: false, large: false,
    untitled: true, text, savedText: EditorState.create({ doc: '' }).doc, metaDirty: false, disk: 'ok', saving: false,
    language: [], languageName: 'Plain Text',
  });
  publishMeta(docs.get(key));
  addTab(editorStore.get().activeGroup, key, false);
  workspaceStore.set((st) => ({ ...st, page: 'editor' }));
  return key;
}

/** "Open File…" dialog. */
export async function openFileDialog() {
  try {
    const refs = await ipc.docOpenDialog();
    for (const r of refs ?? []) await openDocument(r);
  } catch (e) {
    notify({ severity: 'error', title: 'Could not open the file', message: errorMessage(e), source: 'editor' });
  }
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export function activateTab(groupId, key) {
  updateGroup(groupId, (g) => ({ ...g, active: key }));
  editorStore.set((s) => ({ ...s, activeGroup: groupId }));
  syncTitle();
  markSessionDirty();
}

export function pinTab(groupId, key, pinned = true) {
  updateGroup(groupId, (g) => {
    const tabs = g.tabs.map((t) => (t.key === key ? { ...t, pinned, preview: false } : t));
    // Pinned tabs first, keeping relative order.
    return { ...g, tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)] };
  });
  markSessionDirty();
}

export function moveTab(groupId, key, toIndex) {
  updateGroup(groupId, (g) => {
    const tabs = g.tabs.filter((t) => t.key !== key);
    const tab = g.tabs.find((t) => t.key === key);
    if (!tab) return g;
    tabs.splice(Math.max(0, Math.min(tabs.length, toIndex)), 0, tab);
    return { ...g, tabs };
  });
  markSessionDirty();
}

const openCount = (key) => editorStore.get().groups.reduce((n, g) => n + (g.tabs.some((t) => t.key === key) ? 1 : 0), 0);

/**
 * Close a tab. If it is the last tab of a dirty document, asks Save / Don't Save / Cancel.
 * @returns {Promise<boolean>} false if the user cancelled
 */
export async function closeTab(groupId, key, { skipPrompt = false } = {}) {
  const doc = docs.get(key);
  if (doc && !skipPrompt && openCount(key) === 1 && isDirty(doc)) {
    const choice = await choiceDialog({
      title: `Save changes to “${doc.name}”?`,
      message: 'Your changes will be lost if you do not save them.',
      choices: [
        { id: 'save', label: 'Save', primary: true },
        { id: 'discard', label: "Don't Save", danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    if (choice === null || choice === 'cancel') return false;
    if (choice === 'save' && !(await saveDocument(key))) return false;
    if (choice === 'discard') ipc.isTauri() && ipc.draftDelete(key).catch(() => {});
  }
  const g = groupById(groupId);
  if (!g) return true;
  const idx = g.tabs.findIndex((t) => t.key === key);
  const tabs = g.tabs.filter((t) => t.key !== key);
  const nextActive = g.active === key ? (tabs[Math.min(idx, tabs.length - 1)]?.key ?? null) : g.active;
  if (doc?.ref) editorStore.set((s) => ({ ...s, closed: [doc.ref, ...s.closed.filter((r) => keyForRef(r) !== key)].slice(0, 20) }));
  updateGroup(groupId, () => ({ ...g, tabs, active: nextActive }));
  dropTabState(groupId, key);
  // An empty group (other than the last one) disappears.
  const s = editorStore.get();
  if (!tabs.length && s.groups.length > 1) {
    const groups = s.groups.filter((x) => x.id !== groupId);
    editorStore.set({ ...s, groups, activeGroup: groups[Math.max(0, s.groups.findIndex((x) => x.id === groupId) - 1)].id });
  }
  if (!editorStore.get().groups.some((x) => x.tabs.length)) workspaceStore.set((st) => (st.page === 'editor' ? { ...st, page: st.current ? 'welcome' : 'launcher' } : st));
  syncTitle();
  markSessionDirty();
  return true;
}

/** Close several tabs; stops at the first cancelled prompt. */
export async function closeTabs(groupId, keys) {
  for (const k of keys) if (!(await closeTab(groupId, k))) return false;
  return true;
}

export async function closeAllEditors() {
  for (const g of [...editorStore.get().groups].reverse()) {
    if (!(await closeTabs(g.id, g.tabs.map((t) => t.key)))) return false;
  }
  return true;
}

export async function reopenClosed() {
  const [ref, ...rest] = editorStore.get().closed;
  if (!ref) return;
  editorStore.set((s) => ({ ...s, closed: rest }));
  await openDocument(ref);
}

// ── Saving ──────────────────────────────────────────────────────────────────

async function saveAs(doc) {
  const content = doc.text.toString();
  let r = await ipc.docSaveAsDialog(doc.untitled ? `${doc.name}.txt` : doc.name, content, doc.encoding, doc.eol);
  if (!r) return false;
  if (r.status === 'confirmOverwrite') {
    const ok = await confirmDialog({ title: 'Replace the existing file?', message: 'Its current contents will be overwritten.', detail: r.path, confirmLabel: 'Replace', danger: true });
    if (!ok) return false;
    r = await ipc.docSaveAsConfirm(r.token, content, doc.encoding, doc.eol);
  }
  // Re-key the document to its new location.
  const newKey = keyForRef(r.ref);
  const oldKey = doc.key;
  ipc.draftDelete(oldKey).catch(() => {});
  if (newKey !== oldKey && docs.has(newKey)) {
    // The target is already open elsewhere: open it fresh and close this one.
    for (const g of editorStore.get().groups) if (g.tabs.some((t) => t.key === oldKey)) await closeTab(g.id, oldKey, { skipPrompt: true });
    await openDocument(r.ref);
    return true;
  }
  docs.delete(oldKey);
  Object.assign(doc, { key: newKey, ref: r.ref, name: r.name, location: r.location, untitled: false, hash: r.result.hash, savedText: doc.text, metaDirty: false, disk: 'ok' });
  docs.set(newKey, doc);
  for (const g of editorStore.get().groups) {
    const st = tabStates.get(stateKey(g.id, oldKey));
    if (st) {
      tabStates.delete(stateKey(g.id, oldKey));
      tabStates.set(stateKey(g.id, newKey), st);
    }
  }
  editorStore.set((s) => ({
    ...s,
    groups: s.groups.map((g) => ({ ...g, active: g.active === oldKey ? newKey : g.active, tabs: g.tabs.map((t) => (t.key === oldKey ? { ...t, key: newKey, preview: false } : t)) })),
  }));
  docsStore.set((s) => {
    const { [oldKey]: _gone, ...rest } = s;
    return rest;
  });
  publishMeta(doc);
  loadLanguage(doc);
  markSessionDirty();
  return true;
}

/**
 * Save a document (Save As for untitled ones). Returns true when saved.
 * @param {string} key
 * @param {{ saveAs?: boolean, overwrite?: boolean }} [opts]
 */
export async function saveDocument(key, opts = {}) {
  const doc = docs.get(key);
  if (!doc || !ipc.isTauri()) return false;
  if (doc.readonly && !opts.saveAs) {
    notify({ severity: 'warning', title: `“${doc.name}” is read-only`, message: 'Use Save As to save a copy.', source: 'editor' });
    return false;
  }
  try {
    if (doc.untitled || opts.saveAs) return await saveAs(doc);
    doc.saving = true;
    const content = doc.text;
    const r = await ipc.docWrite(doc.ref, content.toString(), doc.encoding, doc.eol, opts.overwrite ? null : doc.hash);
    Object.assign(doc, { hash: r.hash, savedText: content, metaDirty: false, disk: 'ok' });
    doc.saving = false;
    publishMeta(doc);
    if (!isDirty(doc)) ipc.draftDelete(key).catch(() => {});
    return true;
  } catch (e) {
    doc.saving = false;
    if (errorCode(e) === 'conflict') return resolveConflict(doc, errorMessage(e));
    notify({ severity: 'error', title: `Could not save “${doc.name}”`, message: errorMessage(e), source: 'editor' });
    return false;
  }
}

async function resolveConflict(doc, message) {
  const choice = await choiceDialog({
    title: `“${doc.name}” changed on disk`,
    message: `${message}. Overwrite the file with your version, or discard your changes and load the version on disk?`,
    choices: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'reload', label: 'Discard Mine and Reload' },
      { id: 'overwrite', label: 'Overwrite', danger: true },
    ],
  });
  if (choice === 'overwrite') return saveDocument(doc.key, { overwrite: true });
  if (choice === 'reload') await reloadFromDisk(doc.key);
  return false;
}

export async function saveAll() {
  for (const doc of [...docs.values()]) if (isDirty(doc) && !doc.untitled) await saveDocument(doc.key);
}

/** Discard unsaved changes (after confirmation) and reload from disk. */
export async function revertDocument(key) {
  const doc = docs.get(key);
  if (!doc || doc.untitled) return;
  if (isDirty(doc) && !(await confirmDialog({ title: `Discard changes to “${doc.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Discard changes', danger: true }))) return;
  await reloadFromDisk(key);
}

export async function reloadFromDisk(key) {
  const doc = docs.get(key);
  if (!doc?.ref) return;
  try {
    const opened = await ipc.docRead(doc.ref);
    replaceContent(doc, opened.content);
    Object.assign(doc, { hash: opened.hash, savedText: doc.text, encoding: opened.encoding, eol: opened.eol, mixedEol: opened.mixedEol, readonly: opened.readonly, metaDirty: false, disk: 'ok' });
    publishMeta(doc);
    ipc.draftDelete(key).catch(() => {});
  } catch (e) {
    notify({ severity: 'error', title: `Could not reload “${doc.name}”`, message: errorMessage(e), source: 'editor' });
  }
}

export function setEncoding(key, encoding) {
  const doc = docs.get(key);
  if (!doc || doc.encoding === encoding) return;
  doc.encoding = encoding;
  doc.metaDirty = true;
  publishMeta(doc);
  scheduleDraft(doc);
}

export function setEol(key, eol) {
  const doc = docs.get(key);
  if (!doc || (doc.eol === eol && !doc.mixedEol)) return;
  doc.eol = eol;
  doc.mixedEol = false;
  doc.metaDirty = true;
  publishMeta(doc);
  scheduleDraft(doc);
}

// ── Auto save & drafts ──────────────────────────────────────────────────────

const autoSaveTimers = new Map();
function scheduleAutoSave(doc) {
  if (getSetting('editor.autoSave') !== 'afterDelay' || doc.untitled || doc.readonly || doc.disk !== 'ok') return;
  clearTimeout(autoSaveTimers.get(doc.key));
  autoSaveTimers.set(doc.key, setTimeout(() => {
    autoSaveTimers.delete(doc.key);
    if (docs.get(doc.key) === doc && isDirty(doc)) saveDocument(doc.key);
  }, Number(getSetting('editor.autoSaveDelay') ?? 1000)));
}

function onBlur(key) {
  const doc = docs.get(key);
  if (doc && getSetting('editor.autoSave') === 'onFocusChange' && !doc.untitled && !doc.readonly && doc.disk === 'ok' && isDirty(doc)) saveDocument(key);
}

const draftTimers = new Map();
function scheduleDraft(doc) {
  if (!ipc.isTauri()) return;
  clearTimeout(draftTimers.get(doc.key));
  draftTimers.set(doc.key, setTimeout(() => writeDraft(doc.key), 1500));
}

async function writeDraft(key) {
  draftTimers.delete(key);
  const doc = docs.get(key);
  if (!doc) return;
  try {
    if (isDirty(doc)) {
      await ipc.draftSave({ key, content: doc.text.toString(), encoding: doc.encoding, eol: doc.eol, baseHash: doc.hash, savedAt: Date.now() });
    } else {
      await ipc.draftDelete(key);
    }
  } catch (e) {
    uiLog('warn', `recovery draft for ${doc.name} not written: ${errorMessage(e)}`);
  }
}

/** Write pending drafts now (before a workspace switch or window close). */
export async function flushDrafts() {
  const keys = [...draftTimers.keys()];
  keys.forEach((k) => clearTimeout(draftTimers.get(k)));
  await Promise.allSettled(keys.map(writeDraft));
}

// ── External changes ────────────────────────────────────────────────────────

/** Watcher event: re-check open documents whose files changed. */
export function onFsChangedEditor(change) {
  const keys = change.rescan ? [...docs.keys()].filter((k) => k.startsWith(`${change.root}:`)) : change.paths.map((p) => `${change.root}:${p}`).filter((k) => docs.has(k));
  keys.forEach((k) => checkDisk(k));
}

async function checkDisk(key) {
  const doc = docs.get(key);
  if (!doc?.ref || doc.saving) return;
  try {
    const opened = await ipc.docRead(doc.ref);
    if (opened.hash === doc.hash) {
      if (doc.disk !== 'ok') {
        doc.disk = 'ok';
        publishMeta(doc);
      }
      return;
    }
    if (!isDirty(doc)) {
      replaceContent(doc, opened.content);
      Object.assign(doc, { hash: opened.hash, savedText: doc.text, encoding: opened.encoding, eol: opened.eol, readonly: opened.readonly, disk: 'ok' });
      publishMeta(doc);
      return;
    }
    if (doc.disk !== 'changed') {
      doc.disk = 'changed';
      publishMeta(doc);
      notify({ severity: 'warning', title: `“${doc.name}” changed on disk`, message: 'You have unsaved changes. Saving will ask whether to overwrite the other version.', source: 'editor' });
    }
  } catch (e) {
    if (errorCode(e) === 'not_found' || errorCode(e) === 'io') {
      doc.disk = 'deleted';
      publishMeta(doc);
    }
  }
}

// ── Session ─────────────────────────────────────────────────────────────────

function resetAll() {
  for (const t of autoSaveTimers.values()) clearTimeout(t);
  autoSaveTimers.clear();
  for (const t of draftTimers.values()) clearTimeout(t);
  draftTimers.clear();
  docs.clear();
  tabStates.clear();
  scrolls.clear();
  docsStore.set({});
  editorStore.set({ groups: [{ id: 1, tabs: [], active: null }], activeGroup: 1, orientation: 'horizontal', closed: [] });
  nextGroupId = 2;
  syncTitle();
}

function saveSession() {
  const s = editorStore.get();
  const sel = (gid, key) => {
    const st = (s.groups.find((g) => g.id === gid)?.active === key && views.get(gid)?.state) || tabStates.get(stateKey(gid, key));
    return st ? { anchor: st.selection.main.anchor, head: st.selection.main.head } : undefined;
  };
  return {
    orientation: s.orientation,
    activeGroup: s.groups.findIndex((g) => g.id === s.activeGroup),
    groups: s.groups.map((g) => ({
      active: g.active,
      tabs: g.tabs
        .map((t) => ({ ...t, ref: docs.get(t.key)?.ref ?? null, untitled: docs.get(t.key)?.untitled ?? false, name: docs.get(t.key)?.name, selection: sel(g.id, t.key) }))
        .filter((t) => t.untitled || (t.ref && !('external' in t.ref))),
    })),
  };
}

async function restoreSession(data, epoch) {
  const drafts = ipc.isTauri() ? await ipc.draftList().catch(() => []) : [];
  if (!isCurrentEpoch(epoch)) return;
  const byKey = new Map(drafts.map((d) => [d.key, d]));
  const used = new Set();
  const groups = Array.isArray(data?.groups) ? data.groups.slice(0, MAX_GROUPS) : [];
  const restored = [];
  for (const g of groups) {
    const id = restored.length === 0 ? 1 : nextGroupId++;
    const tabs = [];
    for (const t of Array.isArray(g?.tabs) ? g.tabs.slice(0, 100) : []) {
      if (t?.untitled) {
        const d = byKey.get(t.key);
        if (!d) continue;
        used.add(t.key);
        const key = `untitled:${untitledCounter++}`;
        const text = EditorState.create({ doc: d.content }).doc;
        docs.set(key, { key, ref: null, name: String(t.name ?? 'Untitled'), location: '', encoding: d.encoding, eol: d.eol, mixedEol: false, hash: null, readonly: false, large: false, untitled: true, text, savedText: EditorState.create({ doc: '' }).doc, metaDirty: false, disk: 'ok', saving: false, language: [], languageName: 'Plain Text' });
        publishMeta(docs.get(key));
        tabs.push({ key, pinned: Boolean(t.pinned), preview: false });
        continue;
      }
      if (!t?.ref || typeof t.ref.root !== 'number' || typeof t.ref.path !== 'string') continue;
      const key = keyForRef(t.ref);
      if (!docs.has(key)) {
        try {
          const opened = await ipc.docRead(t.ref);
          if (!isCurrentEpoch(epoch)) return;
          const d = byKey.get(key);
          if (d) used.add(key);
          createDoc(key, opened, d ?? null);
        } catch {
          continue; // file gone: skip the tab
        }
      }
      if (t.selection) stateFor(id, key, t.selection);
      tabs.push({ key, pinned: Boolean(t.pinned), preview: Boolean(t.preview) });
    }
    if (tabs.length || restored.length === 0) restored.push({ id, tabs, active: tabs.some((x) => x.key === g.active) ? g.active : (tabs[0]?.key ?? null) });
  }
  // Drafts without a tab (e.g. a crash before the session was saved) are recovered too.
  for (const d of drafts) {
    if (used.has(d.key)) continue;
    if (/^\d+:/.test(d.key)) {
      const [root, ...rest] = d.key.split(':');
      const ref = { root: Number(root), path: rest.join(':') };
      try {
        const opened = await ipc.docRead(ref);
        if (!docs.has(d.key)) createDoc(d.key, opened, d);
        restored[0].tabs.push({ key: d.key, pinned: false, preview: false });
        continue;
      } catch {
        /* fall through: recover as untitled */
      }
    }
    const key = `untitled:${untitledCounter++}`;
    docs.set(key, { key, ref: null, name: 'Recovered', location: '', encoding: d.encoding, eol: d.eol, mixedEol: false, hash: null, readonly: false, large: false, untitled: true, text: EditorState.create({ doc: d.content }).doc, savedText: EditorState.create({ doc: '' }).doc, metaDirty: false, disk: 'ok', saving: false, language: [], languageName: 'Plain Text' });
    publishMeta(docs.get(key));
    restored[0].tabs.push({ key, pinned: false, preview: false });
    ipc.draftDelete(d.key).catch(() => {});
    scheduleDraft(docs.get(key));
  }
  if (!isCurrentEpoch(epoch)) return;
  if (!restored[0].active) restored[0].active = restored[0].tabs[0]?.key ?? null;
  const ai = Number.isInteger(data?.activeGroup) ? data.activeGroup : 0;
  editorStore.set({
    groups: restored,
    activeGroup: (restored[ai] ?? restored[0]).id,
    orientation: data?.orientation === 'vertical' ? 'vertical' : 'horizontal',
    closed: [],
  });
  syncTitle();
  if (restored.some((g) => g.tabs.length)) workspaceStore.set((st) => ({ ...st, page: 'editor' }));
  const recovered = drafts.length;
  if (recovered) notify({ title: `Restored ${recovered} unsaved document${recovered > 1 ? 's' : ''}`, message: 'Unsaved changes from the last session were recovered.', source: 'editor' });
}

let registered = false;
export function registerEditorSession() {
  if (registered) return;
  registered = true;
  registerSessionParticipant('editor', {
    save: saveSession,
    restore: (data) => {
      resetAll();
      restoreSession(data ?? null, workspaceStore.get().epoch).catch((e) => uiLog('error', `editor restore failed: ${errorMessage(e)}`));
    },
    reset: resetAll,
  });
  registerFlushHook(flushDrafts);
}

/** True if any open document has unsaved changes. */
export const hasDirty = () => [...docs.values()].some(isDirty);
