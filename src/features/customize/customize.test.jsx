import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ui = new Map();
vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  uiStateGet: vi.fn(async (k) => ui.get(k) ?? null),
  uiStateSet: vi.fn(async (k, v) => void ui.set(k, v)),
  settingsSet: vi.fn(async (_k, v) => v),
  settingsValues: vi.fn(async () => ({ values: {}, invalid: [] })),
  openTextDialog: vi.fn(),
}));

const ipc = await import('../../platform/ipc.js');
const m = await import('./model.js');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { registerBuiltinThemes } = await import('../../theme/index.js');
const { getTheme } = await import('../../theme/engine.js');
const { hasIconPack, resolveIcon } = await import('../../icons/registry.js');
const { settingsStore } = await import('../../core/settings.js');

const theme = { id: 'ocean', name: 'Ocean', appearance: 'dark', style: 'modern', iconPack: 'modern' };
beforeAll(() => registerBuiltinThemes());
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  ui.clear();
});

describe('settings import/export', () => {
  it('exports only user values and shortcuts', () => {
    const out = m.buildSettingsExport({ 'editor.fontSize': { value: 16, source: 'user', userValue: 16 }, 'editor.tabSize': { value: 4, source: 'default' } }, [{ key: 'Ctrl+K', command: 'x.y' }]);
    expect(out).toMatchObject({ $type: 'ivily-center-settings', version: 1, settings: { 'editor.fontSize': 16 }, keybindings: [{ key: 'Ctrl+K', command: 'x.y' }] });
    expect(out.settings).not.toHaveProperty('editor.tabSize');
  });

  it('rejects foreign files and separates unknown keys', () => {
    expect(() => m.analyzeSettingsImport({ settings: {} })).toThrow(/not an Ivily Center settings file/);
    const plan = m.analyzeSettingsImport({ $type: 'ivily-center-settings', version: 1, settings: { 'editor.fontSize': 15, 'nope.x': 1 } }, [{ key: 'editor.fontSize' }]);
    expect(plan.settings).toEqual([['editor.fontSize', 15]]);
    expect(plan.unknown).toEqual(['nope.x']);
    expect(plan.keybindings).toBeNull();
  });

  it('applies nothing until confirmed', async () => {
    settingsStore.set({ loaded: true, schema: [{ key: 'editor.fontSize' }], values: {} });
    ipc.openTextDialog.mockResolvedValueOnce({ name: 's.json', content: JSON.stringify({ $type: 'ivily-center-settings', version: 1, settings: { 'editor.fontSize': 15 } }) });
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = m.importSettings(); });
    expect(screen.getByRole('alertdialog', { name: /Import 1 setting/ })).toBeTruthy();
    expect(ipc.settingsSet).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Import' })));
    await act(async () => { await p; });
    expect(ipc.settingsSet).toHaveBeenCalledWith('editor.fontSize', 15, 'user');
  });
});

describe('user themes and icon packs', () => {
  it('forces user ids and validates themes like built-in ones', () => {
    expect(m.userId('My Theme!')).toBe('user-my-theme');
    expect(m.userId('user-x')).toBe('user-x');
    expect(() => m.prepareTheme({ ...theme, tokens: { 'color.bg': 'url(http://x)' } })).toThrow(/not valid/);
  });

  it('validates icon pack paths and bitmaps', () => {
    const pack = m.validateIconPack({ id: 'Neat', icons: { search: { kind: 'stroke', viewBox: '0 0 24 24', d: 'M3 3h18v18H3z' }, close: { kind: 'bitmap', rows: ['#.', '.#'] } } });
    expect(pack.id).toBe('user-neat');
    expect(() => m.validateIconPack({ id: 'x', icons: { a: { d: 'M0 0"/><script>' } } })).toThrow(/invalid path/);
    expect(() => m.validateIconPack({ id: 'x', icons: { a: { kind: 'bitmap', rows: ['#', '##'] } } })).toThrow(/Malformed/);
  });

  it('imports a theme and an icon pack, persists them and loads them again', async () => {
    const base = getTheme('modern-dark');
    ipc.openTextDialog.mockResolvedValueOnce({ name: 'p.json', content: JSON.stringify({ id: 'neat', name: 'Neat', icons: { search: { d: 'M1 1L2 2' } } }) });
    await act(async () => { expect(await m.importIconPack()).toBe(true); });
    expect(hasIconPack('user-neat')).toBe(true);
    expect(resolveIcon('user-neat', 'close')).toBeTruthy(); // falls back to modern

    ipc.openTextDialog.mockResolvedValueOnce({ name: 't.json', content: JSON.stringify({ ...theme, iconPack: 'user-neat', tokens: base.tokens }) });
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = m.importTheme(); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Not now' })));
    expect(await p).toBe(true);
    expect(getTheme('user-ocean').iconPack).toBe('user-neat');
    expect(ui.get(m.THEME_INDEX)).toEqual(['user-ocean']);
    expect(ui.get(m.PACK_INDEX)).toEqual(['user-neat']);
    await m.loadUserCustomizations();
    expect(getTheme('user-ocean')).toBeTruthy();
  });
});
