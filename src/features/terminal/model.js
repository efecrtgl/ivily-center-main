// Terminal model: xterm.js instances (kept outside React), tabs and splits.
//
// Each tab is a *group* of one or two side-by-side panes; each pane is one terminal. Output
// arrives as raw bytes over an IPC channel; input, resize and kill go to the backend, which owns
// the ConPTY session and its Job Object. Terminals belong to the workspace: switching workspaces
// closes them (they are never restarted automatically — starting a shell is always a user action).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Channel } from '@tauri-apps/api/core';
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorMessage } from '../../core/errors.js';
import { getSetting } from '../../core/settings.js';
import { quickPick } from '../../core/quickPick.js';
import { resolveKeybinding, chordFromEvent } from '../../core/keybindings.js';
import { showPanelView } from '../../core/layout.js';
import * as ipc from '../../platform/ipc.js';
import { token, themeStore } from '../../theme/engine.js';
import { registerSessionParticipant } from '../../workspace/session.js';

/** @typedef {{ id: number, backendId: number | null, title: string, profile: string, status: 'starting' | 'running' | 'exited', exitCode: number | null }} TermInfo */
/** @typedef {{ id: number, panes: number[], active: number }} TermGroup */

export const terminalStore = createStore({
  /** @type {TermInfo[]} */
  terminals: [],
  /** @type {TermGroup[]} */
  groups: [],
  activeGroup: /** @type {number | null} */ (null),
  /** @type {{ id: string, name: string }[]} */
  profiles: [],
});

/** @type {Map<number, { term: Terminal, fit: FitAddon, search: SearchAddon, host: HTMLDivElement }>} */
const instances = new Map();
let nextId = 1;

export const getInstance = (id) => instances.get(id);

function terminalTheme() {
  const t = (n, fb) => token(n) ?? fb;
  const ansi = (n) => t(`terminal.ansi.${n}`);
  return {
    background: t('terminal.bg', '#101114'),
    foreground: t('terminal.fg', '#e6e8ee'),
    cursor: t('terminal.cursor', '#ffffff'),
    cursorAccent: t('terminal.bg', '#101114'),
    selectionBackground: t('terminal.selection', '#264f78'),
    black: ansi('black'), red: ansi('red'), green: ansi('green'), yellow: ansi('yellow'), blue: ansi('blue'), magenta: ansi('magenta'), cyan: ansi('cyan'), white: ansi('white'),
    brightBlack: ansi('brightBlack'), brightRed: ansi('brightRed'), brightGreen: ansi('brightGreen'), brightYellow: ansi('brightYellow'),
    brightBlue: ansi('brightBlue'), brightMagenta: ansi('brightMagenta'), brightCyan: ansi('brightCyan'), brightWhite: ansi('brightWhite'),
  };
}

function fontFamily() {
  const custom = String(getSetting('terminal.fontFamily') ?? '').trim();
  if (custom && !/[;{}<>]/.test(custom)) return custom;
  return token('font.mono') ?? "'Cascadia Mono', Consolas, monospace";
}

/** Re-apply theme and font settings to every terminal. */
export function applyTerminalOptions() {
  for (const { term, fit } of instances.values()) {
    term.options.theme = terminalTheme();
    term.options.fontFamily = fontFamily();
    term.options.fontSize = Number(getSetting('terminal.fontSize') ?? 13);
    term.options.cursorStyle = /** @type {any} */ (getSetting('terminal.cursorStyle') ?? 'block');
    try {
      fit.fit();
    } catch {
      /* not visible */
    }
  }
}
themeStore.subscribe(applyTerminalOptions);

const update = (id, patch) => terminalStore.set((s) => ({ ...s, terminals: s.terminals.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

export async function loadProfiles(refresh = false) {
  if (!ipc.isTauri()) return [];
  try {
    const profiles = await ipc.terminalProfiles(refresh);
    terminalStore.set((s) => ({ ...s, profiles }));
    return profiles;
  } catch (e) {
    notify({ severity: 'error', title: 'Could not list terminal profiles', message: errorMessage(e), source: 'terminal' });
    return [];
  }
}

async function defaultProfile() {
  const profiles = terminalStore.get().profiles.length ? terminalStore.get().profiles : await loadProfiles();
  const want = String(getSetting('terminal.defaultProfile') ?? '');
  return profiles.find((p) => p.id === want) ?? profiles.find((p) => p.id === 'pwsh') ?? profiles.find((p) => p.id === 'powershell') ?? profiles[0] ?? null;
}

function createXterm(id) {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: /** @type {any} */ (getSetting('terminal.cursorStyle') ?? 'block'),
    fontFamily: fontFamily(),
    fontSize: Number(getSetting('terminal.fontSize') ?? 13),
    scrollback: Number(getSetting('terminal.scrollback') ?? 5000),
    theme: terminalTheme(),
    windowsPty: { backend: 'conpty' },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => ipc.openExternalUrl(uri).catch(() => {})));
  // Windows Terminal style clipboard; app shortcuts (Ctrl+`, Ctrl+B, …) pass through to the workbench.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'c' && (e.shiftKey || term.hasSelection())) {
      navigator.clipboard?.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (ctrl && key === 'v') {
      navigator.clipboard?.readText().then((text) => text && term.paste(text));
      return false;
    }
    if (ctrl && e.shiftKey && key === 'f') return false;
    const chord = chordFromEvent(e);
    if (chord && (e.ctrlKey || e.altKey) && !/^Ctrl\+[A-Z]$/.test(chord) && resolveKeybinding(chord)) return false;
    return true;
  });
  term.onSelectionChange(() => {
    if (getSetting('terminal.copyOnSelect') === true && term.hasSelection()) navigator.clipboard?.writeText(term.getSelection());
  });
  const host = document.createElement('div');
  host.className = 'terminal-host';
  term.open(host);
  instances.set(id, { term, fit, search, host });
  return { term, fit };
}

/**
 * Start a terminal (explicit user action).
 * @param {{ profileId?: string, groupId?: number, root?: number }} [opts]
 */
export async function createTerminal(opts = {}) {
  if (!ipc.isTauri()) return null;
  const profile = opts.profileId ? terminalStore.get().profiles.find((p) => p.id === opts.profileId) ?? (await loadProfiles()).find((p) => p.id === opts.profileId) : await defaultProfile();
  if (!profile) {
    notify({ severity: 'error', title: 'No terminal profile available', source: 'terminal' });
    return null;
  }
  const id = nextId++;
  const { term, fit } = createXterm(id);
  terminalStore.set((s) => {
    const terminals = [...s.terminals, { id, backendId: null, title: profile.name, profile: profile.id, status: 'starting', exitCode: null }];
    if (opts.groupId != null && s.groups.some((g) => g.id === opts.groupId)) {
      return { ...s, terminals, groups: s.groups.map((g) => (g.id === opts.groupId ? { ...g, panes: [...g.panes, id], active: id } : g)) };
    }
    return { ...s, terminals, groups: [...s.groups, { id, panes: [id], active: id }], activeGroup: id };
  });
  showPanelView('terminal');
  const channel = new Channel();
  channel.onmessage = (data) => term.write(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  try {
    const dims = fit.proposeDimensions() ?? { cols: 100, rows: 30 };
    const backendId = await ipc.terminalCreate(profile.id, opts.root ?? 0, Math.max(2, dims.cols || 100), Math.max(2, dims.rows || 30), channel);
    update(id, { backendId, status: 'running' });
    term.onData((d) => ipc.terminalWrite(backendId, d).catch(() => {}));
    let resizeTimer = null;
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => ipc.terminalResize(backendId, cols, rows).catch(() => {}), 40);
    });
    term.focus();
  } catch (e) {
    update(id, { status: 'exited' });
    term.write(`\r\n\x1b[31mCould not start ${profile.name}: ${errorMessage(e)}\x1b[0m\r\n`);
  }
  return id;
}

/** Backend: a shell exited. */
export function onTerminalExit({ id: backendId, code }) {
  const t = terminalStore.get().terminals.find((x) => x.backendId === backendId);
  if (!t) return;
  update(t.id, { status: 'exited', exitCode: code ?? null });
  instances.get(t.id)?.term.write(`\r\n\x1b[2m[process exited${code != null ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
}

export function killTerminal(id) {
  const t = terminalStore.get().terminals.find((x) => x.id === id);
  if (t?.backendId != null && t.status !== 'exited') ipc.terminalKill(t.backendId).catch(() => {});
  instances.get(id)?.term.dispose();
  instances.delete(id);
  terminalStore.set((s) => {
    const groups = s.groups.map((g) => ({ ...g, panes: g.panes.filter((p) => p !== id), active: g.active === id ? g.panes.find((p) => p !== id) : g.active })).filter((g) => g.panes.length);
    const activeGroup = groups.some((g) => g.id === s.activeGroup) ? s.activeGroup : (groups.at(-1)?.id ?? null);
    return { ...s, terminals: s.terminals.filter((x) => x.id !== id), groups, activeGroup };
  });
}

export function activeTerminalId() {
  const s = terminalStore.get();
  return s.groups.find((g) => g.id === s.activeGroup)?.active ?? null;
}

export function focusTerminal(id) {
  terminalStore.set((s) => {
    const g = s.groups.find((x) => x.panes.includes(id));
    return g ? { ...s, activeGroup: g.id, groups: s.groups.map((x) => (x === g ? { ...x, active: id } : x)) } : s;
  });
  instances.get(id)?.term.focus();
}

/** Split the active tab with a new terminal (max two panes per tab). */
export async function splitTerminal() {
  const s = terminalStore.get();
  const g = s.groups.find((x) => x.id === s.activeGroup);
  if (!g) return createTerminal();
  if (g.panes.length >= 2) return createTerminal();
  const t = s.terminals.find((x) => x.id === g.active);
  return createTerminal({ profileId: t?.profile, groupId: g.id });
}

export async function newTerminalWithProfile() {
  const profiles = await loadProfiles();
  const item = await quickPick({ placeholder: 'Select a terminal profile', items: profiles.map((p) => ({ id: p.id, label: p.name, description: p.path })) });
  if (item) return createTerminal({ profileId: item.id });
  return null;
}

export function renameTerminal(id, title) {
  const t = title.trim().slice(0, 60);
  if (t) update(id, { title: t });
}

export function clearTerminal(id = activeTerminalId()) {
  if (id != null) instances.get(id)?.term.clear();
}

/** Run a command in a new visible terminal after the user confirmed it (e.g. installing a tool). */
export async function runInNewTerminal(commandLine, profileId) {
  const id = await createTerminal({ profileId });
  const t = terminalStore.get().terminals.find((x) => x.id === id);
  if (t?.backendId != null) await ipc.terminalWrite(t.backendId, `${commandLine}\r`);
  return id;
}

function disposeAll() {
  for (const { term } of instances.values()) term.dispose();
  instances.clear();
  terminalStore.set((s) => ({ ...s, terminals: [], groups: [], activeGroup: null }));
}

let installed = false;
export function installTerminal() {
  if (installed) return;
  installed = true;
  ipc.onEvent('terminal://exit', onTerminalExit);
  // Terminals belong to a workspace; the backend kills them on switch, the UI forgets them.
  registerSessionParticipant('terminal', { save: () => undefined, restore: () => {}, reset: disposeAll });
}
