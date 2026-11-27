// Language server manager (frontend half).
//
// One LSPClient per running server. The transport forwards JSON strings to the backend, which
// owns the process. A custom Workspace adapts @codemirror/lsp-client to Ivily's editor model:
// documents are tracked independently of views (tab switches do not close them on the server),
// changes are computed from the document text, and cross-file navigation opens Ivily editor tabs.
import { ChangeSet } from '@codemirror/state';
import { LSPClient, LSPPlugin, Workspace, languageServerExtensions } from '@codemirror/lsp-client';
import DOMPurify from 'dompurify';
import { createStore } from '../../core/store.js';
import { notify } from '../../core/notifications.js';
import { errorCode, errorMessage } from '../../core/errors.js';
import { uiLog } from '../../core/output.js';
import * as ipc from '../../platform/ipc.js';
import { workspaceStore } from '../../workspace/store.js';
import { refToUri, uriToRef } from './uri.js';
import { languageIntelStore } from '../tools/ToolsView.jsx';

/** @typedef {{ id: string, name: string, languages: string[], path: string | null, disabled: boolean, homepage: string, install: string }} ServerInfo */

/** Per-server runtime state for the UI. */
export const lspStore = createStore(/** @type {Record<string, { state: 'starting' | 'running' | 'error' | 'stopped' | 'blocked' | 'missing', message?: string }>} */ ({}));
/** Latest diagnostics per document URI (for the Problems panel). */
export const diagnosticsStore = createStore(/** @type {Record<string, { server: string, diagnostics: any[] }>} */ ({}));

/** Hooks into the editor model (set by `connectEditor`). */
let editorApi = null;

/** @type {ServerInfo[] | null} */
let servers = null;
/** @type {Map<string, { id: number, client: LSPClient, ready: Promise<void> }>} */
const clients = new Map();
const restarts = new Map();

const setServerState = (server, state, message) => lspStore.set((s) => ({ ...s, [server]: { state, message } }));

function publishIntel() {
  const intel = {};
  for (const s of servers ?? []) {
    const st = lspStore.get()[s.id];
    if (!st) continue;
    for (const l of s.languages) if (!intel[l] || st.state === 'running') intel[l] = { server: s.name, state: st.state };
  }
  languageIntelStore.set(intel);
}
lspStore.subscribe(publishIntel);

function lineDiff(prev, next) {
  const a = prev.toString();
  const b = next.toString();
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return ChangeSet.of([{ from: s, to: a.length - e, insert: b.slice(s, b.length - e) }], a.length);
}

class IvilyWorkspace extends Workspace {
  constructor(client) {
    super(client);
    /** @type {{ uri: string, languageId: string, version: number, doc: any, key: string, view: any, getView: () => any }[]} */
    this.files = [];
  }

  syncFiles() {
    const out = [];
    for (const file of this.files) {
      const current = editorApi?.docText(file.key);
      if (!current || current.eq(file.doc)) continue;
      const prevDoc = file.doc;
      out.push({ changes: lineDiff(prevDoc, current), file, prevDoc });
      file.doc = current;
      file.version++;
      for (const v of editorApi.viewsOf(file.key)) LSPPlugin.get(v)?.clear();
    }
    return out;
  }

  openFile(uri, languageId, view) {
    let file = this.getFile(uri);
    if (file) {
      file.view = view;
      if (!file.doc.eq(view.state.doc)) queueMicrotask(() => this.client.sync());
      return;
    }
    const key = editorApi?.keyForUri(uri);
    if (!key) return;
    file = { uri, languageId, version: 0, doc: view.state.doc, key, view, getView() { return this.view; } };
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri, view) {
    const file = this.getFile(uri);
    if (file && file.view === view) file.view = null;
  }

  /** The editor closed the document. */
  closeDocument(uri) {
    const file = this.getFile(uri);
    if (!file) return;
    this.files = this.files.filter((f) => f !== file);
    this.client.didClose(uri);
  }

  async displayFile(uri) {
    const ref = uriToRef(uri, workspaceStore.get().current?.folders ?? []);
    if (!ref || !editorApi) return null;
    const key = await editorApi.open(ref);
    return key ? editorApi.viewsOf(key)[0] ?? null : null;
  }

  async requestFile(uri) {
    const open = this.getFile(uri);
    if (open) return open;
    const ref = uriToRef(uri, workspaceStore.get().current?.folders ?? []);
    if (!ref) return null;
    try {
      const d = await ipc.docRead(ref);
      const { EditorState } = await import('@codemirror/state');
      return { uri, languageId: '', version: 0, doc: EditorState.create({ doc: d.content }).doc, getView: () => null };
    } catch {
      return null;
    }
  }

  async updateFile(uri, update) {
    let view = this.getFile(uri)?.getView();
    if (!view) view = await this.displayFile(uri);
    view?.dispatch(update);
  }
}

export async function loadServers(force = false) {
  if (servers && !force) return servers;
  if (!ipc.isTauri()) return (servers = []);
  servers = await ipc.lspServers().catch(() => []);
  for (const s of servers) if (!s.path && !lspStore.get()[s.id]) setServerState(s.id, 'missing');
  publishIntel();
  return servers;
}

/** The server to use for a language id (first available, enabled one). */
export async function serverFor(languageId) {
  const list = await loadServers();
  const candidates = list.filter((s) => s.languages.includes(languageId) && !s.disabled);
  return candidates.find((s) => s.path) ?? candidates[0] ?? null;
}

function rootUri() {
  const ws = workspaceStore.get().current;
  return ws?.folders[0] ? refToUri({ root: 0, path: '' }, ws.folders) : null;
}

async function ensureClient(server) {
  const existing = clients.get(server.id);
  if (existing) return existing;
  const ws = workspaceStore.get().current;
  if (!ws) return null;
  setServerState(server.id, 'starting');
  let id;
  try {
    id = await ipc.lspStart(server.id);
  } catch (e) {
    const code = errorCode(e);
    setServerState(server.id, code === 'workspace_untrusted' ? 'blocked' : code === 'not_found' ? 'missing' : 'error', errorMessage(e));
    if (code !== 'workspace_untrusted' && code !== 'not_found' && code !== 'lsp_disabled') {
      notify({ severity: 'error', title: `${server.name} could not start`, message: errorMessage(e), source: 'lsp' });
    }
    return null;
  }
  const handlers = new Set();
  const unlisten = ipc.onEvent('lsp://message', (p) => {
    if (p.id === id) handlers.forEach((h) => h(p.body));
  });
  const transport = {
    send: (message) => {
      ipc.lspSend(id, message).catch((e) => uiLog('warn', `lsp send failed (${server.id}): ${errorMessage(e)}`));
    },
    subscribe: (h) => handlers.add(h),
    unsubscribe: (h) => handlers.delete(h),
  };
  const client = new LSPClient({
    rootUri: rootUri(),
    workspace: (c) => new IvilyWorkspace(c),
    extensions: languageServerExtensions(),
    sanitizeHTML: (html) => DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }),
    timeout: 15000,
    notificationHandlers: {
      'textDocument/publishDiagnostics': (_c, params) => {
        diagnosticsStore.set((s) => ({ ...s, [params.uri]: { server: server.id, diagnostics: params.diagnostics ?? [] } }));
        return false; // let the editor extension show them too
      },
      'window/logMessage': (_c, params) => {
        uiLog(params.type === 1 ? 'error' : params.type === 2 ? 'warn' : 'info', `[${server.id}] ${String(params.message).slice(0, 2000)}`);
        return true;
      },
      'window/showMessage': (_c, params) => {
        notify({ severity: params.type === 1 ? 'error' : params.type === 2 ? 'warning' : 'info', title: server.name, message: String(params.message).slice(0, 1000), source: 'lsp' });
        return true;
      },
    },
  }).connect(transport);
  const entry = { id, client, ready: client.initializing.then(() => setServerState(server.id, 'running')), unlisten };
  entry.ready.catch((e) => setServerState(server.id, 'error', errorMessage(e)));
  clients.set(server.id, entry);
  return entry;
}

/** Backend reported that a server process exited. */
export function onServerExit({ id, server, code }) {
  const entry = [...clients.entries()].find(([, c]) => c.id === id);
  if (!entry) return;
  const [serverId, c] = entry;
  c.unlisten?.();
  c.client.disconnect();
  clients.delete(serverId);
  setServerState(serverId, 'stopped', code == null ? 'stopped' : `exit code ${code}`);
  const now = Date.now();
  const recent = (restarts.get(serverId) ?? []).filter((t) => now - t < 3 * 60_000);
  if (recent.length >= 3) {
    setServerState(serverId, 'error', 'crashed repeatedly; restart it from the command palette');
    notify({ severity: 'error', title: `${server} keeps crashing`, message: 'It will not be restarted automatically. See the Language Servers output channel.', source: 'lsp', actions: [{ label: 'Show Output', command: 'workbench.showOutput' }] });
    return;
  }
  restarts.set(serverId, [...recent, now]);
  editorApi?.reattachAll();
}

/**
 * Attach a document to its language server (if any, if trusted, if installed).
 * @param {{ key: string, ref: any, languageId: string | null, large: boolean }} doc
 */
export async function attachDocument(doc) {
  if (!doc.languageId || !doc.ref || 'external' in doc.ref || doc.large) return;
  const ws = workspaceStore.get().current;
  if (!ws || !ws.trust.capabilities.includes('languageServers')) {
    const s = await serverFor(doc.languageId);
    if (s && s.path) setServerState(s.id, 'blocked', 'workspace not trusted for language servers');
    return;
  }
  const server = await serverFor(doc.languageId);
  if (!server || !server.path) return;
  const entry = await ensureClient(server);
  if (!entry) return;
  const uri = refToUri(doc.ref, ws.folders);
  if (!uri) return;
  editorApi?.setLspExtension(doc.key, entry.client.plugin(uri, doc.languageId));
}

export function detachDocument(doc) {
  if (!doc.ref || 'external' in doc.ref) return;
  const uri = refToUri(doc.ref, workspaceStore.get().current?.folders ?? []);
  if (!uri) return;
  for (const { client } of clients.values()) /** @type {any} */ (client.workspace).closeDocument?.(uri);
}

/** Disconnect everything (workspace switch; the backend stops the processes). */
export function resetLsp() {
  for (const c of clients.values()) {
    c.unlisten?.();
    try {
      c.client.disconnect();
    } catch {
      /* already gone */
    }
  }
  clients.clear();
  restarts.clear();
  servers = null;
  diagnosticsStore.set({});
  lspStore.set({});
}

export async function restartServers() {
  for (const [, c] of clients) await ipc.lspStop(c.id).catch(() => {});
  resetLsp();
  await loadServers(true);
  editorApi?.reattachAll();
}

/** Wire the manager to the editor model (avoids an import cycle). */
export function connectEditor(api) {
  editorApi = api;
}
