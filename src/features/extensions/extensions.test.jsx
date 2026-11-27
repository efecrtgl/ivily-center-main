import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let enabled = true;
const manifest = {
  id: 'acme.sea',
  name: 'Sea',
  version: '1.0.0',
  publisher: 'Acme',
  description: 'Sea colours',
  contributes: {
    themes: ['themes/sea.json'],
    iconPacks: ['icons/pack.json'],
    snippets: [{ language: 'rust', path: 'snippets/rust.json' }],
    keybindings: [{ key: 'ctrl+alt+r', command: 'test.cmd' }, { key: 'Ctrl+Alt+Q', command: 'nope.cmd' }],
    languages: [{ id: 'markdown', extensions: ['.mdx2'] }],
  },
};

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  extensionsList: vi.fn(async () => ({ installed: [{ manifest, enabled, files: globalThis.__extFiles }], issues: [], recommendations: ['acme.sea', 'other.ext'] })),
  extensionsInstallDialog: vi.fn(async () => ({ token: 't', manifest, files: ['themes/sea.json'], replaces: null })),
  extensionsInstallConfirm: vi.fn(async () => manifest),
  extensionsSetEnabled: vi.fn(async (_id, on) => { enabled = on; }),
  extensionsUninstall: vi.fn(async () => {}),
}));

const ipc = await import('../../platform/ipc.js');
const m = await import('./model.js');
const { ExtensionsView } = await import('./ExtensionsView.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { registerBuiltinThemes } = await import('../../theme/index.js');
const { getTheme } = await import('../../theme/engine.js');
const { hasIconPack } = await import('../../icons/registry.js');
const { effectiveKeybindings } = await import('../../core/keybindings.js');
const { registerCommand } = await import('../../core/commands.js');
const { languageForName } = await import('../../languages/registry.js');
await import('../editor/languages.js');

beforeAll(() => {
  registerBuiltinThemes();
  registerCommand({ id: 'test.cmd', title: 'Test', category: 'Test', run: () => {} });
  globalThis.__extFiles = {
    'themes/sea.json': JSON.stringify({ ...getTheme('modern-dark'), id: 'sea', name: 'Sea', iconPack: 'waves' }),
    'icons/pack.json': JSON.stringify({ id: 'waves', name: 'Waves', icons: { search: { d: 'M1 1L5 5' } } }),
    'snippets/rust.json': JSON.stringify({ 'Function': { prefix: 'fn', body: ['fn ${1:name}($2) {', '\t$0', '}'], description: 'function' } }),
  };
});
afterEach(cleanup);

describe('snippets', () => {
  it('converts VS Code snippet syntax', () => {
    expect(m.toTemplate(['a $1 b', '${2|x,y|} $TM_FILENAME ${TM_LINE:7} $0'])).toBe('a ${1} b\n${2:x}  7 ${0}');
    const s = m.parseSnippets({ A: { prefix: ['p1', 'p2'], body: 'x$0' }, B: { nobody: true } });
    expect(s.map((x) => x.prefix)).toEqual(['p1', 'p2']);
  });
});

describe('extensions', () => {
  it('applies contributions of enabled extensions and removes them when disabled', async () => {
    await act(async () => { await m.loadExtensions(); });
    expect(hasIconPack('user-acme-sea-waves')).toBe(true);
    expect(getTheme('user-acme-sea-sea').iconPack).toBe('user-acme-sea-waves');
    expect(m._snippetsFor('rust')[0]).toMatchObject({ prefix: 'fn', template: 'fn ${1:name}(${2}) {\n\t${0}\n}' });
    expect(effectiveKeybindings().some((b) => b.key === 'Ctrl+Alt+R' && b.command === 'test.cmd')).toBe(true);
    expect(m.extensionsStore.get().problems['acme.sea']).toEqual(["shortcut Ctrl+Alt+Q: unknown command 'nope.cmd'"]);
    expect(languageForName('x.mdx2')?.id).toBe('markdown');

    await act(async () => { await m.setExtensionEnabled('acme.sea', false); });
    expect(getTheme('user-acme-sea-sea')).toBeUndefined();
    expect(hasIconPack('user-acme-sea-waves')).toBe(false);
    expect(m._snippetsFor('rust')).toEqual([]);
    expect(effectiveKeybindings().some((b) => b.command === 'test.cmd')).toBe(false);
    expect(languageForName('x.mdx2')?.id).not.toBe('markdown');
    enabled = true;
  });

  it('shows what will be installed and installs only after confirmation', async () => {
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = m.installExtension(); });
    expect(screen.getByRole('alertdialog', { name: /Install “Sea” 1.0.0/ })).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Alt\+R|ctrl\+alt\+r/)).toBeTruthy();
    expect(ipc.extensionsInstallConfirm).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Install' })));
    expect(await p).toBe(true);
    expect(ipc.extensionsInstallConfirm).toHaveBeenCalledWith('t');
  });

  it('lists installed and recommended extensions', async () => {
    await act(async () => { render(<ExtensionsView />); });
    expect(screen.getByText('Sea')).toBeTruthy();
    expect(screen.getByText(/other\.ext — not installed/)).toBeTruthy();
    expect(screen.queryByText(/acme\.sea — not installed/)).toBeNull();
  });
});
