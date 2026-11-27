import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCommands, registerCommand } from './commands.js';
import { setContext } from './context.js';
import {
  chordFromEvent, effectiveKeybindings, findConflicts, installKeybindingDispatcher, keybindingFor,
  keybindingStore, normalizeChord, registerDefaultKeybindings, resolveKeybinding, setUserKeybindings,
} from './keybindings.js';

const ev = (code, key, mods = {}) => ({ code, key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

describe('chords', () => {
  it.each([
    ['ctrl+shift+p', 'Ctrl+Shift+P'],
    ['Shift + Ctrl + ,', 'Ctrl+Shift+,'],
    ['alt+F4', 'Alt+F4'],
    ['ctrl+=', 'Ctrl+='],
    ['Ctrl+Plus', 'Ctrl+='],
    ['esc', 'Escape'],
    ['ctrl+up', 'Ctrl+ArrowUp'],
    ['Meta+K', 'Meta+K'],
  ])('%s → %s', (input, expected) => expect(normalizeChord(input)).toBe(expected));

  it.each(['', 'ctrl', 'ctrl+a+b', 'ctrl+nope', 42])('rejects %s', (input) => expect(normalizeChord(input)).toBeNull());

  it('builds chords from physical key codes', () => {
    expect(chordFromEvent(ev('KeyP', 'P', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+P');
    expect(chordFromEvent(ev('Comma', ',', { ctrlKey: true }))).toBe('Ctrl+,');
    // Layout-independent: a Turkish layout reports a different key, the physical code is the same.
    expect(chordFromEvent(ev('KeyI', 'ı', { ctrlKey: true }))).toBe('Ctrl+I');
    expect(chordFromEvent(ev('ShiftLeft', 'Shift', { shiftKey: true }))).toBeNull();
  });
});

describe('keybinding resolution', () => {
  beforeEach(() => {
    _resetCommands();
    keybindingStore.set({ defaults: [], user: [] });
    for (const id of ['view.a', 'view.b', 'view.c']) registerCommand({ id, title: id, category: 'T', run: vi.fn() });
  });

  it('later and user bindings win; when clauses filter', () => {
    registerDefaultKeybindings([
      { key: 'Ctrl+B', command: 'view.a' },
      { key: 'Ctrl+B', command: 'view.b', when: 'panelFocus' },
    ]);
    setContext('panelFocus', false);
    expect(resolveKeybinding('Ctrl+B')?.command).toBe('view.a');
    setContext('panelFocus', true);
    expect(resolveKeybinding('Ctrl+B')?.command).toBe('view.b');
    setUserKeybindings([{ key: 'ctrl+b', command: 'view.c' }]);
    expect(resolveKeybinding('Ctrl+B')?.command).toBe('view.c');
    expect(keybindingFor('view.c')).toBe('Ctrl+B');
  });

  it('user "-command" entries remove defaults; invalid user entries are rejected', () => {
    registerDefaultKeybindings([{ key: 'Ctrl+J', command: 'view.a' }]);
    const { rejected } = setUserKeybindings([
      { key: 'Ctrl+J', command: '-view.a' },
      { key: 'bogus+', command: 'view.b' },
      null,
    ]);
    expect(rejected).toHaveLength(2);
    expect(resolveKeybinding('Ctrl+J')).toBeNull();
    expect(effectiveKeybindings()).toHaveLength(0);
  });

  it('detects conflicts with identical when clauses only', () => {
    registerDefaultKeybindings([
      { key: 'Ctrl+K', command: 'view.a' },
      { key: 'Ctrl+K', command: 'view.b' },
      { key: 'Ctrl+K', command: 'view.c', when: 'x' },
    ]);
    expect(findConflicts()).toEqual([{ key: 'Ctrl+K', when: '', commands: ['view.a', 'view.b'] }]);
  });

  it('dispatcher runs commands but never hijacks plain typing in inputs', () => {
    const run = vi.fn();
    registerCommand({ id: 'test.key', title: 'k', category: 'T', run });
    registerDefaultKeybindings([
      { key: 'Ctrl+K', command: 'test.key' },
      { key: 'K', command: 'test.key' },
    ]);
    const off = installKeybindingDispatcher(window);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', bubbles: true }));
    expect(run).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    off();
    input.remove();
  });
});
