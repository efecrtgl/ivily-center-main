import { beforeEach, describe, expect, it } from 'vitest';
import { _resetThemes, applyTheme, listThemes, registerTheme, resolveTokens, themeStore, validateTheme } from './engine.js';
import { registerBuiltinIconPacks } from '../icons/index.js';
import { BUILTIN_THEMES } from './themes/builtin.js';
import { TOKENS, cssVar } from './tokens.js';
import { listStyleLayers } from './layers.js';

const minimal = {
  id: 'test-theme',
  name: 'Test',
  appearance: 'dark',
  style: 'modern',
  iconPack: 'modern',
  tokens: Object.fromEntries(TOKENS.filter((t) => t.required).map((t) => [t.name, '#123456'])),
};

describe('theme engine', () => {
  beforeEach(() => {
    _resetThemes();
    registerBuiltinIconPacks();
  });

  it('every built-in theme is valid and fully resolvable', () => {
    for (const t of BUILTIN_THEMES) {
      expect(validateTheme(t), t.id).toEqual([]);
      const r = resolveTokens(t);
      for (const spec of TOKENS) expect(r[spec.name], `${t.id} ${spec.name}`).toBeTruthy();
    }
  });

  it('ships the six required themes across four structural style layers', () => {
    expect(BUILTIN_THEMES.map((t) => t.id).sort()).toEqual([
      'glass', 'modern-dark', 'modern-light', 'pixel-dark', 'pixel-light', 'retro-terminal',
    ]);
    expect(new Set(BUILTIN_THEMES.map((t) => t.style))).toEqual(new Set(['modern', 'pixel', 'retro', 'glass']));
    expect(listStyleLayers().map((l) => l.id)).toEqual(expect.arrayContaining(['modern', 'pixel', 'retro', 'glass']));
  });

  it('resolution order is theme > style layer > schema fallback', () => {
    const pixel = resolveTokens({ ...minimal, style: 'pixel' });
    expect(pixel['radius.md']).toBe('0px'); // from the pixel layer
    expect(pixel['font.ui']).toMatch(/Pixelify/);
    const overridden = resolveTokens({ ...minimal, style: 'pixel', tokens: { ...minimal.tokens, 'radius.md': '3px' } });
    expect(overridden['radius.md']).toBe('3px');
    const modern = resolveTokens(minimal);
    expect(modern['radius.md']).toBe('6px'); // schema fallback
    expect(modern['color.sidebar.bg']).toBe('#123456'); // ref → color.surface
    expect(modern['terminal.ansi.red']).toBe('#e06c75'); // appearance-specific literal
  });

  it('rejects incomplete, unknown or unsafe themes', () => {
    expect(validateTheme({ ...minimal, tokens: {} }).join()).toMatch(/missing required token/);
    expect(validateTheme({ ...minimal, tokens: { ...minimal.tokens, 'nope.token': '#fff' } }).join()).toMatch(/unknown token/);
    expect(validateTheme({ ...minimal, style: 'nope' }).join()).toMatch(/unknown style layer/);
    expect(validateTheme({ ...minimal, iconPack: 'nope' }).join()).toMatch(/unknown icon pack/);
    for (const evil of ['url(https://x/y.png)', 'red; } body { display:none', '#fff /* x */', 'expression(alert(1))']) {
      expect(validateTheme({ ...minimal, tokens: { ...minimal.tokens, 'color.bg': evil } }).join(), evil).toMatch(/forbidden/);
    }
    expect(() => registerTheme({ ...minimal, id: 'X' })).toThrow();
  });

  it('applies tokens and data attributes without touching other state', () => {
    for (const t of BUILTIN_THEMES) registerTheme(t);
    expect(listThemes()).toHaveLength(6);
    const root = document.createElement('div');
    const unrelated = { workspace: 'kept' };
    applyTheme('pixel-dark', { root });
    expect(root.dataset.style).toBe('pixel');
    expect(root.dataset.iconPack).toBe('pixel');
    expect(root.style.getPropertyValue(cssVar('color.accent'))).toBe('#ffcd75');
    applyTheme('glass', { root });
    expect(root.dataset.style).toBe('glass');
    expect(root.style.getPropertyValue('--radius-lg')).toBe('16px');
    expect(themeStore.get().current.id).toBe('glass');
    expect(unrelated).toEqual({ workspace: 'kept' });
    applyTheme('does-not-exist', { root });
    expect(root.dataset.theme).toBe('modern-dark');
  });
});
