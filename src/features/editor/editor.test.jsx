import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ files: {}, drafts: {} }));

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  onEvent: () => () => {},
  events: {},
  outputAppend: vi.fn(async () => {}),
  docRead: vi.fn(async (ref) => {
    const f = disk.files[`${ref.root}:${ref.path}`];
    if (!f) throw { code: 'not_found', message: 'missing' };
    return { ref, name: ref.path.split('/').pop(), location: `C:\\ws\\${ref.path}`, content: f.content, encoding: 'utf-8', eol: f.eol ?? 'lf', mixedEol: false, hash: f.hash, size: f.content.length, readonly: Boolean(f.readonly), modified: 0 };
  }),
  docWrite: vi.fn(async (ref, content, encoding, eol, expectedHash) => {
    const k = `${ref.root}:${ref.path}`;
    if (expectedHash && disk.files[k].hash !== expectedHash) throw { code: 'conflict', message: 'the file was changed on disk since it was opened' };
    const hash = `h${Math.random()}`;
    disk.files[k] = { content, hash, eol };
    return { hash, size: content.length, modified: 0 };
  }),
  draftSave: vi.fn(async (d) => { disk.drafts[d.key] = d; }),
  draftDelete: vi.fn(async (k) => { delete disk.drafts[k]; }),
  draftList: vi.fn(async () => Object.values(disk.drafts)),
}));

const ipc = await import('../../platform/ipc.js');
const model = await import('./model.js');
const { EditorArea } = await import('./EditorArea.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { workspaceStore } = await import('../../workspace/store.js');
const { restoreSession } = await import('../../workspace/session.js');

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const ref = (path) => ({ root: 0, path });
const viewOf = (gid = model.editorStore.get().activeGroup) => model.getView(gid);
const type = (text, gid) => act(() => { const v = viewOf(gid); v.dispatch({ changes: { from: v.state.doc.length, insert: text } }); });

beforeEach(() => {
  vi.clearAllMocks();
  disk.files = { '0:a.js': { content: 'const a = 1;\n', hash: 'h1' }, '0:b.txt': { content: 'b', hash: 'hb' } };
  disk.drafts = {};
  workspaceStore.set({ current: { record: { id: 'ws_0000000000000001' }, folders: [{ name: 'ws', path: 'C:\\ws', available: true }], trust: {} }, epoch: 5, busy: false, page: 'editor', trustPrompt: false });
  model.registerEditorSession();
  restoreSession({ version: 1, participants: {} });
});
afterEach(cleanup);

describe('editor model', () => {
  it('opens a file, tracks dirty state and saves with the disk hash', async () => {
    render(<EditorArea />);
    await act(() => model.openDocument(ref('a.js')));
    expect(screen.getByRole('tab', { name: /a\.js/ })).toBeTruthy();
    expect(model.docsStore.get()['0:a.js'].dirty).toBe(false);
    await type('// edit\n');
    expect(model.docsStore.get()['0:a.js'].dirty).toBe(true);
    // Undoing back to the saved text is clean again.
    await act(() => { const v = viewOf(); v.dispatch({ changes: { from: v.state.doc.length - 8, to: v.state.doc.length } }); });
    expect(model.docsStore.get()['0:a.js'].dirty).toBe(false);
    await type('x');
    expect(await act(() => model.saveDocument('0:a.js'))).toBe(true);
    expect(ipc.docWrite).toHaveBeenCalledWith(ref('a.js'), 'const a = 1;\nx', 'utf-8', 'lf', 'h1');
    expect(model.docsStore.get()['0:a.js'].dirty).toBe(false);
  });

  it('preview tabs are replaced; editing pins them', async () => {
    render(<EditorArea />);
    await act(() => model.openDocument(ref('a.js'), { preview: true }));
    await act(() => model.openDocument(ref('b.txt'), { preview: true }));
    expect(model.editorStore.get().groups[0].tabs.map((t) => t.key)).toEqual(['0:b.txt']);
    await type('!');
    expect(model.editorStore.get().groups[0].tabs[0].preview).toBe(false);
  });

  it('mirrors edits to another group showing the same document', async () => {
    render(<EditorArea />);
    await act(() => model.openDocument(ref('a.js')));
    await act(() => model.splitEditor('horizontal'));
    const [g1, g2] = model.editorStore.get().groups;
    expect(g2.active).toBe('0:a.js');
    await type('/*2*/', g2.id);
    expect(viewOf(g1.id).state.doc.toString()).toBe('const a = 1;\n/*2*/');
  });

  it('save conflict asks before overwriting; cancel leaves the disk alone', async () => {
    render(<><EditorArea /><ConfirmDialog /></>);
    await act(() => model.openDocument(ref('a.js')));
    await type('mine');
    disk.files['0:a.js'] = { content: 'theirs', hash: 'h2' };
    let saved;
    await act(async () => { saved = model.saveDocument('0:a.js'); });
    expect(screen.getByRole('alertdialog', { name: /changed on disk/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(await saved).toBe(false);
    expect(disk.files['0:a.js'].content).toBe('theirs');
    await act(async () => { saved = model.saveDocument('0:a.js'); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Overwrite' })));
    expect(await saved).toBe(true);
    expect(disk.files['0:a.js'].content).toBe('const a = 1;\nmine');
  });

  it('closing a dirty document asks Save / Don\'t Save / Cancel', async () => {
    render(<><EditorArea /><ConfirmDialog /></>);
    await act(() => model.openDocument(ref('a.js')));
    await type('change');
    const gid = model.editorStore.get().activeGroup;
    let closing;
    await act(async () => { closing = model.closeTab(gid, '0:a.js'); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(await closing).toBe(false);
    expect(model.editorStore.get().groups[0].tabs).toHaveLength(1);
    await act(async () => { closing = model.closeTab(gid, '0:a.js'); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: "Don't Save" })));
    expect(await closing).toBe(true);
    expect(model.editorStore.get().groups[0].tabs).toHaveLength(0);
    expect(disk.files['0:a.js'].content).toBe('const a = 1;\n');
  });

  it('external changes reload clean documents and flag dirty ones', async () => {
    render(<EditorArea />);
    await act(() => model.openDocument(ref('a.js')));
    disk.files['0:a.js'] = { content: 'reloaded', hash: 'h3' };
    model.onFsChangedEditor({ root: 0, paths: ['a.js'], rescan: false, git: false });
    await flush();
    expect(viewOf().state.doc.toString()).toBe('reloaded');
    await type('!');
    disk.files['0:a.js'] = { content: 'again', hash: 'h4' };
    model.onFsChangedEditor({ root: 0, paths: ['a.js'], rescan: false, git: false });
    await flush();
    expect(viewOf().state.doc.toString()).toBe('reloaded!');
    expect(model.docsStore.get()['0:a.js'].disk).toBe('changed');
  });

  it('writes recovery drafts and restores unsaved content with the session', async () => {
    vi.useFakeTimers();
    try {
      render(<EditorArea />);
      await act(() => model.openDocument(ref('a.js')));
      await type('unsaved');
      await act(() => vi.advanceTimersByTimeAsync(1600));
      expect(disk.drafts['0:a.js'].content).toBe('const a = 1;\nunsaved');
    } finally {
      vi.useRealTimers();
    }
    const untitledDraft = { key: 'untitled:9', content: 'scratch', encoding: 'utf-8', eol: 'lf', baseHash: null, savedAt: 1 };
    disk.drafts[untitledDraft.key] = untitledDraft;
    const session = { version: 1, participants: { editor: { orientation: 'horizontal', activeGroup: 0, groups: [{ active: '0:a.js', tabs: [{ key: '0:a.js', ref: ref('a.js'), selection: { anchor: 3 } }, { key: 'untitled:9', untitled: true, name: 'Notes' }] }] } } };
    restoreSession(session);
    await flush();
    await flush();
    const metas = model.docsStore.get();
    expect(metas['0:a.js'].dirty).toBe(true);
    expect(Object.values(metas).some((m) => m.untitled && m.name === 'Notes' && m.dirty)).toBe(true);
  });

  it('changing the line ending or encoding marks the document dirty', async () => {
    render(<EditorArea />);
    await act(() => model.openDocument(ref('b.txt')));
    act(() => model.setEol('0:b.txt', 'crlf'));
    expect(model.docsStore.get()['0:b.txt']).toMatchObject({ eol: 'crlf', dirty: true });
    await act(() => model.saveDocument('0:b.txt'));
    expect(ipc.docWrite).toHaveBeenLastCalledWith(ref('b.txt'), 'b', 'utf-8', 'crlf', 'hb');
  });

  it('refuses to save read-only files in place', async () => {
    disk.files['0:ro.txt'] = { content: 'x', hash: 'hr', readonly: true };
    render(<EditorArea />);
    await act(() => model.openDocument(ref('ro.txt')));
    expect(await act(() => model.saveDocument('0:ro.txt'))).toBe(false);
    expect(ipc.docWrite).not.toHaveBeenCalled();
  });
});
