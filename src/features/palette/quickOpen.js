// Quick Open (Ctrl+P) and the Command Palette (Ctrl+Shift+P / F1) share one picker. The first
// character selects the mode:
//   (none)  files in the workspace (fuzzy, scored by the backend); `name:42` jumps to line 42
//   >       commands
//   @       symbols in the active editor (language server)
//   #       symbols in the workspace (language server)
//   :       go to line[:column] in the active editor
//   ?       help
import { quickPick, filterItems } from '../../core/quickPick.js';
import { executeCommand, listCommands, recentCommands } from '../../core/commands.js';
import { keybindingFor } from '../../core/keybindings.js';
import * as ipc from '../../platform/ipc.js';
import { workspaceStore } from '../../workspace/store.js';
import { activeEditor, allDocs, openDocument, revealInDocument, revealKey } from '../editor/model.js';
import { documentSymbols, SYMBOL_KINDS, workspaceSymbols } from '../lsp/manager.js';

const HIDDEN = new Set(['workbench.quickOpen', 'workbench.commandPalette']);

export const MODES = [
  { prefix: '', label: 'Go to File', description: 'type a file name' },
  { prefix: '>', label: 'Show and Run Commands', description: '>' },
  { prefix: '@', label: 'Go to Symbol in Editor', description: '@' },
  { prefix: '#', label: 'Go to Symbol in Workspace', description: '#' },
  { prefix: ':', label: 'Go to Line', description: ':' },
];

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** `src/a.js:12:4` → `{ text: 'src/a.js', line: 12, col: 4 }` */
export function parseLineSuffix(text) {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?\s*$/.exec(text);
  if (!m || !m[2]) return { text: text.trim(), line: null, col: null };
  return { text: m[1].trim(), line: Number(m[2]), col: m[3] ? Number(m[3]) : null };
}

/** Command items for `>`; recently used commands first when the query is empty. */
export function commandItems(query) {
  const all = listCommands({ availableOnly: true, paletteOnly: true }).filter((c) => !HIDDEN.has(c.id));
  const toItem = (c, group) => ({ id: `cmd:${c.id}`, label: `${c.category}: ${c.title}`, description: c.description, keybinding: keybindingFor(c.id) ?? undefined, group, action: () => executeCommand(c.id) });
  if (!query.trim()) {
    const recent = recentCommands.get().map((id) => all.find((c) => c.id === id)).filter(Boolean);
    const rest = all.filter((c) => !recent.includes(c));
    return [...recent.map((c) => toItem(c, 'recently used')), ...rest.map((c) => toItem(c, recent.length ? 'other commands' : undefined))];
  }
  return filterItems(all.map((c) => toItem(c)), query, true).map((r) => r.item);
}

function lineItems(query) {
  const ed = activeEditor();
  if (!ed?.doc) return [{ id: 'line:none', label: 'Open a file first to go to a line.', action: () => {} }];
  const lines = ed.doc.text.lines;
  const { line, col } = parseLineSuffix(`x:${query.trim()}`);
  if (!line) return [{ id: 'line:hint', label: `Type a line number between 1 and ${lines} (line:column also works).`, action: () => {} }];
  const l = Math.min(lines, Math.max(1, line));
  return [{ id: `line:${l}`, label: `Go to line ${l}${col ? `, column ${col}` : ''}`, description: ed.doc.name, action: () => revealKey(ed.key, l, (col ?? 1) - 1) }];
}

async function editorSymbolItems(query) {
  const ed = activeEditor();
  if (!ed?.doc) return [{ id: 'sym:none', label: 'Open a file first.', action: () => {} }];
  const syms = await documentSymbols(ed.doc);
  if (!syms.length) return [{ id: 'sym:empty', label: 'No symbols (a running language server is needed).', action: () => {} }];
  const items = syms.map((s, i) => ({ id: `sym:${i}`, label: `${'  '.repeat(Math.min(s.depth, 6))}${s.name}`, description: `${SYMBOL_KINDS[s.kind] ?? ''}${s.detail ? ` · ${s.detail}` : ''}`, action: () => revealKey(ed.key, s.line, s.character) }));
  return query.trim() ? filterItems(items.map((it) => ({ ...it, label: it.label.trim() })), query).map((r) => r.item) : items;
}

async function workspaceSymbolItems(query) {
  if (!query.trim()) return [{ id: 'ws:hint', label: 'Type to search symbols in the workspace (needs a running language server).', action: () => {} }];
  const syms = (await workspaceSymbols(query.trim())).filter((s) => s.ref);
  if (!syms.length) return [{ id: 'ws:empty', label: 'No matching symbols.', action: () => {} }];
  return syms.slice(0, 200).map((s, i) => ({
    id: `ws:${i}`,
    label: s.name,
    description: `${SYMBOL_KINDS[s.kind] ?? ''}${s.containerName ? ` · ${s.containerName}` : ''} — ${s.ref.path}`,
    action: () => revealInDocument(s.ref, s.line, s.character),
  }));
}

async function fileItems(query) {
  const ws = workspaceStore.get().current;
  const { text, line, col } = parseLineSuffix(query);
  const go = (ref) => (line ? revealInDocument(ref, line, (col ?? 1) - 1) : openDocument(ref));
  if (!ws || !ipc.isTauri()) {
    // No workspace: offer the open documents.
    return filterItems(allDocs().filter((d) => d.ref).map((d) => ({ id: `doc:${d.key}`, label: d.name, description: d.location, action: () => go(d.ref) })), text).map((r) => r.item);
  }
  const multi = ws.folders.length > 1;
  const found = await ipc.quickOpen(text, 60);
  return found.map((f) => ({
    id: `f:${f.root}:${f.path}`,
    label: baseName(f.path),
    description: `${multi ? `${ws.folders[f.root]?.name ?? ''} · ` : ''}${dirName(f.path)}`,
    action: () => go({ root: f.root, path: f.path }),
  }));
}

function helpItems() {
  return MODES.map((m) => ({ id: `help:${m.prefix || 'file'}`, label: m.label, description: m.description, action: () => openQuickOpen(m.prefix) }));
}

/** Items for the current input (exported for tests). */
export async function provideItems(input) {
  const head = input.charAt(0);
  const rest = input.slice(1);
  if (head === '>') return commandItems(rest);
  if (head === ':') return lineItems(rest);
  if (head === '@') return editorSymbolItems(rest);
  if (head === '#') return workspaceSymbolItems(rest);
  if (head === '?') return helpItems();
  try {
    return await fileItems(input);
  } catch {
    return [];
  }
}

/** Open the picker, optionally with a mode prefix pre-filled. */
export async function openQuickOpen(prefix = '') {
  const item = await quickPick({
    placeholder: prefix === '>' ? 'Type a command' : 'Search files by name (? for help, > commands, @ symbols, : line)',
    value: prefix,
    items: provideItems,
  });
  /** @type {any} */ (item)?.action?.();
}

export const openCommandPalette = () => openQuickOpen('>');
