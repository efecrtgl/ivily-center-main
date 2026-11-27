import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ terms: [], channels: [], writes: [], killed: [], exitHandler: null }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(opts) {
      this.options = opts;
      this.written = [];
      this.selection = '';
      env.terms.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
    onSelectionChange() {}
    onData(fn) { this.dataHandler = fn; }
    onResize(fn) { this.resizeHandler = fn; }
    open() {}
    write(d) { this.written.push(typeof d === 'string' ? d : new TextDecoder().decode(d)); }
    focus() {}
    dispose() { this.disposed = true; }
    hasSelection() { return this.selection.length > 0; }
    getSelection() { return this.selection; }
    clearSelection() { this.selection = ''; }
    clear() {}
    paste() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 120, rows: 30 }; } } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor() { env.channels.push(this); }
  },
}));
vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: (name, h) => { if (name === 'terminal://exit') env.exitHandler = h; return () => {}; },
  uiStateSet: vi.fn(async () => {}),
  terminalProfiles: vi.fn(async () => [{ id: 'pwsh', name: 'PowerShell 7', path: 'C:\\pwsh.exe', args: [] }, { id: 'cmd', name: 'Command Prompt', path: 'C:\\cmd.exe', args: [] }]),
  terminalCreate: vi.fn(async () => 41 + env.channels.length),
  terminalWrite: vi.fn(async (id, d) => { env.writes.push([id, d]); }),
  terminalResize: vi.fn(async () => {}),
  terminalKill: vi.fn(async (id) => { env.killed.push(id); }),
  openExternalUrl: vi.fn(async () => {}),
}));

const ipc = await import('../../platform/ipc.js');
const model = await import('./model.js');
const { registerDefaultKeybindings } = await import('../../core/keybindings.js');
const { registerCommand } = await import('../../core/commands.js');

describe('terminal model', () => {
  beforeEach(() => {
    env.terms.length = 0;
    env.channels.length = 0;
    env.writes.length = 0;
    env.killed.length = 0;
    model.terminalStore.set({ terminals: [], groups: [], activeGroup: null, profiles: [] });
    model.installTerminal();
  });

  it('starts the preferred profile with the fitted size and streams data both ways', async () => {
    const id = await model.createTerminal();
    expect(ipc.terminalCreate).toHaveBeenCalledWith('pwsh', 0, 120, 30, env.channels[0]);
    const term = env.terms[0];
    env.channels[0].onmessage(new TextEncoder().encode('PS C:\\> ').buffer);
    expect(term.written.join('')).toContain('PS C:\\>');
    term.dataHandler('dir\r');
    expect(env.writes).toContainEqual([42, 'dir\r']);
    expect(model.terminalStore.get().terminals.find((t) => t.id === id).status).toBe('running');
  });

  it('marks exited terminals and kills on request', async () => {
    const id = await model.createTerminal({ profileId: 'cmd' });
    env.exitHandler({ id: 42, code: 0 });
    expect(model.terminalStore.get().terminals[0]).toMatchObject({ status: 'exited', exitCode: 0 });
    const id2 = await model.createTerminal();
    model.killTerminal(id2);
    expect(env.killed).toEqual([43]);
    expect(model.terminalStore.get().terminals.map((t) => t.id)).toEqual([id]);
  });

  it('splits into a second pane of the same tab', async () => {
    await model.createTerminal();
    await model.splitTerminal();
    const s = model.terminalStore.get();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].panes).toHaveLength(2);
  });

  it('Ctrl+C copies a selection, otherwise goes to the shell; app shortcuts pass through', async () => {
    registerCommand({ id: 'test.panel', title: 't', category: 't', run() {} });
    registerDefaultKeybindings([{ key: 'Ctrl+`', command: 'test.panel' }]);
    await model.createTerminal();
    const term = env.terms[0];
    const key = (k, code, extra = {}) => term.keyHandler({ type: 'keydown', key: k, code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...extra });
    expect(key('c', 'KeyC')).toBe(true); // no selection: ^C to the shell
    term.selection = 'copied';
    expect(key('c', 'KeyC')).toBe(false);
    expect(term.selection).toBe('');
    expect(key('`', 'Backquote')).toBe(false); // bound to the workbench
    expect(key('b', 'KeyB')).toBe(true); // Ctrl+letter goes to the shell
  });
});
