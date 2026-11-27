import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ handlers: {}, sent: [], files: {}, trusted: true }));

vi.mock('../../platform/ipc.js', () => ({
  isTauri: () => true,
  events: {},
  onEvent: (name, h) => {
    (env.handlers[name] ??= new Set()).add(h);
    return () => env.handlers[name].delete(h);
  },
  outputAppend: vi.fn(async () => {}),
  docRead: vi.fn(async (ref) => ({ ref, name: ref.path.split('/').pop(), location: `C:\\ws\\${ref.path}`, content: env.files[ref.path], encoding: 'utf-8', eol: 'lf', mixedEol: false, hash: 'h', size: 10, readonly: false, modified: 0 })),
  draftSave: vi.fn(async () => {}),
  draftDelete: vi.fn(async () => {}),
  draftList: vi.fn(async () => []),
  lspServers: vi.fn(async () => [{ id: 'rust-analyzer', name: 'rust-analyzer', languages: ['rust'], path: 'C:\\ra.exe', disabled: false, homepage: '', install: '' }]),
  lspStart: vi.fn(async () => {
    if (!env.trusted) throw { code: 'workspace_untrusted', message: 'no' };
    return 7;
  }),
  lspSend: vi.fn(async (id, message) => {
    const msg = JSON.parse(message);
    env.sent.push(msg);
    // Scripted server: answer initialize.
    if (msg.method === 'initialize') {
      queueMicrotask(() => env.handlers['lsp://message']?.forEach((h) => h({ id: 7, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 2 } } }) })));
    }
  }),
  lspStop: vi.fn(async () => {}),
}));

const { pathToUri, uriToPath, refToUri, uriToRef } = await import('./uri.js');
const model = await import('../editor/model.js');
const { installLsp } = await import('./integration.js');
const { diagnosticsStore, lspStore } = await import('./manager.js');
const { EditorArea } = await import('../editor/EditorArea.jsx');
const { workspaceStore } = await import('../../workspace/store.js');
const { restoreSession, resetParticipants } = await import('../../workspace/session.js');

const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const folders = [{ name: 'ws', path: 'C:\\Code\\ws', available: true }];
const caps = ['taskExecution', 'processLaunch', 'languageServers', 'extensions', 'debugging', 'workspaceExecutables'];

describe('uri helpers', () => {
  it('round-trips Windows paths and maps to workspace refs', () => {
    const uri = pathToUri('C:\\Code\\ws\\src\\a b.rs');
    expect(uri).toBe('file:///c%3A/Code/ws/src/a%20b.rs');
    expect(uriToPath(uri)).toBe('c:\\Code\\ws\\src\\a b.rs');
    expect(uriToPath('file:///C:/x/y.rs')).toBe('C:\\x\\y.rs');
    expect(refToUri({ root: 0, path: 'src/main.rs' }, folders)).toBe('file:///c%3A/Code/ws/src/main.rs');
    expect(uriToRef('file:///C:/code/WS/src/main.rs', folders)).toEqual({ root: 0, path: 'src/main.rs' });
    expect(uriToRef('file:///D:/other/main.rs', folders)).toBeNull();
  });
});

describe('language server integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.sent = [];
    // > 1024 chars: smaller documents are always sent in full by the client.
    env.files = { 'src/main.rs': `fn main() {}\n${'// filler line\n'.repeat(100)}` };
    resetParticipants();
    installLsp();
    model.registerEditorSession();
  });
  afterEach(cleanup);

  const setWorkspace = (trusted) => {
    env.trusted = trusted;
    workspaceStore.set({
      current: { record: { id: 'ws_0000000000000001', name: 'ws' }, folders, file: null, trust: { level: trusted ? 'trusted' : 'restricted', capabilities: trusted ? caps : [], folders: [], needsDecision: false } },
      epoch: 9, busy: false, page: 'editor', trustPrompt: false,
    });
    restoreSession({ version: 1, participants: {} });
  };

  it('does not start servers in untrusted workspaces', async () => {
    setWorkspace(false);
    render(<EditorArea />);
    await act(() => model.openDocument({ root: 0, path: 'src/main.rs' }));
    await flush(20);
    expect((await import('../../platform/ipc.js')).lspStart).not.toHaveBeenCalled();
    expect(lspStore.get()['rust-analyzer']?.state).toBe('blocked');
  });

  it('initializes, opens, syncs edits incrementally and closes documents', async () => {
    setWorkspace(true);
    render(<EditorArea />);
    await act(() => model.openDocument({ root: 0, path: 'src/main.rs' }));
    await flush(50);
    const methods = env.sent.map((m) => m.method);
    expect(methods).toContain('initialize');
    expect(env.sent.find((m) => m.method === 'initialize').params.rootUri).toBe('file:///c%3A/Code/ws');
    const open = env.sent.find((m) => m.method === 'textDocument/didOpen');
    expect(open.params.textDocument).toMatchObject({ uri: 'file:///c%3A/Code/ws/src/main.rs', languageId: 'rust' });
    expect(open.params.textDocument.text).toBe(env.files['src/main.rs']);
    expect(lspStore.get()['rust-analyzer'].state).toBe('running');

    // Edit, then let the client sync.
    await act(() => {
      const v = model.viewsOf('0:src/main.rs')[0];
      v.dispatch({ changes: { from: 11, insert: ' let x = 1; ' } });
    });
    await flush(600);
    const change = env.sent.find((m) => m.method === 'textDocument/didChange');
    expect(change.params.contentChanges).toEqual([{ range: { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } }, text: ' let x = 1; ' }]);

    // Diagnostics are recorded for the Problems panel.
    act(() => env.handlers['lsp://message'].forEach((h) => h({ id: 7, body: JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: open.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, message: 'unused', severity: 2 }] } }) })));
    expect(diagnosticsStore.get()[open.params.textDocument.uri].diagnostics[0].message).toBe('unused');

    await act(() => model.closeTab(model.editorStore.get().activeGroup, '0:src/main.rs', { skipPrompt: true }));
    expect(env.sent.some((m) => m.method === 'textDocument/didClose')).toBe(true);
  });
});
