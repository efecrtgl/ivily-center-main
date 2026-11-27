import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  notesRead: vi.fn(async () => '# Plan\n\n- [ ] ship'),
  notesWrite: vi.fn(async () => {}),
  sessionSave: vi.fn(async () => {}),
}));

const ipc = await import('../../platform/ipc.js');
const { classifyLink, renderMarkdown, resolveRelative } = await import('./markdown.js');
const bm = await import('../bookmarks/model.js');
const { NotesView } = await import('../notes/NotesView.jsx');
const { workspaceStore } = await import('../../workspace/store.js');

afterEach(cleanup);

describe('markdown', () => {
  it('renders GitHub-flavoured Markdown and strips active content', () => {
    const html = renderMarkdown('# T\n\n| a |\n|---|\n| 1 |\n\n<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><iframe src="https://e"></iframe><p style="color:red">s</p>');
    expect(html).toContain('<h1');
    expect(html).toContain('<table>');
    expect(html).not.toMatch(/script|onerror|javascript:|iframe|style=/i);
  });

  it('classifies and resolves links', () => {
    expect(classifyLink('https://x.dev')).toEqual({ kind: 'external', url: 'https://x.dev' });
    expect(classifyLink('#install')).toEqual({ kind: 'anchor', id: 'install' });
    expect(classifyLink('file:///C:/x')).toEqual({ kind: 'blocked' });
    expect(classifyLink('\\\\server\\share')).toEqual({ kind: 'blocked' });
    expect(classifyLink('../src/a.rs#L12')).toEqual({ kind: 'relative', path: '../src/a.rs', line: 12 });
    expect(resolveRelative('docs/GUIDE.md', '../src/a.rs')).toBe('src/a.rs');
    expect(resolveRelative('README.md', '../outside.txt')).toBeNull();
  });
});

describe('bookmarks', () => {
  it('toggles, follows edits and publishes line numbers', () => {
    bm.bookmarksStore.set({ '0:a.txt': [2] });
    const view = new EditorView({ state: EditorState.create({ doc: ['one', 'two', 'three', 'four'].join('\n'), extensions: bm.bookmarkExtension('0:a.txt') }) });
    view.dispatch({ effects: bm._toggleEffect.of(1) });
    expect(bm.bookmarksStore.get()['0:a.txt']).toEqual([1, 2]);
    view.dispatch({ changes: { from: 0, insert: 'x\n' } });
    expect(bm.bookmarksStore.get()['0:a.txt']).toEqual([2, 3]);
    view.dispatch({ effects: bm._toggleEffect.of(3) });
    expect(bm.bookmarksStore.get()['0:a.txt']).toEqual([2]);
    view.dispatch({ effects: bm._toggleEffect.of(2) });
    expect(bm.bookmarksStore.get()).toEqual({});
    view.destroy();
    expect(bm.bookmarkExtension('untitled:1')).toEqual([]);
    expect(bm.allBookmarks({ '1:b': [3], '0:a': [1, 5] })).toEqual([{ key: '0:a', line: 1 }, { key: '0:a', line: 5 }, { key: '1:b', line: 3 }]);
    expect(bm.parseKey('2:src/x:y.js')).toEqual({ root: 2, path: 'src/x:y.js' });
  });
});

describe('notes', () => {
  it('loads, previews and saves notes for the workspace', async () => {
    vi.useFakeTimers();
    workspaceStore.set({ current: { record: { id: 'ws_0000000000000001' }, folders: [], trust: { level: 'trusted', capabilities: [], folders: [], needsDecision: false } }, epoch: 1, busy: false, page: 'editor', trustPrompt: false });
    await act(async () => { render(<NotesView />); });
    const box = screen.getByRole('textbox', { name: 'Workspace notes' });
    expect(box.value).toContain('# Plan');
    await act(async () => fireEvent.change(box, { target: { value: 'new text' } }));
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(ipc.notesWrite).toHaveBeenCalledWith('new text');
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Preview' })));
    expect(screen.getByText('new text').tagName).toBe('P');
    vi.useRealTimers();
  });
});
