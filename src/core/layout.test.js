import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, LIMITS, sanitizeLayout } from './layout.js';
import { formatTitle } from './title.js';

describe('layout persistence', () => {
  it('falls back to defaults for missing or malformed stored layouts', () => {
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout('nope')).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout({ sidebarVisible: 'yes', panelHeight: 'tall' })).toEqual(DEFAULT_LAYOUT);
  });

  it('clamps sizes and drops unknown keys', () => {
    const l = sanitizeLayout({ sidebarWidth: 99999, panelHeight: 1, extra: true, sidebarVisible: false });
    expect(l.sidebarWidth).toBe(LIMITS.sidebarWidth[1]);
    expect(l.panelHeight).toBe(LIMITS.panelHeight[0]);
    expect(l.sidebarVisible).toBe(false);
    expect(l).not.toHaveProperty('extra');
  });
});

describe('window title', () => {
  it('is context-aware', () => {
    expect(formatTitle({ workspace: null, file: null, dirty: false })).toBe('Ivily Center');
    expect(formatTitle({ workspace: 'shop', file: null, dirty: false })).toBe('shop — Ivily Center');
    expect(formatTitle({ workspace: 'shop', file: 'main.rs', dirty: true })).toBe('● main.rs — shop — Ivily Center');
  });
});
