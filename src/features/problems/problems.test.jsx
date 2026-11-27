import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: () => () => {},
  outputAppend: vi.fn(async () => {}),
  saveTextDialog: vi.fn(async () => ({ kind: 'confirmOverwrite', token: 't1', path: 'C:\\x.log' })),
  saveTextConfirm: vi.fn(async () => ({ kind: 'saved', path: 'C:\\x.log' })),
}));

const ipc = await import('../../platform/ipc.js');
const model = await import('./model.js');
const { ProblemsView } = await import('./ProblemsView.jsx');
const { ConfirmDialog } = await import('../../shell/ConfirmDialog.jsx');
const { exportText } = await import('../../core/exportText.js');
const { diagnosticsStore } = await import('../lsp/manager.js');
const { taskProblemsStore } = await import('../tasks/model.js');
const { workspaceStore } = await import('../../workspace/store.js');

afterEach(cleanup);
const folders = [{ name: 'w', path: 'C:\\w' }];

describe('problems', () => {
  it('merges LSP diagnostics and task problems, groups and filters them', () => {
    const diags = { 'file:///c%3A/w/src/a.rs': { server: 'rust-analyzer', diagnostics: [{ range: { start: { line: 4, character: 2 } }, severity: 2, message: 'unused variable', code: 'unused' }, { range: { start: { line: 1, character: 0 } }, severity: 1, message: 'mismatched types', source: 'rustc' }] } };
    const tasks = { t: [{ ref: { root: 0, path: 'src/b.ts' }, file: 'src/b.ts', line: 3, col: 1, severity: 'error', message: 'Type error', code: 'TS2322', source: 'tsc' }] };
    const list = model.collectProblems(diags, tasks, folders);
    expect(list).toHaveLength(3);
    expect(model.countProblems(list)).toEqual({ error: 2, warning: 1, info: 0 });
    const groups = model.groupProblems(list, { filter: '', error: true, warning: true, info: true, collapsed: {} });
    expect(groups.map((g) => g.file)).toEqual(['src/a.rs', 'src/b.ts']);
    expect(groups[0].problems.map((p) => p.line)).toEqual([2, 5]); // error before warning
    expect(model.groupProblems(list, { filter: 'ts2322', error: true, warning: true, info: true, collapsed: {} })).toHaveLength(1);
    expect(model.groupProblems(list, { filter: '', error: false, warning: true, info: true, collapsed: {} })[0].problems).toHaveLength(1);
  });

  it('renders the panel with counts', async () => {
    workspaceStore.set({ current: { record: { id: 'ws_0000000000000001' }, folders, trust: { level: 'trusted', capabilities: [], folders: [], needsDecision: false } }, epoch: 1, busy: false, page: 'editor', trustPrompt: false });
    diagnosticsStore.set({});
    taskProblemsStore.set({ t: [{ ref: { root: 0, path: 'src/b.ts' }, file: 'src/b.ts', line: 3, col: 1, severity: 'error', message: 'Type error', source: 'tsc' }] });
    await act(async () => { render(<ProblemsView />); });
    expect(screen.getByText('Type error')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear task problems' })));
    expect(screen.getByText('No problems have been detected in the workspace.')).toBeTruthy();
  });
});

describe('export', () => {
  it('asks before replacing an existing file', async () => {
    render(<ConfirmDialog />);
    let p;
    await act(async () => { p = exportText({ title: 'Save', suggestedName: 'x.log', extension: 'log', content: 'hello' }); });
    expect(screen.getByRole('alertdialog', { name: /Replace the existing file/ })).toBeTruthy();
    expect(ipc.saveTextConfirm).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Replace' })));
    expect(await p).toBe('C:\\x.log');
    expect(ipc.saveTextConfirm).toHaveBeenCalledWith('t1', 'hello');
  });
});
