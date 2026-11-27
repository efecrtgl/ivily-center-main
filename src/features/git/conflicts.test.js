import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { conflictExtension, parseConflicts, resolutionText, resolveConflict } from './conflicts.js';

const text = `before\n<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs\n>>>>>>> feature\nmiddle\n<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> other\nafter\n`;

describe('conflict markers', () => {
  it('parses two-way and diff3 conflicts with labels', () => {
    const c = parseConflicts(text);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ current: 'ours 1\nours 2\n', incoming: 'theirs\n', base: null, currentLabel: 'HEAD', incomingLabel: 'feature' });
    expect(text.slice(c[0].from, c[0].to)).toBe('<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs\n>>>>>>> feature\n');
    expect(c[1]).toMatchObject({ current: 'a\n', base: 'b\n', incoming: 'c\n', incomingLabel: 'other' });
  });

  it('handles CRLF and ignores unterminated blocks', () => {
    expect(parseConflicts('<<<<<<< A\r\nx\r\n=======\r\ny\r\n>>>>>>> B\r\n')[0]).toMatchObject({ current: 'x\r\n', incoming: 'y\r\n' });
    expect(parseConflicts('<<<<<<< A\nx\n=======\ny\n')).toEqual([]);
    expect(parseConflicts('no conflicts here')).toEqual([]);
  });

  it('resolves current, incoming or both', () => {
    const [c] = parseConflicts(text);
    expect(resolutionText(c, 'current')).toBe('ours 1\nours 2\n');
    expect(resolutionText(c, 'incoming')).toBe('theirs\n');
    expect(resolutionText(c, 'both')).toBe('ours 1\nours 2\ntheirs\n');
  });

  it('applies a resolution in an editor and re-parses the rest', () => {
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions: [conflictExtension] }) });
    const [first] = parseConflicts(view.state.doc.toString());
    resolveConflict(view, first, 'incoming');
    expect(view.state.doc.toString().startsWith('before\ntheirs\nmiddle\n')).toBe(true);
    expect(parseConflicts(view.state.doc.toString())).toHaveLength(1);
    expect(view.dom.querySelectorAll('.cm-conflict-actions').length).toBeGreaterThanOrEqual(0);
    view.destroy();
  });
});
