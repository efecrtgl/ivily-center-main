import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted debug adapter behind the mocked IPC layer.
const handlers = {};
const sent = [];
let seq = 1000;
const emit = (msg) => handlers['dap://message']?.({ id: 1, body: JSON.stringify({ seq: seq++, ...msg }) });
function adapter(text) {
  const m = JSON.parse(text);
  sent.push(m);
  const ok = (body) => queueMicrotask(() => emit({ type: 'response', request_seq: m.seq, success: true, command: m.command, body }));
  switch (m.command) {
    case 'initialize': return ok({ supportsConfigurationDoneRequest: true });
    case 'launch': queueMicrotask(() => emit({ type: 'event', event: 'initialized' })); return ok();
    case 'setBreakpoints': return ok({ breakpoints: m.arguments.breakpoints.map((b) => ({ line: b.line, verified: b.line !== 99 })) });
    case 'configurationDone':
      ok();
      return queueMicrotask(() => emit({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 7 } }));
    case 'threads': return ok({ threads: [{ id: 7, name: 'main' }] });
    case 'stackTrace': return ok({ stackFrames: [{ id: 1, name: 'main', line: 3, column: 1, source: { path: 'C:\\w\\app.py' } }] });
    case 'scopes': return ok({ scopes: [{ name: 'Locals', variablesReference: 11 }] });
    case 'variables': return ok({ variables: [{ name: 'x', value: '42', variablesReference: 0 }] });
    case 'evaluate': return ok({ result: `${m.arguments.expression} = 2` });
    case 'continue':
      ok();
      return queueMicrotask(() => emit({ type: 'event', event: 'terminated' }));
    case 'runInTerminal': return undefined;
    default: return ok();
  }
}

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: (name, fn) => {
    handlers[name] = fn;
    return () => delete handlers[name];
  },
  outputAppend: vi.fn(async () => {}),
  sessionSave: vi.fn(async () => {}),
  dapInfo: vi.fn(async () => ({ configs: [{ id: '0:.ivily/launch.json:Run', name: 'Run', type: 'python', request: 'launch', adapter: 'Python (debugpy)' }], adapters: [], issues: [], canRun: true })),
  dapStart: vi.fn(async (_id, approve) => (approve ? { kind: 'started', id: 1, adapter: 'Python (debugpy)', adapterId: 'debugpy', request: 'launch', config: { program: 'C:\\w\\app.py' } } : { kind: 'needsApproval', adapter: 'Python (debugpy)', config: { program: 'C:\\w\\app.py' } })),
  dapSend: vi.fn(async (_id, text) => adapter(text)),
  dapStop: vi.fn(async () => {}),
}));

const ipc = await import('../../platform/ipc.js');
const { DapClient } = await import('./client.js');
const model = await import('./model.js');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { DebugConsoleView } = await import('./DebugView.jsx');
const { workspaceStore } = await import('../../workspace/store.js');

const tick = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

afterEach(cleanup);
beforeEach(() => {
  sent.length = 0;
  workspaceStore.set({ current: { record: { id: 'ws_0000000000000001' }, folders: [{ name: 'w', path: 'C:\\w' }], trust: { level: 'trusted', capabilities: ['debugging'], folders: [], needsDecision: false } }, epoch: 1, busy: false, page: 'editor', trustPrompt: false });
});

describe('DAP client', () => {
  it('matches responses, reports failures and refuses reverse requests', async () => {
    const out = [];
    const c = new DapClient((t) => out.push(JSON.parse(t)));
    const p = c.request('threads');
    c.receive(JSON.stringify({ type: 'response', request_seq: out[0].seq, success: true, command: 'threads', body: { threads: [] } }));
    await expect(p).resolves.toEqual({ threads: [] });
    const f = c.request('evaluate', { expression: 'x' });
    c.receive(JSON.stringify({ type: 'response', request_seq: out[1].seq, success: false, command: 'evaluate', message: 'not available' }));
    await expect(f).rejects.toThrow('not available');
    c.receive(JSON.stringify({ seq: 5, type: 'request', command: 'runInTerminal', arguments: {} }));
    expect(out[2]).toMatchObject({ type: 'response', request_seq: 5, success: false });
    const pending = c.request('next');
    c.close();
    await expect(pending).rejects.toThrow(/exited/);
  });
});

describe('debug session', () => {
  it('asks for approval, sends breakpoints, stops, shows variables, evaluates and ends', async () => {
    model.debugStore.set((s) => ({ ...s, breakpoints: { '0:app.py': [{ line: 3 }, { line: 99 }] } }));
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = model.startDebugging(); });
    expect(screen.getByRole('alertdialog', { name: /Start “Run”/ })).toBeTruthy();
    expect(ipc.dapStart).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve and start' })));
    await act(async () => { await p; });
    await tick();
    expect(sent.map((m) => m.command)).toEqual(expect.arrayContaining(['initialize', 'launch', 'setBreakpoints', 'configurationDone', 'threads', 'stackTrace', 'scopes', 'variables']));
    const bp = sent.find((m) => m.command === 'setBreakpoints');
    expect(bp.arguments.source.path).toBe('C:\\w\\app.py');
    expect(model.debugStore.get().breakpoints['0:app.py']).toEqual([{ line: 3, verified: true, message: undefined }, { line: 99, verified: false, message: undefined }]);
    const s = model.debugStore.get().session;
    expect(s.state).toBe('stopped');
    expect(s.frames[0].name).toBe('main');
    expect(model.debugStore.get().variables[11][0]).toMatchObject({ name: 'x', value: '42' });

    await act(async () => { await model.evaluate('1+1'); });
    render(<DebugConsoleView />);
    expect(screen.getByText('1+1 = 2')).toBeTruthy();

    await act(async () => { await model.continueExecution(); });
    await tick();
    expect(model.debugStore.get().session.state).toBe('terminated');
    expect(model.debugStore.get().breakpoints['0:app.py']).toEqual([{ line: 3 }, { line: 99 }]);
  });

  it('refuses without the debugging trust capability', async () => {
    ipc.dapInfo.mockResolvedValueOnce({ configs: [], adapters: [], issues: [], canRun: false });
    model.debugStore.set((s) => ({ ...s, session: null }));
    expect(await model.startDebugging()).toBe(false);
  });
});
