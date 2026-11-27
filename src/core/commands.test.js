import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCommands, executeCommand, getCommand, listCommands, recentCommands, registerCommand, setCommandErrorHandler,
} from './commands.js';
import { setContext } from './context.js';

describe('command registry', () => {
  beforeEach(() => _resetCommands());

  it('registers, lists and executes commands', async () => {
    const run = vi.fn(() => 42);
    registerCommand({ id: 'test.hello', title: 'Hello', category: 'Test', run });
    expect(getCommand('test.hello')).toMatchObject({ id: 'test.hello', title: 'Hello', source: 'core' });
    expect(getCommand('test.hello')).not.toHaveProperty('run');
    expect(await executeCommand('test.hello', { a: 1 })).toEqual({ ok: true, value: 42 });
    expect(run).toHaveBeenCalledWith({ a: 1 });
    expect(recentCommands.get()[0]).toBe('test.hello');
  });

  it('validates definitions and rejects duplicates', () => {
    expect(() => registerCommand({ id: 'nodot', title: 'x', category: 'x', run() {} })).toThrow();
    expect(() => registerCommand({ id: 'a.b', title: '', category: 'x', run() {} })).toThrow();
    expect(() => registerCommand({ id: 'a.b', title: 'x', category: 'x' })).toThrow();
    registerCommand({ id: 'a.b', title: 'x', category: 'x', run() {} });
    expect(() => registerCommand({ id: 'a.b', title: 'x', category: 'x', run() {} })).toThrow(/already/);
  });

  it('respects when clauses', async () => {
    registerCommand({ id: 'test.ctx', title: 'Ctx', category: 'Test', when: 'testFlag', run: () => 1 });
    setContext('testFlag', false);
    expect(await executeCommand('test.ctx')).toEqual({ ok: false, reason: 'unavailable' });
    expect(listCommands({ availableOnly: true }).map((c) => c.id)).not.toContain('test.ctx');
    setContext('testFlag', true);
    expect((await executeCommand('test.ctx')).ok).toBe(true);
  });

  it('routes failures to the error handler instead of throwing', async () => {
    const handler = vi.fn();
    setCommandErrorHandler(handler);
    registerCommand({
      id: 'test.fail',
      title: 'Fail',
      category: 'Test',
      run: () => {
        throw new Error('boom');
      },
    });
    expect(await executeCommand('test.fail')).toEqual({ ok: false, reason: 'error' });
    expect(handler).toHaveBeenCalledWith(expect.any(Error), 'test.fail');
    expect(await executeCommand('test.unknown')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('disposer unregisters', () => {
    const dispose = registerCommand({ id: 'test.tmp', title: 'Tmp', category: 'Test', run() {} });
    dispose();
    expect(getCommand('test.tmp')).toBeUndefined();
  });
});
