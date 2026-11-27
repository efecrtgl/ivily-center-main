import { describe, expect, it } from 'vitest';
import { bitmapToPath, registerIconPack, resolveIcon } from './registry.js';
import { registerBuiltinIconPacks } from './index.js';
import { MODERN_PACK } from './packs/modern.js';
import { PIXEL_PACK } from './packs/pixel.js';

describe('icon packs', () => {
  registerBuiltinIconPacks();

  it('pixel bitmaps are well-formed 12×12 grids', () => {
    for (const [id, spec] of Object.entries(PIXEL_PACK.icons)) {
      expect(spec.rows, id).toHaveLength(12);
      for (const r of spec.rows) expect(r, id).toMatch(/^[#.]{12}$/);
    }
  });

  it('every pixel icon also exists in the modern pack (fallback coverage)', () => {
    for (const id of Object.keys(PIXEL_PACK.icons)) expect(MODERN_PACK.icons[id], id).toBeTruthy();
  });

  it('falls back to the modern pack for missing icons', () => {
    registerIconPack({ id: 'partial', name: 'Partial', icons: {} });
    expect(resolveIcon('partial', 'close')).toBe(MODERN_PACK.icons.close);
    expect(resolveIcon('pixel', 'close')).toBe(PIXEL_PACK.icons.close);
    expect(resolveIcon('pixel', 'no-such-icon')).toBeNull();
  });

  it('rejects malformed packs', () => {
    expect(() => registerIconPack({ id: 'bad', name: 'Bad', icons: { x: { kind: 'bitmap', rows: ['##', '#'] } } })).toThrow();
    expect(() => registerIconPack({ id: 'Bad Id', name: 'Bad', icons: {} })).toThrow();
  });

  it('turns bitmap runs into compact paths', () => {
    expect(bitmapToPath(['##.#', '....'])).toBe('M0 0h2v1h-2zM3 0h1v1h-1z');
  });
});
