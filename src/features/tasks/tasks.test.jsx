import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMatcher, lineSplitter, normalizePath, stripAnsi, toWorkspaceRef } from './matchers.js';

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  uiStateGet: vi.fn(async () => null),
  uiStateSet: vi.fn(async () => {}),
  tasksList: vi.fn(async () => ({ tasks: [], issues: [], canRun: true })),
  taskRun: vi.fn(async () => 7),
  terminalKill: vi.fn(async () => {}),
}));
vi.mock('../terminal/model.js', () => {
  const listeners = new Set();
  return {
    terminalStore: { get: () => ({ terminals: [] }) },
    onTerminalExited: (fn) => listeners.add(fn),
    createTerminal: vi.fn(async (opts) => {
      const id = Math.floor(Math.random() * 1e6);
      await opts.start({}, 80, 24);
      opts.onStarted(1, id);
      opts.onOutput?.(new TextEncoder().encode('error[E0425]: cannot find value `x`\r\n  --> src\\main.rs:3:5\r\n'));
      queueMicrotask(() => listeners.forEach((fn) => fn({ id, code: globalThis.__exitCode ?? 0 })));
      return id;
    }),
  };
});

const ipc = await import('../../platform/ipc.js');
const model = await import('./model.js');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { workspaceStore } = await import('../../workspace/store.js');

const task = (label, extra = {}) => ({ id: `ivily:0:${label}`, label, source: 'ivily', root: 0, cwd: '', group: null, dependsOn: [], dependsOrder: 'sequence', problemMatchers: [], detail: null, error: null, command: `echo ${label}`, approved: true, ...extra });

describe('problem matchers', () => {
  it('parses rustc, tsc, gcc, eslint and msbuild output', () => {
    const m = createMatcher(['rustc', 'tsc', 'gcc', 'eslint-stylish', 'msCompile']);
    expect(m.push('\x1b[1m\x1b[31merror[E0308]\x1b[0m: mismatched types')).toEqual([]);
    expect(m.push('   --> src/lib.rs:10:7')).toEqual([{ file: 'src/lib.rs', line: 10, col: 7, severity: 'error', code: 'E0308', message: 'mismatched types', source: 'rustc' }]);
    expect(m.push('warning: 2 warnings emitted')).toEqual([]);
    expect(m.push('src/a.ts(4,2): error TS2322: Type mismatch')[0]).toMatchObject({ file: 'src/a.ts', line: 4, col: 2, code: 'TS2322' });
    expect(m.push('main.c:1:2: warning: unused')[0]).toMatchObject({ file: 'main.c', severity: 'warning' });
    expect(m.push('C:\\p\\a.cs(12,5): error CS1002: ; expected [C:\\p\\a.csproj]')[0]).toMatchObject({ line: 12, code: 'CS1002' });
    const s = createMatcher(['eslint-stylish']);
    s.push('C:\\w\\src\\a.js');
    expect(s.push('  3:10  error  Unexpected var  no-var')[0]).toMatchObject({ file: 'C:\\w\\src\\a.js', line: 3, col: 10, code: 'no-var' });
    expect(stripAnsi('\x1b]0;title\x07ok')).toBe('ok');
  });

  it('maps files to workspace references and splits chunked output', () => {
    expect(normalizePath('C:\\w\\sub\\..\\src\\.\\a.rs')).toBe('C:\\w\\src\\a.rs');
    const folders = [{ path: 'C:\\W' }];
    expect(toWorkspaceRef('src/a.rs', 'C:\\w\\crate', folders)).toEqual({ root: 0, path: 'crate/src/a.rs' });
    expect(toWorkspaceRef('D:\\x.rs', 'C:\\w', folders)).toBeNull();
    const lines = [];
    const sp = lineSplitter((l) => lines.push(l));
    sp.write(new TextEncoder().encode('ab'));
    sp.write(new TextEncoder().encode('c\r\nx\rde\nf'));
    sp.end();
    expect(lines).toEqual(['abc', 'de', 'f']);
  });
});

describe('running tasks', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.__exitCode = 0;
    workspaceStore.set({ current: { record: { id: 'ws_0000000000000001' }, folders: [{ name: 'w', path: 'C:\\w', available: true }], trust: { level: 'trusted', capabilities: ['taskExecution'], folders: [], needsDecision: false } }, epoch: 1, busy: false, page: 'editor', trustPrompt: false });
    model.installTasks();
  });

  it('plans dependencies first and detects cycles', () => {
    const tasks = [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['c'] }), task('c')];
    expect(model.planTask(tasks, 'ivily:0:a').map((t) => t.label)).toEqual(['c', 'b', 'a']);
    expect(() => model.planTask([task('x', { dependsOn: ['y'] }), task('y', { dependsOn: ['x'] })], 'ivily:0:x')).toThrow(/depend on each other/);
  });

  it('asks before the first run, shows the command and passes the approval', async () => {
    model.tasksStore.set((s) => ({ ...s, canRun: true, tasks: [task('build', { approved: false, problemMatchers: ['rustc'] })], running: {} }));
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.runTask('ivily:0:build'); });
    expect(screen.getByRole('alertdialog', { name: /Run task “build”/ })).toBeTruthy();
    expect(screen.getByText(/echo build/)).toBeTruthy();
    expect(ipc.taskRun).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve and run' })));
    await act(async () => { expect(await p).toBe(true); });
    expect(ipc.taskRun).toHaveBeenCalledWith('ivily:0:build', true, 80, 24, {});
    expect(model.taskProblemsStore.get()['ivily:0:build'][0]).toMatchObject({ ref: { root: 0, path: 'src/main.rs' }, line: 3, code: 'E0425' });
    expect(model.tasksStore.get().history[0]).toMatchObject({ label: 'build', status: 'succeeded', code: 0 });
  });

  it('declining runs nothing; a failing dependency stops the chain', async () => {
    model.tasksStore.set((s) => ({ ...s, canRun: true, tasks: [task('x', { approved: false })], running: {} }));
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.runTask('ivily:0:x'); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(await p).toBe(false);
    expect(ipc.taskRun).not.toHaveBeenCalled();

    globalThis.__exitCode = 2;
    model.tasksStore.set((s) => ({ ...s, tasks: [task('all', { dependsOn: ['dep'] }), task('dep')], running: {} }));
    await act(async () => { expect(await model.runTask('ivily:0:all')).toBe(false); });
    expect(ipc.taskRun).toHaveBeenCalledTimes(1);
    expect(ipc.taskRun).toHaveBeenCalledWith('ivily:0:dep', false, 80, 24, {});
  });

  it('refuses in Restricted Mode without calling the backend', async () => {
    model.tasksStore.set((s) => ({ ...s, canRun: false, tasks: [task('x')] }));
    expect(await model.runTask('ivily:0:x')).toBe(false);
    expect(ipc.taskRun).not.toHaveBeenCalled();
  });
});
