// Merge conflict markers in the editor: parsing, inline "Accept …" actions, and resolution.
//
//   <<<<<<< HEAD            ← current (ours)
//   ours
//   ||||||| base            ← optional (diff3 / zdiff3)
//   base
//   =======
//   theirs
//   >>>>>>> feature         ← incoming (theirs)
//
// Nothing is resolved automatically: the user chooses per conflict; the file is marked resolved
// (staged) from the Source Control view.
import { StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

/**
 * @typedef {{ from: number, to: number, current: string, incoming: string, base: string | null,
 *             currentLabel: string, incomingLabel: string }} Conflict
 */

/**
 * Find conflict blocks. Positions are offsets in `text`; `to` includes the closing marker line
 * and its line break.
 * @param {string} text
 * @returns {Conflict[]}
 */
export function parseConflicts(text) {
  if (!text.includes('<<<<<<<')) return [];
  const out = [];
  const lines = text.split('\n');
  let offset = 0;
  /** @type {null | { from: number, state: 'current' | 'base' | 'incoming', current: string[], base: string[] | null, incoming: string[], currentLabel: string }} */
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, '');
    const lineLen = raw.length + (i < lines.length - 1 ? 1 : 0);
    if (line.startsWith('<<<<<<<') && !cur) {
      cur = { from: offset, state: 'current', current: [], base: null, incoming: [], currentLabel: line.slice(7).trim() };
    } else if (cur && line.startsWith('|||||||') && cur.state === 'current') {
      cur.state = 'base';
      cur.base = [];
    } else if (cur && line.startsWith('=======') && cur.state !== 'incoming') {
      cur.state = 'incoming';
    } else if (cur && line.startsWith('>>>>>>>') && cur.state === 'incoming') {
      out.push({
        from: cur.from,
        to: offset + lineLen,
        current: cur.current.join(''),
        incoming: cur.incoming.join(''),
        base: cur.base ? cur.base.join('') : null,
        currentLabel: cur.currentLabel || 'Current',
        incomingLabel: line.slice(7).trim() || 'Incoming',
      });
      cur = null;
    } else if (cur) {
      const withBreak = raw + (i < lines.length - 1 ? '\n' : '');
      if (cur.state === 'current') cur.current.push(withBreak);
      else if (cur.state === 'base') cur.base.push(withBreak);
      else cur.incoming.push(withBreak);
    }
    offset += lineLen;
  }
  return out;
}

/** Replacement text for a resolution choice. @param {Conflict} c @param {'current' | 'incoming' | 'both'} choice */
export function resolutionText(c, choice) {
  if (choice === 'current') return c.current;
  if (choice === 'incoming') return c.incoming;
  const sep = c.current && !c.current.endsWith('\n') ? '\n' : '';
  return c.current + sep + c.incoming;
}

/** Resolve one conflict in a view. */
export function resolveConflict(view, c, choice) {
  view.dispatch({ changes: { from: c.from, to: c.to, insert: resolutionText(c, choice) }, userEvent: 'input.resolve' });
}

class ConflictActions extends WidgetType {
  constructor(conflict) {
    super();
    this.conflict = conflict;
  }
  eq(other) {
    return other.conflict.from === this.conflict.from && other.conflict.to === this.conflict.to;
  }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-conflict-actions';
    const add = (label, choice) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onmousedown = (e) => {
        e.preventDefault();
        const live = parseConflicts(view.state.doc.toString()).find((c) => c.from === this.conflict.from);
        if (live) resolveConflict(view, live, choice);
      };
      wrap.append(b);
    };
    add(`Accept Current (${this.conflict.currentLabel})`, 'current');
    add(`Accept Incoming (${this.conflict.incomingLabel})`, 'incoming');
    add('Accept Both', 'both');
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const currentLine = Decoration.line({ class: 'cm-conflict-current' });
const incomingLine = Decoration.line({ class: 'cm-conflict-incoming' });
const markerLine = Decoration.line({ class: 'cm-conflict-marker' });

function build(state) {
  const text = state.doc.toString();
  const conflicts = parseConflicts(text);
  const b = new RangeSetBuilder();
  for (const c of conflicts) {
    const startLine = state.doc.lineAt(c.from);
    b.add(startLine.from, startLine.from, Decoration.widget({ widget: new ConflictActions(c), side: -1, block: true }));
    let pos = c.from;
    let section = 'current';
    while (pos < c.to && pos <= state.doc.length) {
      const line = state.doc.lineAt(pos);
      const t = line.text;
      if (t.startsWith('<<<<<<<') || t.startsWith('>>>>>>>') || t.startsWith('=======') || t.startsWith('|||||||')) {
        b.add(line.from, line.from, markerLine);
        if (t.startsWith('=======')) section = 'incoming';
        if (t.startsWith('|||||||')) section = 'base';
      } else {
        b.add(line.from, line.from, section === 'incoming' ? incomingLine : section === 'current' ? currentLine : markerLine);
      }
      if (line.to >= state.doc.length) break;
      pos = line.to + 1;
    }
  }
  return b.finish();
}

/** Editor extension: highlights conflicts and shows resolution buttons. Cheap when no markers. */
export const conflictExtension = StateField.define({
  create: (state) => build(state),
  update: (deco, tr) => (tr.docChanged ? build(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});
