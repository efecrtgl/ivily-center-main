import { describe, expect, it } from 'vitest';
import { formatEntry } from './output.js';

describe('output', () => {
  it('formats entries with local time and level', () => {
    const ts = new Date(2026, 10, 27, 9, 5, 7, 42).getTime();
    expect(formatEntry({ channel: 'app', seq: 1, ts, level: 'warn', message: 'hi' })).toBe('[09:05:07.042] [warn] hi');
  });
});
