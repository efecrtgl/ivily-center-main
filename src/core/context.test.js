import { describe, expect, it } from 'vitest';
import { compileWhen, evaluateWhen } from './context.js';

describe('when clauses', () => {
  const ctx = { panelVisible: true, activePanel: 'output', count: 3, sidebarVisible: false };
  it.each([
    ['panelVisible', true],
    ['!panelVisible', false],
    ['sidebarVisible || panelVisible', true],
    ['panelVisible && !sidebarVisible', true],
    ["activePanel == 'output'", true],
    ['activePanel == output', true],
    ['activePanel != "output"', false],
    ['count == 3', true],
    ['(sidebarVisible || panelVisible) && activePanel == output', true],
    ['missingKey', false],
    ['!missingKey', true],
    ['true && !false', true],
  ])('%s → %s', (expr, expected) => {
    expect(evaluateWhen(expr, ctx)).toBe(expected);
  });

  it('treats empty clauses as true', () => {
    expect(evaluateWhen(undefined, {})).toBe(true);
    expect(evaluateWhen('', {})).toBe(true);
  });

  it('rejects malformed clauses (and evaluates them as false)', () => {
    for (const bad of ['a &&', '(a', 'a == ', '== a', 'a b', 'a ; b']) {
      expect(() => compileWhen(bad), bad).toThrow();
      expect(evaluateWhen(bad, { a: true, b: true })).toBe(false);
    }
  });
});
